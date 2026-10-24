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

const matchingUiParams = {
  ...matchingParams,
  sessionEntry: { ...matchingParams.sessionEntry, restartRecoverySourceIngress: "control-ui" },
} as const;

const matchingInternalParams = {
  ...matchingParams,
  resolvedSessionKey: "agent:main:dashboard:recovered-cli",
  sessionEntry: {
    ...matchingParams.sessionEntry,
    restartRecoverySourceIngress: "internal",
    restartRecoveryDeliveryContext: undefined,
  },
} as const;

const ordinaryRun = (params: Parameters<typeof resolveContext>[0]) =>
  resolveContext({ ...params, isRestartRecoveryResumeRun: false });
const resolveEntry = (
  entry: Partial<NonNullable<Parameters<typeof resolveContext>[0]["sessionEntry"]>>,
  params: typeof matchingParams | typeof matchingInternalParams = matchingParams,
) =>
  resolveContext({
    ...params,
    sessionEntry: { ...params.sessionEntry, ...entry },
  });

describe("resolveAgentRestartRecoveryContext", () => {
  it.each([matchingParams, matchingUiParams, matchingInternalParams])(
    "rejects mismatched recovery ownership",
    (params) => {
      for (const override of [
        { canUseInternalRuntimeHandoff: false },
        { expectedExistingSessionId: undefined },
        { expectedExistingSessionId: "replacement-session" },
        { resolvedSessionId: "replacement-session" },
        { runId: "replacement-run" },
        { sessionEntry: undefined },
        { sessionEntry: { ...params.sessionEntry, sessionId: "replacement-session" } },
        { sessionEntry: { ...params.sessionEntry, restartRecoveryDeliverySourceRunId: " " } },
        { sessionEntry: { ...params.sessionEntry, restartRecoverySourceIngress: undefined } },
      ]) {
        expect(resolveContext({ ...params, ...override })).toBeUndefined();
      }
    },
  );

  it("does not restore an internal source for ordinary runs or external delivery claims", () => {
    expect(ordinaryRun(matchingInternalParams)).toBeUndefined();
    expect(
      resolveEntry(
        {
          restartRecoveryDeliveryContext:
            matchingParams.sessionEntry.restartRecoveryDeliveryContext,
        },
        matchingInternalParams,
      ),
    ).toBeUndefined();
  });

  it("retains the WebChat fallback for an older internal claim without channel facts", () => {
    expect(resolveContext(matchingInternalParams)).toEqual({ messageChannel: "webchat" });
  });

  it("preserves WebChat policy context and pinned authoring for an admitted Control UI recovery", () => {
    expect(resolveContext(matchingUiParams)).toEqual({
      messageChannel: "webchat",
      pinnedWidgetAuthoring: true,
    });
    expect(ordinaryRun(matchingUiParams)).toBeUndefined();
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
