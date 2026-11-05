import { expectDefined } from "@openclaw/normalization-core";
import { expect, it } from "vitest";
import { planCronJobMutation } from "./store/job-mutations.js";
import { cronStreamExecApprovalBinding } from "./stream-exec-authority.js";
import type { CronStoredJob } from "./types.js";

const sessionKey = "agent:main:dashboard:creator";
const source: NonNullable<CronStoredJob["operatorSource"]>["source"] = {
  version: 1,
  agentId: "main",
  sessionKey,
  sessionId: "creator-session",
  sourceRunId: "creator-run",
  snapshot: {
    profileId: "fixture-operator",
    scopes: ["operator.admin"],
    assignedRole: null,
    githubLogin: null,
    grant: null,
    aliasBindingIds: [],
    authPolicy: {
      generation: "",
      grantGeneration: "fixture-generation",
      role: "operator",
      authMethod: "token",
    },
    controlUiAdmin: true,
    localOperator: false,
    sourceIngress: "control-ui",
  },
};

function proposal(nowMs: number, operatorSource = source, command = ["node", "watch.js"]) {
  const plan = planCronJobMutation(
    { version: 1, jobs: [] },
    {
      kind: "add",
      input: {
        id: "watcher",
        agentId: "main",
        name: "Watcher",
        enabled: true,
        schedule: { kind: "stream", command },
        sessionTarget: "isolated",
        wakeMode: "now",
        payload: { kind: "agentTurn", message: "Handle events", toolsAllow: ["*"] },
        owner: { agentId: "main", sessionKey, accountId: "default" },
      },
      options: {
        captured: false,
        operatorSource,
        sourceConversation: { sessionKey, sessionId: "creator-session" },
        scheduledToolPolicy: {
          version: 1,
          mode: "account",
          ownerSessionKey: sessionKey,
          ownerAccountId: "default",
        },
      },
    },
    { nowMs, defaultAgentId: "main", cronConfig: { triggers: { enabled: true } } },
  );
  return { method: "cron.add" as const, job: expectDefined(plan.job, "planned watcher") };
}

it("keeps the approved creation stable across time while binding its source and command", () => {
  const shown = proposal(1_000);
  const accepted = proposal(2_000);
  expect(shown.job.operatorSource?.source).toEqual(source);
  expect(accepted.job.operatorSource?.executionRevision).not.toBe(
    shown.job.operatorSource?.executionRevision,
  );
  const binding = cronStreamExecApprovalBinding(shown);
  expect(cronStreamExecApprovalBinding(accepted)).toBe(binding);
  expect(
    cronStreamExecApprovalBinding(proposal(2_000, { ...source, sourceRunId: "another-run" })),
  ).not.toBe(binding);
  expect(cronStreamExecApprovalBinding(proposal(2_000, source, ["node", "other.js"]))).not.toBe(
    binding,
  );
});
