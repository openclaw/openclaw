// Fixture replay shared by the development replay script and the fixture tests.
import { assembleScheduledAdmissionFacts } from "./execution-context-admission.js";
import { compareScheduledDecisions } from "./execution-context-projection.js";
import {
  buildScheduledExecutionContext,
  type ScheduledAdmissionFacts,
} from "./execution-context.js";
import { resolveCronSessionTargetSessionKey } from "./session-target.js";
import { resolveCronRunToolsAllow } from "./tools-allow.js";
import type { CronStoredJob } from "./types.js";

export type ScheduledContextFixture = {
  job: CronStoredJob;
  parentRow?: NonNullable<ScheduledAdmissionFacts["parentRow"]>;
  owner?: boolean;
  expected?: ScheduledContextFixtureOutcome;
};

export type ScheduledContextFixtureOutcome = {
  status: "ready" | "pause" | "fail";
  principal?: string;
  placement?: string;
  labels: Record<string, string>;
};

/** Builds the fixture's context and labels it against the legacy decisions. */
export function replayScheduledContextFixture(
  fixture: ScheduledContextFixture,
): ScheduledContextFixtureOutcome {
  const { job } = fixture;
  const runSessionKey =
    resolveCronSessionTargetSessionKey(job.sessionTarget) ??
    `agent:main:cron:${job.id}:run:fixture`;
  const facts = assembleScheduledAdmissionFacts(
    {
      cfg: {},
      job,
      trigger: "cron",
      runId: "fixture",
      agentId: "main",
      runSessionKey,
      toolsAllow: resolveCronRunToolsAllow(job),
    },
    fixture.parentRow,
    fixture.owner,
  );
  const result = buildScheduledExecutionContext(job, facts);
  const divergence = compareScheduledDecisions(job, facts, result);
  return {
    status: result.status,
    ...(result.status === "ready"
      ? { principal: result.facts.principal.kind, placement: result.facts.placement }
      : {}),
    labels: { ...divergence.labels },
  };
}
