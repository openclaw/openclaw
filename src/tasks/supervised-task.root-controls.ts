import { createHash } from "node:crypto";
import { z } from "zod";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import { ensureSupervisedTaskAdmissionOwner } from "./supervised-task.admission-owner.js";
import { controlSupervisedTask } from "./supervised-task.controls.js";
import {
  getSupervisedTaskSource,
  SupervisedRootHandledSchema,
  type SupervisedRootHandled,
  readSupervisedInputReceipt,
  type SupervisedTaskSource,
} from "./supervised-task.source.js";
import { getSupervisedTask } from "./supervised-task.store.js";
import { getSupervisedTaskView, listSupervisedTaskViewIds } from "./supervised-task.view.js";
import {
  writeSupervisedWorkflow,
  type SupervisedWorkflowDatabaseOptions as Options,
} from "./supervised-workflow.persistence.js";

export const SupervisedRootProposalSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("ordinary") }),
  z.strictObject({ kind: z.literal("task") }),
  z.strictObject({
    kind: z.enum(["status", "cancel", "steer", "resume"]),
    target: z.string().min(1).max(128).optional(),
  }),
]);
type Proposal = z.infer<typeof SupervisedRootProposalSchema>;

export function listSupervisedRootCandidates(source: SupervisedTaskSource, options: Options = {}) {
  const ids = listSupervisedTaskViewIds({ ...source, limit: 8 }, options);
  return {
    more: ids.length > 8,
    tasks: ids.slice(0, 8).flatMap((flowId) => {
      const task = getSupervisedTaskView(flowId, Date.now(), options);
      return task
        ? [
            {
              flowId,
              episode: task.episode,
              revision: task.revision,
              phase: task.phase,
              title: task.title.slice(0, 1024),
              continuation: task.continuation,
            },
          ]
        : [];
    }),
  };
}

/** A model proposes semantics, never authority, revisions, budgets or approval.
 * The host supplies exact accepted source and state, then commits control and
 * ingress receipt together. Replaying a lost response does not classify again. */
export async function handleSupervisedRootControl(params: {
  proposal: Exclude<Proposal, { kind: "ordinary" } | { kind: "task" }>;
  candidates: ReturnType<typeof listSupervisedRootCandidates>;
  source: SupervisedTaskSource;
  message: string;
  sourceKey: string;
  fingerprint: string;
  assertCurrent: () => void;
  options?: Options;
  ensureOwner?: (flowId: string) => Promise<string>;
}): Promise<SupervisedRootHandled> {
  const { proposal, source, candidates } = params;
  const options = params.options ?? {};
  const eligible = candidates.tasks.filter((task) =>
    proposal.kind === "resume"
      ? task.phase === "input_required"
      : proposal.kind === "status" || ["ready", "running", "waiting"].includes(task.phase),
  );
  const selected = proposal.target
    ? candidates.tasks.find((task) => task.flowId === proposal.target)
    : !candidates.more && eligible.length === 1
      ? eligible[0]
      : undefined;
  if (proposal.target && !selected) {
    throw new Error("Task selection was outside the authorized source candidates");
  }
  const supervisorOwnerId =
    selected && proposal.kind === "resume"
      ? await (params.ensureOwner ?? ensureSupervisedTaskAdmissionOwner)(selected.flowId)
      : undefined;
  params.assertCurrent();
  return writeSupervisedWorkflow((db) => {
    params.assertCurrent();
    const prior = readSupervisedInputReceipt(params.sourceKey, options);
    if (prior) {
      if (prior.fingerprint !== params.fingerprint || !prior.record_json) {
        throw new Error("Root control input was reused with changed input");
      }
      return { ...SupervisedRootHandledSchema.parse(JSON.parse(prior.record_json)), replay: true };
    }
    let result: SupervisedRootHandled;
    if (!selected) {
      const choices = eligible
        .map((task) => `${task.flowId}: ${task.title.slice(0, 160)} (${task.phase})`)
        .join("\n");
      result = {
        kind: "handled",
        control: proposal.kind,
        replay: false,
        message: choices
          ? `Select the task to ${proposal.kind}:\n${choices}${candidates.more ? "\nMore tasks are available in Tasks." : ""}`
          : "No matching task is available in this conversation. Open Tasks to inspect other authorized task sources.",
      };
    } else {
      const assertSource = () => {
        params.assertCurrent();
        const bound = getSupervisedTaskSource(selected.flowId, options);
        if (
          !bound ||
          bound.agentId !== source.agentId ||
          bound.sessionKey !== source.sessionKey ||
          bound.sessionId !== source.sessionId ||
          bound.ownerScope !== source.ownerScope
        ) {
          throw new Error("Task source changed during control preparation");
        }
      };
      assertSource();
      if (proposal.kind === "status") {
        const view = getSupervisedTaskView(selected.flowId, Date.now(), options);
        if (!view) {
          throw new Error("Task no longer exists");
        }
        result = {
          kind: "handled",
          control: proposal.kind,
          replay: false,
          flowId: selected.flowId,
          episode: view.episode,
          message: `Task ${view.flowId}: ${view.phase}. Continuation: ${view.continuation}. Observed at ${new Date(view.observedAt).toISOString()}.${view.endpoint ? ` ${view.endpoint.reason}` : ""} Delivery: ${view.notifications[0]?.state ?? "no receipt"}.`,
        };
      } else {
        const task = getSupervisedTask(selected.flowId, options);
        if (!task) {
          throw new Error("Task no longer exists");
        }
        const actorId = createHash("sha256")
          .update(
            JSON.stringify([
              source.agentId,
              source.namespace,
              source.sessionKey,
              source.ownerScope,
            ]),
          )
          .digest("hex");
        const action =
          proposal.kind === "cancel"
            ? { kind: "cancel" as const }
            : proposal.kind === "steer"
              ? { kind: "steer" as const, input: params.message }
              : {
                  kind: "resume" as const,
                  input: params.message,
                  policy: {
                    ...task.policy,
                    deadlineAt:
                      Date.now() +
                      Math.min(
                        7 * 24 * 3_600_000,
                        Math.max(1000, task.policy.deadlineAt - task.createdAt),
                      ),
                  },
                };
        const changed = controlSupervisedTask(
          {
            flowId: selected.flowId,
            episode: selected.episode,
            revision: selected.revision,
            inputId: params.sourceKey,
            action,
          },
          { actorId, assertCurrent: assertSource, supervisorOwnerId },
          Date.now(),
          options,
        );
        result = {
          kind: "handled",
          control: proposal.kind,
          replay: false,
          flowId: changed.flowId,
          episode: changed.episode,
          message: `Task ${changed.flowId}: ${proposal.kind === "steer" ? "updated within its accepted scope" : proposal.kind === "resume" ? "resumed under its accepted episode limits" : "cancelled"}. Current phase: ${changed.phase}. This acknowledgement is not proof of completed work or absence of earlier effects.`,
        };
      }
    }
    executeSqliteQuerySync(
      db,
      getNodeSqliteKysely<DB>(db)
        .insertInto("task_flow_inputs")
        .values({
          source_key: params.sourceKey,
          fingerprint: params.fingerprint,
          flow_id: result.flowId ?? null,
          episode: result.episode ?? null,
          disposition: "status",
          record_json: JSON.stringify(result),
          created_at_ms: Date.now(),
        }),
    );
    return result;
  }, options);
}
