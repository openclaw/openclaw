import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { vi } from "vitest";
import type { SessionGitHubPublicationPublished } from "../../../packages/gateway-protocol/src/schema/session-github-publication.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createScheduledGatewayRunner } from "../../gateway/scheduled-run-gateway-context.js";
import type { GatewayRequestContext } from "../../gateway/server-methods/types.js";
import type { GatewaySchedulerClock } from "../../infra/gateway-scheduler.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { createCronServiceWithStateForTest, createNoopLogger } from "../service.test-harness.js";
import type { CronServiceDeps } from "../service/state.js";
import { runCronSessionTurn } from "../session-run.js";
import { resolveCronSessionTargetSessionKey } from "../session-target.js";
import type { runCronIsolatedAgentTurn } from "./run.js";

/** The fixture uses the same session and detached execution owners as the Gateway. */
export function createOperatorContinuationService(params: {
  config: OpenClawConfig;
  stateDir: string;
  clock: GatewaySchedulerClock;
  resolveGatewayContext: () => GatewayRequestContext;
  runIsolated: typeof runCronIsolatedAgentTurn;
  onEvent: CronServiceDeps["onEvent"];
}) {
  return createCronServiceWithStateForTest({
    onEvent: params.onEvent,
    scheduler: createTestGatewayScheduler(params.clock),
    nowMs: params.clock.now,
    storePath: path.join(params.stateDir, "cron", "jobs.json"),
    cronEnabled: true,
    defaultAgentId: "main",
    log: createNoopLogger(),
    enqueueSystemEvent: vi.fn(),
    requestHeartbeat: vi.fn(),
    runSchedulerOwned: createScheduledGatewayRunner(params.resolveGatewayContext),
    runSessionEvent: (request) =>
      runCronSessionTurn({
        ...request,
        cfg: params.config,
        agentId: "main",
        sessionKey: expectDefined(
          resolveCronSessionTargetSessionKey(request.job.sessionTarget),
          "explicit continuation session target",
        ),
      }),
    runIsolatedAgentJob: (request) =>
      params.runIsolated({
        ...request,
        cfg: params.config,
        deps: {},
        agentId: "main",
        sessionKey: `cron:${request.job.id}`,
      }),
  });
}

export const publication: SessionGitHubPublicationPublished = {
  status: "published",
  requestId: "27878d29-9f2e-462d-a68a-4e9b4ba27685",
  repository: "fixture/repository",
  branch: "reviewed-change",
  headCommit: "a".repeat(40),
  url: "https://github.com/fixture/repository/pull/7",
  publisher: { source: "agent-override", accountId: 42, login: "roboclaw-bot" },
};

/** Synthetic GitHub response; the test retains authorization and effect assertions. */
export function publicationCommandResult(merged: boolean) {
  return {
    code: 0,
    termination: "exit" as const,
    signal: null,
    killed: false,
    stderr: Buffer.alloc(0),
    stdout: Buffer.from(
      JSON.stringify({
        node_id: "fixture-pr",
        html_url: publication.url,
        title: "Reviewed change",
        body: "Reviewed",
        state: merged ? "closed" : "open",
        draft: false,
        merged,
        head: { ref: publication.branch, sha: publication.headCommit },
        base: { repo: { full_name: publication.repository } },
        mergeable: true,
        mergeable_state: "clean",
        merge_commit_sha: merged ? "b".repeat(40) : null,
      }),
    ),
  };
}
