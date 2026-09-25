import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { requirePublicationCommand } from "../gateway/github-publication-git-transport.js";
import { prepareSupervisedPublisher } from "./supervised-operation.publication.js";
import {
  getSupervisedOperation,
  listSupervisedOperations,
  scheduleSupervisedOperationPoll,
} from "./supervised-operation.store.js";
import type {
  SupervisedOperationExecution,
  SupervisedOperationOutcome,
} from "./supervised-operation.types.js";
import type { SupervisedWorkflowDatabaseOptions } from "./supervised-workflow.persistence.js";
import type {
  SupervisedWorkflowContract,
  SupervisedWorkflowProfile,
} from "./supervised-workflow.types.js";

const CheckRunSchema = z.object({
  id: z.number().int().positive(),
  name: z.string(),
  head_sha: z.string(),
  status: z.string(),
  conclusion: z.string().nullable(),
  app: z.object({ id: z.number().int().positive() }),
});

export function evaluateSupervisedChecks(
  value: unknown,
  head: string,
  required: Extract<SupervisedWorkflowProfile, { kind: "ci" }>["requiredChecks"],
): "pending" | "succeeded" | "failed" {
  const runs = z.array(CheckRunSchema).parse(value);
  let pending = false;
  for (const check of required) {
    const latest = runs
      .filter(
        (run) => run.head_sha === head && run.name === check.name && run.app.id === check.appId,
      )
      .toSorted((a, b) => b.id - a.id)[0];
    if (!latest || latest.status !== "completed") {
      pending = true;
      continue;
    }
    // Skipped/neutral are not an accepted successful behavioral check.
    if (latest.conclusion !== "success") {
      return "failed";
    }
  }
  return pending ? "pending" : "succeeded";
}

export async function runSupervisedCI(params: {
  contract: SupervisedWorkflowContract;
  profile: Extract<SupervisedWorkflowProfile, { kind: "ci" }>;
  execution: SupervisedOperationExecution;
  flowId: string;
  episode: number;
  deadlineAt: number;
  options: SupervisedWorkflowDatabaseOptions;
  assertCurrent: () => void;
  reserveDispatch: () => void;
  signal: AbortSignal;
}): Promise<SupervisedOperationOutcome> {
  const { profile, contract, execution, options, assertCurrent } = params;
  const publication = contract.profiles.find((item) => item.id === profile.publicationProfile);
  if (publication?.kind !== "publication") {
    throw new Error("CI lost its accepted publication profile");
  }
  const receipt = listSupervisedOperations(options, params.flowId, params.episode)
    .filter(
      (operation) =>
        operation.request.profile === publication.id && operation.outcome?.status === "succeeded",
    )
    .toSorted((a, b) => b.updatedAt - a.updatedAt)[0];
  const head = receipt?.publication?.headCommit;
  if (!head || !receipt.outcome) {
    throw new Error("CI requires a verified publication receipt");
  }
  const operation = getSupervisedOperation(execution.operationId, options);
  if (!operation) {
    throw new Error("CI operation custody unavailable");
  }
  const deadline = Math.min(params.deadlineAt, operation.createdAt + profile.timeoutMs);
  params.reserveDispatch();
  while (Date.now() < deadline) {
    const identity = await prepareSupervisedPublisher(publication, assertCurrent);
    const checks: z.infer<typeof CheckRunSchema>[] = [];
    let complete = false;
    for (let page = 1; page <= 20; page += 1) {
      assertCurrent();
      const result = z
        .object({
          total_count: z.number().int().nonnegative(),
          check_runs: z.array(CheckRunSchema),
        })
        .parse(
          JSON.parse(
            await requirePublicationCommand(
              [
                "gh",
                "api",
                "--hostname",
                "github.com",
                `repos/${publication.pushRepository}/commits/${head}/check-runs?per_page=100&page=${page}&filter=all`,
              ],
              { env: identity.env },
            ),
          ),
        );
      assertCurrent();
      checks.push(...result.check_runs);
      if (checks.length >= result.total_count) {
        complete = true;
        break;
      }
    }
    if (!complete) {
      throw new Error("CI check inventory exceeds the bounded complete lookup");
    }
    const state = evaluateSupervisedChecks(checks, head, profile.requiredChecks);
    if (state !== "pending") {
      return {
        status: state,
        summary:
          state === "succeeded"
            ? "All accepted CI checks passed on the exact published head"
            : "An accepted CI check failed on the published head",
        facts: {
          sourceHash: receipt.publication!.sourceHash,
          resultHash: receipt.publication!.sourceHash,
          headCommit: head,
          publicationOperationId: receipt.operationId,
          checked: JSON.stringify(profile.requiredChecks),
        },
        artifacts: [],
      };
    }
    const dueAt = Math.min(deadline, Date.now() + profile.pollIntervalMs);
    scheduleSupervisedOperationPoll(execution, dueAt, Date.now(), options);
    await delay(Math.max(0, dueAt - Date.now()), undefined, { signal: params.signal });
  }
  return {
    status: "failed",
    summary: "CI did not satisfy the accepted checks before its deadline",
    facts: { headCommit: head },
    artifacts: [],
  };
}
