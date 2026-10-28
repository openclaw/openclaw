import { describe, expect, it } from "vitest";
import {
  resolveAgentRestartRecoveryContext as resolveContext,
  resolveAgentRestartRecoveryExecutionIdentityAdmission as resolveAdmission,
} from "./agent-restart-recovery-context.js";

const matchingParams = {
  isRestartRecoveryResumeRun: true,
  canUseInternalRuntimeHandoff: true,
  expectedExistingSessionId: "session-1",
  resolvedSessionId: "session-1",
  resolvedSessionKey: "agent:main:discord:dm:123",
  runId: "recovery-run-1",
  sessionEntry: {
    sessionId: "session-1",
    updatedAt: 1,
    restartRecoveryDeliveryRunId: "recovery-run-1",
    restartRecoveryDeliverySourceRunId: "channel-user:v1:source-1",
    restartRecoveryDeliveryContext: {
      channel: "discord",
      to: "discord:dm:123",
      threadId: "thread-1",
    },
    restartRecoveryRequesterAccountId: "work",
    restartRecoveryRequesterSenderId: "user-1",
    restartRecoverySameChannelThreadRequired: true,
    restartRecoverySourceIngress: "channel",
  },
} as const;

type ContextParams = Parameters<typeof resolveContext>[0];
const resolveEntry = (
  entry: Partial<NonNullable<ContextParams["sessionEntry"]>>,
  params: Partial<ContextParams> = {},
) =>
  resolveContext({
    ...matchingParams,
    sessionEntry: { ...matchingParams.sessionEntry, ...entry },
    ...params,
  });

it("rejects mismatched recovery ownership before restoring ingress context", () => {
  for (const override of [
    { canUseInternalRuntimeHandoff: false },
    { expectedExistingSessionId: undefined },
    { expectedExistingSessionId: "replacement-session" },
    { resolvedSessionId: "replacement-session" },
    { runId: "replacement-run" },
    { sessionEntry: undefined },
    { sessionEntry: { ...matchingParams.sessionEntry, sessionId: "replacement-session" } },
    { sessionEntry: { ...matchingParams.sessionEntry, restartRecoveryDeliverySourceRunId: " " } },
    { sessionEntry: { ...matchingParams.sessionEntry, restartRecoverySourceIngress: undefined } },
  ]) {
    expect(resolveContext({ ...matchingParams, ...override })).toBeUndefined();
  }
});

it.each(["internal", "control-ui"] as const)("restores only admitted %s recovery", (ingress) => {
  const entry = {
    restartRecoverySourceIngress: ingress,
    restartRecoveryDeliveryContext:
      ingress === "internal"
        ? undefined
        : matchingParams.sessionEntry.restartRecoveryDeliveryContext,
  };
  const params =
    ingress === "internal" ? { resolvedSessionKey: "agent:main:dashboard:recovered-cli" } : {};
  expect(resolveEntry(entry, params)).toEqual(
    ingress === "internal"
      ? { messageChannel: "webchat" }
      : { messageChannel: "webchat", pinnedWidgetAuthoring: true },
  );
  expect(resolveEntry(entry, { ...params, isRestartRecoveryResumeRun: false })).toBeUndefined();
  if (ingress === "internal") {
    expect(resolveEntry({ restartRecoverySourceIngress: ingress }, params)).toBeUndefined();
  }
});

it("restores correlated channel delivery facts", () => {
  expect(resolveContext(matchingParams)).toEqual({
    messageChannel: "discord",
    channel: {
      channel: "discord",
      currentChannelId: "discord:dm:123",
      currentThreadTs: "thread-1",
      sourceTurnId: "channel-user:v1:source-1",
      requesterAccountId: "work",
      requesterSenderId: "user-1",
      sameChannelThreadRequired: true,
    },
  });
  expect(resolveEntry({ restartRecoveryDeliveryContext: undefined })).toBeUndefined();
});

it("preserves the source provider without granting delivery authority for a blank target", () => {
  expect(
    resolveEntry({ restartRecoveryDeliveryContext: { channel: " Discord ", to: "   " } }),
  ).toEqual({ messageChannel: "discord" });
});

describe("resolveAgentRestartRecoveryExecutionIdentityAdmission", () => {
  const token = {
    tokenVersion: 1 as const,
    contextId: "context-1",
    executionId: "execution-1",
    runId: "recovery-run-1",
    createdAt: 1,
  };
  const sessionEntry = {
    ...matchingParams.sessionEntry,
    mainRestartRecovery: {
      cycleId: "cycle-1",
      revision: 1,
      chargedAttempts: 1,
      executionIdentity: token,
    },
  };
  const admit = (overrides: Partial<Parameters<typeof resolveAdmission>[0]> = {}) =>
    resolveAdmission({
      collectionEnabled: true,
      isRestartRecoveryResumeRun: true,
      retryOnly: false,
      runId: token.runId,
      sessionEntry: matchingParams.sessionEntry,
      ...overrides,
    });

  it("rehydrates the durable token across rotated operational recovery runs", () => {
    const first = admit({ runId: "recovery-run-2", sessionEntry });
    const retry = admit({ retryOnly: true, runId: "recovery-run-3", sessionEntry });
    expect(first).toMatchObject({ retryOnly: false, consume: expect.any(Function) });
    expect(retry).toMatchObject({ retryOnly: true, consume: expect.any(Function) });
    expect(first?.consume("recovery-run-2")).toEqual({ accepted: true, token });
    expect(retry?.consume("recovery-run-3")).toEqual({ accepted: true, token });
  });

  it("returns no token for ordinary runs and refuses lost recovery evidence", () => {
    expect(admit({ isRestartRecoveryResumeRun: false })).toBeUndefined();
    const missing = admit({ retryOnly: true });
    expect(missing?.consume(token.runId)).toEqual({ accepted: true });
  });

  it("omits retained recovery identity while collection is disabled", () => {
    expect(admit({ collectionEnabled: false, retryOnly: true, sessionEntry })).toBeUndefined();
  });

  it("refuses an enabled recovery without an explicit capture or retry mode", () => {
    expect(() => admit({ retryOnly: undefined })).toThrow("admission mode is unavailable");
  });
});
