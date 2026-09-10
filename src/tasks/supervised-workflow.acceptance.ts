import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import {
  listSupervisedOperations,
  listSupervisedOperationsInTransaction,
} from "./supervised-operation.store.js";
import type { SupervisedOperation } from "./supervised-operation.types.js";
import {
  getSupervisedOperatorAcceptance,
  readSupervisedOperatorAcceptance,
} from "./supervised-operator-acceptance.js";
import type { SupervisedDecision, SupervisedTask } from "./supervised-task.types.js";
import type { SupervisedWorkflowDatabaseOptions as Options } from "./supervised-workflow.persistence.js";
import {
  getSupervisedWorkflowContract,
  readSupervisedWorkflowContractInTransaction,
} from "./supervised-workflow.store.js";
import type { SupervisedWorkflowProfile } from "./supervised-workflow.types.js";
import {
  resolveSupervisedWorkflowWorkspace,
  supervisedWorkspaceVersionPath,
  readSupervisedWorkspaceHeadInTransaction,
  getSupervisedWorkspaceHead,
} from "./supervised-workspace-versions.js";
import { captureSupervisedWorkspace, readSupervisedWorkspaceFile } from "./supervised-workspace.js";

/** Host-only target prepared from a closed attempt's staged immutable candidate.
 * The verifier checks actual bytes; endpoint commit still requires this exact
 * version as the installed head, in the candidate transaction. */
export type SupervisedAcceptanceCandidate = Readonly<{ versionId: string; sourceHash: string }>;

type Completion = Extract<SupervisedDecision, { kind: "succeeded" | "partial" }>;
export type SupervisedAcceptanceProof = Readonly<{ kind: "host-verified-workflow" }>;
type Verification = {
  task: SupervisedTask;
  decision: Completion;
  contractHash: string;
  sourceHash: string;
  operations: SupervisedOperation[];
  evidence: Array<{ criterionId: string; observation: string }>;
  workspaceVersion: string | null;
  approvals: Array<{ criterionId: string; approvalId: string }>;
};
const proofs = new WeakMap<SupervisedAcceptanceProof, Verification>();

function latestProfileOperation(
  operations: SupervisedOperation[],
  profile: string,
  contractHash: string,
) {
  return operations
    .filter(
      (operation) =>
        operation.request.profile === profile && operation.contractHash === contractHash,
    )
    .toSorted((a, b) => b.admissionRevision - a.admissionRevision)[0];
}

/** Only this host verifier can mint a completion proof; model fields cannot. */
export async function verifySupervisedWorkflowAcceptance(
  task: SupervisedTask,
  decision: Completion,
  options: Options = {},
  candidate?: SupervisedAcceptanceCandidate,
): Promise<
  | { kind: "legacy" }
  | { kind: "check"; profile: SupervisedWorkflowProfile; key: string }
  | { kind: "rejected"; reason: string; operatorRequired: boolean }
  | { kind: "verified"; proof: SupervisedAcceptanceProof }
