import { describe, expect, it } from "vitest";
import { getCliSessionBinding, resolveCliSessionReuse } from "../../agents/cli-session.js";
import { FailoverError } from "../../agents/failover-error.js";
import type { SessionEntry } from "../../config/sessions.js";
import {
  createFollowupRun,
  createMinimalRunAgentTurnParams,
  getExecuteAgentTurnForTest,
  initialFallbackAttemptOptions,
  setupAgentRunnerExecutionTestState,
} from "./agent-runner-execution.test-support.js";
import type { FallbackRunnerParams } from "./agent-runner-execution.test-support.js";

const state = setupAgentRunnerExecutionTestState();

describe("executeAgentTurn: CLI session auth boundary", () => {
  it("keeps the auth boundary when the auto-reply lane clears an auth-bound Claude CLI binding", async () => {
    // The auto-reply lane clears bindings through `clearCliSessionBindingForRun`,
    // not through settlement. If that clear erased an auth-invalidated binding,
    // the next turn would resolve `{mode:"none"}`, prepare would default to
    // `missing-transcript`, and raw reseed would replay the previous auth
    // identity's transcript into a fresh CLI process.
    state.isCliProviderMock.mockReturnValue(true);
    state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => ({
      result: await params.run(
        "claude-cli",
        "claude-opus-4-8",
        initialFallbackAttemptOptions(params),
      ),
      provider: "claude-cli",
      model: "claude-opus-4-8",
      attempts: [],
    }));
    state.runCliAgentMock.mockRejectedValueOnce(
      new FailoverError("No conversation found", {
        reason: "session_expired",
        provider: "claude-cli",
        model: "claude-opus-4-8",
      }),
    );

    const followupRun = createFollowupRun();
    followupRun.run.provider = "claude-cli";
    followupRun.run.model = "claude-opus-4-8";
    const sessionEntry = {
      sessionId: "openclaw-session",
      updatedAt: 1,
      cliSessionBindings: {
        "claude-cli": {
          sessionId: "stale-cli-session",
          authProfileId: "anthropic:old-profile",
          authEpoch: "epoch-old",
          authEpochVersion: 1,
        },
      },
      cliSessionIds: { "claude-cli": "stale-cli-session" },
      claudeCliSessionId: "stale-cli-session",
    } as SessionEntry;
    const activeSessionStore = { main: sessionEntry };
    const executeAgentTurn = await getExecuteAgentTurnForTest();

    const result = await executeAgentTurn({
      ...createMinimalRunAgentTurnParams({ followupRun }),
      activeSessionStore,
      getActiveSessionEntry: () => sessionEntry,
    });

    expect(result.kind).toBe("final");
    // Nothing resumable survives the clear.
    expect(sessionEntry.cliSessionBindings?.["claude-cli"]?.sessionId).toBeUndefined();
    expect(sessionEntry.cliSessionIds?.["claude-cli"]).toBeUndefined();
    expect(sessionEntry.claudeCliSessionId).toBeUndefined();
    // The auth identity does, so the next turn still resolves an auth boundary.
    expect(
      resolveCliSessionReuse({
        binding: getCliSessionBinding(sessionEntry, "claude-cli"),
        authProfileId: "anthropic:new-profile",
        authEpoch: "epoch-new",
        authEpochVersion: 1,
      }),
    ).toEqual({ mode: "invalidate", invalidatedReason: "auth-profile" });
  });
});
