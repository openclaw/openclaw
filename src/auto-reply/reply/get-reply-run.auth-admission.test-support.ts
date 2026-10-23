import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import type { SessionEntry } from "../../config/sessions.js";
import { readConfiguredModelAuthProfileProvider } from "../../config/sessions/auth-profile-override-provenance.js";
import { listActiveReplyRunSessionKeys } from "../../sessions/session-controller.queries.js";
import { runReplyAgent } from "./agent-runner-run.js";
import { shouldUseReplyFastTestRuntime } from "./get-reply-fast-path.js";
import { runPreparedReply } from "./get-reply-run.js";
import { baseParams } from "./get-reply-run.test-support.js";

export function registerReplyAuthAdmissionCases({
  requireRunReplyAgentCall,
}: {
  requireRunReplyAgentCall: () => Parameters<typeof runReplyAgent>[0];
}): void {
  it("validates the configured profile before fast dispatch", async () => {
    const { resolveSessionAuthSelection } =
      await import("../../agents/auth-profiles/session-override.js");
    vi.mocked(shouldUseReplyFastTestRuntime).mockReturnValueOnce(true);
    const sessionEntry: SessionEntry = {
      sessionId: "configured-profile-session",
      updatedAt: 1,
      authProfileOverride: "openai:subscription",
      authProfileOverrideSource: "auto",
    };
    vi.mocked(resolveSessionAuthSelection).mockImplementationOnce(
      async ({ configuredProfileId, sessionEntry: selectedSession }) => {
        if (!configuredProfileId) {
          return undefined;
        }
        if (selectedSession) {
          selectedSession.authProfileOverride = configuredProfileId;
        }
        return { profileId: configuredProfileId, source: "user", routeRequirement: "api-key" };
      },
    );
    const params = {
      ...baseParams({
        provider: "openai",
        model: "gpt-5.5",
        sessionEntry,
        sessionStore: { "session-key": sessionEntry },
      }),
      configuredProfileId: "openai:metered",
    };
    await runPreparedReply(params);
    expect(resolveSessionAuthSelection).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai",
        modelId: "gpt-5.5",
        configuredProfileId: "openai:metered",
      }),
    );
    expect(requireRunReplyAgentCall().followupRun.run).toMatchObject({
      authProfileId: "openai:metered",
      authProfileIdSource: "user",
    });
    expect(sessionEntry.authProfileOverride).toBe("openai:subscription");
  });

  it("carries configured account provenance from admission into the runnable turn", async () => {
    const { resolveSessionAuthSelection } =
      await import("../../agents/auth-profiles/session-override.js");
    vi.mocked(shouldUseReplyFastTestRuntime).mockReturnValueOnce(false);
    vi.mocked(resolveSessionAuthSelection).mockResolvedValueOnce({
      profileId: "anthropic:configured",
      source: "user",
      routeRequirement: undefined,
      configuredPrimaryProvider: "anthropic",
    });

    await runPreparedReply(baseParams());

    const run = requireRunReplyAgentCall().followupRun.run;
    expect(run.authProfileId).toBe("anthropic:configured");
    expect(run.authProfileIdSource).toBe("user");
    expect(readConfiguredModelAuthProfileProvider(run)).toBe("anthropic");
  });

  it.each([false, true])(
    "rejects invalid configured profiles before dispatch or reply registration (fast: %s)",
    async (fast) => {
      const { resolveSessionAuthSelection } =
        await import("../../agents/auth-profiles/session-override.js");
      vi.mocked(shouldUseReplyFastTestRuntime).mockReturnValueOnce(fast);
      const authEntered = createDeferred();
      const releaseAuth = createDeferred();
      vi.mocked(resolveSessionAuthSelection).mockImplementationOnce(async () => {
        authEntered.resolve();
        await releaseAuth.promise;
        throw new Error("Auth profile is not configured for openai.");
      });
      const activeBefore = listActiveReplyRunSessionKeys().length;
      const params = {
        ...baseParams({ provider: "openai", model: "gpt-5.5" }),
        configuredProfileId: "anthropic:other",
      };
      const running = runPreparedReply(params);
      const rejected = expect(running).rejects.toThrow(
        "Auth profile is not configured for openai.",
      );
      try {
        await awaitGateBeforeSettlement(
          authEntered.promise,
          running,
          "auth validation was bypassed",
        );
        expect(listActiveReplyRunSessionKeys().length).toBe(activeBefore);
        expect(runReplyAgent).not.toHaveBeenCalled();
      } finally {
        releaseAuth.resolve();
        await rejected;
      }
      expect(runReplyAgent).not.toHaveBeenCalled();
      expect(listActiveReplyRunSessionKeys().length).toBe(activeBefore);
    },
  );

  it("does not leave an active reply operation after auth preparation fails", async () => {
    const { resolveSessionAuthSelection } =
      await import("../../agents/auth-profiles/session-override.js");
    const sessionId = "reply-operation-auth-failure";
    const activeBefore = listActiveReplyRunSessionKeys().length;
    vi.mocked(resolveSessionAuthSelection).mockRejectedValueOnce(new Error("auth failed"));

    await expect(
      runPreparedReply(
        baseParams({
          sessionId,
        }),
      ),
    ).rejects.toThrow("auth failed");

    expect(listActiveReplyRunSessionKeys().length).toBe(activeBefore);
  });
}