> {
  const encoded = getSupervisedWorkflowContract(task.flowId, task.episode, options);
  if (!encoded) {
    return { kind: "legacy" };
  }
  const resolvedContract = resolveSupervisedWorkflowWorkspace(
    encoded.contract,
    task.flowId,
    task.episode,
    options,
  );
  const contract = candidate
    ? {
        ...resolvedContract,
        workspace: supervisedWorkspaceVersionPath(candidate.versionId, options),
      }
    : resolvedContract;
  const workspaceVersion =
    candidate?.versionId ??
    getSupervisedWorkspaceHead(task.flowId, task.episode, options)?.version_id ??
    null;
  const required =
    decision.kind === "partial"
      ? task.goal?.partial
      : task.goal?.success.map((criterion) => criterion.id);
  if (!required?.length) {
    return { kind: "rejected", reason: "No accepted completion criteria", operatorRequired: false };
  }
  const snapshot = await captureSupervisedWorkspace(contract);
  if (candidate && snapshot.hash !== candidate.sourceHash) {
    throw new Error("Staged candidate changed before host acceptance verification");
  }
  const operations = listSupervisedOperations(options, task.flowId, task.episode);
  const retained: SupervisedOperation[] = [];
  const evidence: Verification["evidence"] = [];
  const approvals: Verification["approvals"] = [];
  for (const criterionId of required) {
    const rule = contract.acceptance.find((entry) => entry.criterionId === criterionId);
    if (!rule) {
      return {
        kind: "rejected",
        reason: `Missing controller rule for ${criterionId}`,
        operatorRequired: true,
      };
    }
    if (rule.kind === "operator") {
      const approval = getSupervisedOperatorAcceptance(
        { flowId: task.flowId, criterionId, contractHash: encoded.hash, sourceHash: snapshot.hash },
        options,
      );
      if (!approval) {
        return {
          kind: "rejected",
          reason: `Criterion ${criterionId} needs explicit operator acceptance of artifact ${snapshot.hash}`,
          operatorRequired: true,
        };
      }
      approvals.push({ criterionId, approvalId: approval.approval_id });
      evidence.push({
        criterionId,
        observation: `Operator accepted exact artifact ${snapshot.hash}; receipt ${approval.approval_id}`,
      });
      continue;
    }
    if (rule.kind === "receipts") {
      for (const profileId of rule.profiles) {
        const profile = contract.profiles.find((entry) => entry.id === profileId)!;
        // Select the latest admitted check BEFORE inspecting its outcome. An
        // unfinished/failed check must not disappear behind an older success.
        const latest = latestProfileOperation(operations, profileId, encoded.hash);
        if (
          !latest ||
          (latest.outcome?.facts.sourceHash && latest.outcome.facts.sourceHash !== snapshot.hash)
        ) {
          return {
            kind: "check",
            profile,
            key: `accept:${profileId.slice(0, 40)}:${snapshot.hash}`,
          };
        }
        if (
          latest.state !== "succeeded" ||
          latest.outcome?.facts.sourceHash !== snapshot.hash ||
          latest.outcome?.facts.resultHash !== snapshot.hash
        ) {
          return {
            kind: "rejected",
            reason: `Accepted check ${profileId} did not pass on the current source; inspect its receipt and repair the artifact`,
            operatorRequired: false,
          };
        }
        retained.push(latest);
      }
      evidence.push({
        criterionId,
        observation: `Controller verified accepted receipts on source ${snapshot.hash}`,
      });
    } else {
      let bytes: Buffer;
      try {
        bytes = await readSupervisedWorkspaceFile(contract.workspace, rule.path, 1024 * 1024);
      } catch {
        return {
          kind: "rejected",
          reason: `Artifact ${rule.path} is unavailable or exceeds the verifier's regular-file boundary`,
          operatorRequired: false,
        };
      }
      const hash = createHash("sha256").update(bytes).digest("hex");
      if (
        bytes.length > 1024 * 1024 ||
        snapshot.files.find((entry) => entry.path === rule.path)?.sha256 !== hash
      ) {
        return {
          kind: "rejected",
          reason: "Artifact is missing from the frozen source scope or changed during verification",
          operatorRequired: false,
        };
      }
      if (rule.kind === "artifact") {
        if (hash !== rule.sha256) {
          return {
            kind: "rejected",
            reason: `Artifact ${rule.path} does not match its accepted digest`,
            operatorRequired: false,
          };
        }
      } else {
        let value: unknown;
        try {
          value = JSON.parse(bytes.toString("utf8"));
        } catch {
          return {
            kind: "rejected",
            reason: `Artifact ${rule.path} is not valid JSON`,
            operatorRequired: false,
          };
        }
        if (
          !value ||
          typeof value !== "object" ||
          Array.isArray(value) ||
          Object.entries(rule.fields).some(
            ([key, expected]) => !Object.hasOwn(value, key) || Reflect.get(value, key) !== expected,
          )
        ) {
          return {
            kind: "rejected",
            reason: `Artifact ${rule.path} does not satisfy its accepted data checks`,
            operatorRequired: false,
          };
        }
      }
      evidence.push({
        criterionId,
        observation: `Controller verified artifact ${rule.path} at SHA-256 ${hash}`,
      });
    }
  }
  if ((await captureSupervisedWorkspace(contract)).hash !== snapshot.hash) {
    return {
      kind: "rejected",
      reason: "Source changed while acceptance was being verified",
      operatorRequired: false,
    };
  }
  const proof: SupervisedAcceptanceProof = Object.freeze({ kind: "host-verified-workflow" });
  proofs.set(proof, {
    task,
    decision,
    contractHash: encoded.hash,
    sourceHash: snapshot.hash,
    operations: retained,
    evidence,
    workspaceVersion,
    approvals,
  });
  return { kind: "verified", proof };
}

