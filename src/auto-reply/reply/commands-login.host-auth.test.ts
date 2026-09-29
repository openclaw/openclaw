import { describe, expect, it, vi } from "vitest";
import type { ModelsAuthLoginFlowOptions } from "../../commands/models/auth.js";
import { HOST_MANAGED_AUTH_LOGIN_MESSAGE } from "../../shared/host-managed-auth-error.js";
import {
  blockReplyOpts,
  buildLoginParams,
  mockSuccessfulLoginFlow,
  patchSessionEntryMock,
  runModelsAuthLoginFlowMock,
  setupLoginCommandTests,
} from "./commands-login.harness-test-support.js";

const authOwnership = vi.hoisted(() => vi.fn());
vi.mock("../../agents/harness/auth-ownership.js", () => ({
  resolveAgentHarnessAuthOwnership: authOwnership,
}));

const { handleLoginCommand } = await import("./commands-login.js");
const { handleCommands } = await import("./commands-core.js");

describe("handleLoginCommand host-managed authentication", () => {
  setupLoginCommandTests();

  it.each([
    "/login",
    "/login codex",
    "/login openai",
    "/login oauth/openai/openai",
    "/login openai/openai-device-code",
  ])("returns a host-managed refusal through the registered %s command", async (commandText) => {
    authOwnership.mockReturnValue("host");
    const entry = {
      sessionId: "owner-session",
      updatedAt: 1,
      authProfileOverride: "openai:existing",
    };
    const params = buildLoginParams(commandText, { sessionEntry: entry, opts: blockReplyOpts() });
    try {
      const result = await handleCommands({
        ...params,
        resolveModelLevels: async () => ({
          resolvedThinkLevel: params.resolvedThinkLevel,
          resolvedReasoningLevel: params.resolvedReasoningLevel,
        }),
      });
      expect(result).toMatchObject({
        shouldContinue: false,
        reply: { text: HOST_MANAGED_AUTH_LOGIN_MESSAGE },
      });
      expect(params.sessionEntry).toBe(entry);
      expect(runModelsAuthLoginFlowMock).not.toHaveBeenCalled();
      expect(patchSessionEntryMock).not.toHaveBeenCalled();
    } finally {
      authOwnership.mockReset();
    }
  });

  it("returns the host refusal when ownership changes during an active login", async () => {
    runModelsAuthLoginFlowMock.mockImplementationOnce(async (opts: ModelsAuthLoginFlowOptions) => {
      await Promise.resolve();
      authOwnership.mockReturnValue("host");
      await opts.beforePersistentEffect?.();
      throw new Error("credential write should have been refused");
    });
    try {
      const result = await handleLoginCommand(
        buildLoginParams("/login codex", { opts: blockReplyOpts() }),
        true,
      );
      expect(result?.reply?.text).toBe(HOST_MANAGED_AUTH_LOGIN_MESSAGE);
      expect(patchSessionEntryMock).not.toHaveBeenCalled();
    } finally {
      authOwnership.mockReset();
    }
  });

  it("keeps the existing session profile when host ownership changes before session persistence", async () => {
    mockSuccessfulLoginFlow("openai:new-owner");
    const previousEntry = {
      sessionId: "owner-session",
      updatedAt: 1,
      authProfileOverride: "openai:existing",
    };
    const persist = vi.fn();
    patchSessionEntryMock.mockImplementationOnce(async (params) => {
      const patch = await params.update(
        { ...previousEntry },
        { existingEntry: { ...previousEntry } },
      );
      authOwnership.mockReturnValue("host");
      params.assertCommitAllowed?.();
      persist();
      return patch ? { ...previousEntry, ...patch } : previousEntry;
    });
    const params = buildLoginParams("/login codex", {
      opts: blockReplyOpts(),
      sessionEntry: previousEntry,
      storePath: "/tmp/host-login-sessions.json",
    });
    try {
      const result = await handleLoginCommand(params, true);
      expect(result?.reply?.text).toBe(HOST_MANAGED_AUTH_LOGIN_MESSAGE);
      expect(params.sessionEntry).toBe(previousEntry);
      expect(persist).not.toHaveBeenCalled();
    } finally {
      authOwnership.mockReset();
    }
  });

  it.each(["codex", "openclaw"])(
    "uses the ordinary session runtime override %s for login ownership",
    async (runtimeId) => {
      authOwnership.mockImplementation((params) =>
        params.runtimeId === "codex" ? "host" : undefined,
      );
      mockSuccessfulLoginFlow();
      const params = buildLoginParams("/login codex", {
        opts: blockReplyOpts(),
        sessionEntry: { sessionId: "owner-session", updatedAt: 1, agentRuntimeOverride: runtimeId },
      });
      params.cfg = {
        ...params.cfg,
        models: {
          providers: {
            openai: {
              baseUrl: "https://api.openai.com/v1",
              models: [],
              agentRuntime: { id: runtimeId === "codex" ? "openclaw" : "codex" },
            },
          },
        },
      };
      try {
        const result = await handleLoginCommand(params, true);
        expect(authOwnership).toHaveBeenCalledWith(expect.objectContaining({ runtimeId }));
        expect(result?.reply?.text).toBe(
          runtimeId === "codex"
            ? HOST_MANAGED_AUTH_LOGIN_MESSAGE
            : "OpenAI login complete. Try your request again now.",
        );
        expect(runModelsAuthLoginFlowMock).toHaveBeenCalledTimes(runtimeId === "codex" ? 0 : 1);
      } finally {
        authOwnership.mockReset();
      }
    },
  );
});
