import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect } from "vitest";
import {
  createOriginalIssuerFixture,
  readIssuerFixtureHistory,
} from "../../agents/main-session-recovery/main-session-recovery-original-issuer.test-support.js";
import { refreshPreparedModelRuntimeSnapshots } from "../../agents/prepared-model-runtime.js";
import { withGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import { createCreateGoalTool } from "../../agents/tools/goal-tools.js";
import { getSessionGoal } from "../../config/sessions/goals.js";
import type { GoalRecoveryIssuerBasis } from "../../config/sessions/main-session-recovery.types.js";
import {
  loadSessionEntry,
  replaceSessionEntry,
  appendTranscriptMessage,
} from "../../config/sessions/session-accessor.js";
import type { SessionGoal } from "../../config/sessions/types.js";

export async function prepareOriginalStartupGoal(input: {
  fixture: Awaited<ReturnType<typeof createOriginalIssuerFixture>>;
  target: { agentId: string; sessionKey: string };
  sessionId: string;
  workspaceDir: string;
  originalIssuer: GoalRecoveryIssuerBasis;
}) {
  const { fixture, target, sessionId, originalIssuer } = input;
  await appendTranscriptMessage(
    { ...target, sessionId },
    {
      cwd: input.workspaceDir,
      message: {
        role: "user",
        content: "Accepted original Goal work",
        idempotencyKey: "original-goal",
      },
    },
  );
  const tool = createCreateGoalTool({
    agentSessionKey: target.sessionKey,
    sessionAgentId: target.agentId,
    config: fixture.cfg,
  });
  await withGatewayToolCallerIdentity(
    {
      ...target,
      operatorAuthority: fixture.original!.authority,
      gatewayContextResolver: () => fixture.context,
    },
    () =>
      tool.execute!("original-goal", {
        objective: "Finish the originally accepted Goal",
        token_budget: 500,
      }),
  );
  const created = expectDefined(loadSessionEntry(target), "captured original Goal");
  const savedIssuer = expectDefined(
    created.mainRestartRecovery?.goalIntent?.issuer,
    "saved original issuer",
  );
  expect(savedIssuer).toEqual(originalIssuer);
  expect(created.mainRestartRecovery?.goalIntent).toMatchObject({
    sessionId,
    sessionKey: target.sessionKey,
    goalId: created.goal?.id,
    issuer: savedIssuer,
  });
  // Existing accepted accounting is fixture input; recovery must not reset it.
  await replaceSessionEntry(target, {
    ...created,
    totalTokens: 180,
    goal: { ...expectDefined(created.goal, "original Goal"), continuationTurns: 3 },
  });
  const originalGoal: SessionGoal = expectDefined(
    (await getSessionGoal(target)).goal,
    "accounted original Goal",
  );
  expect(originalGoal).toMatchObject({
    tokenStart: 100,
    tokensUsed: 80,
    tokenBudget: 500,
    continuationTurns: 3,
  });
  const originalHistory = await readIssuerFixtureHistory(target, sessionId);
  await refreshPreparedModelRuntimeSnapshots(fixture.cfg, {
    gatewayLifecycle: true,
    catalogMode: "static",
  });
  return { goal: originalGoal, history: originalHistory };
}