/** Consume the exact proof once inside the same transaction as endpoint settlement. */
export function commitSupervisedAcceptanceInTransaction(
  db: DatabaseSync,
  task: SupervisedTask,
  decision: Completion,
  proof: SupervisedAcceptanceProof,
  now: number,
) {
  const verified = proofs.get(proof);
  if (
    !verified ||
    verified.task.flowId !== task.flowId ||
    verified.task.episode !== task.episode ||
    verified.task.attempt?.id !== task.attempt?.id ||
    verified.task.revision !== task.revision ||
    JSON.stringify(verified.decision) !== JSON.stringify(decision)
  ) {
    throw new Error("Missing, replayed, or mismatched host acceptance proof");
  }
  proofs.delete(proof);
  const contract = readSupervisedWorkflowContractInTransaction(db, task.flowId, task.episode);
  if (!contract || contract.hash !== verified.contractHash) {
    throw new Error("Acceptance contract changed");
  }
  if (
    (readSupervisedWorkspaceHeadInTransaction(db, task.flowId, task.episode)?.version_id ??
      null) !== verified.workspaceVersion
  ) {
    throw new Error("Accepted workspace artifact changed");
  }
  for (const approval of verified.approvals) {
    const current = readSupervisedOperatorAcceptance(db, {
      flowId: task.flowId,
      criterionId: approval.criterionId,
      contractHash: verified.contractHash,
      sourceHash: verified.sourceHash,
    });
    if (current?.approval_id !== approval.approvalId) {
      throw new Error("Operator acceptance receipt changed");
    }
  }
  const currentOperations = listSupervisedOperationsInTransaction(db, task.flowId, task.episode);
  for (const operation of verified.operations) {
    if (
      latestProfileOperation(currentOperations, operation.request.profile, verified.contractHash)
        ?.operationId !== operation.operationId
    ) {
      throw new Error("Acceptance operation was superseded by a newer admitted check");
    }
    const row = executeSqliteQueryTakeFirstSync(
      db,
      getNodeSqliteKysely<DB>(db)
        .selectFrom("task_flow_operations")
        .select("record_json")
        .where("operation_id", "=", operation.operationId),
    );
    if (!row || row.record_json !== JSON.stringify(operation)) {
      throw new Error("Acceptance operation receipt changed");
    }
  }
  executeSqliteQuerySync(
    db,
    getNodeSqliteKysely<DB>(db)
      .insertInto("task_flow_acceptance")
      .values({
        flow_id: task.flowId,
        episode: task.episode,
        attempt_id: task.attempt!.id,
        contract_hash: verified.contractHash,
        source_hash: verified.sourceHash,
        accepted_at_ms: now,
        record_json: JSON.stringify({
          kind: decision.kind,
          evidence: verified.evidence,
          operations: verified.operations.map((operation) => operation.operationId),
          approvals: verified.approvals,
        }),
      }),
  );
  return verified.evidence;
}
