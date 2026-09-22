import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";

export function registerHeartbeatAuthProfilePreservationTest({
  authProfileStoreMock,
  defaultProvider,
  defaultModel,
  sessionKey,
  resolveStateWithOverride,
}: {
  authProfileStoreMock: AuthProfileSelectionTestHarness["authProfileStoreMock"];
  defaultProvider: string;
  defaultModel: string;
  sessionKey: string;
  resolveStateWithOverride: (params: {
    providerOverride: string;
    modelOverride: string;
    modelOverrideSource: "auto";
    modelOverrideFallbackOriginProvider: string;
    modelOverrideFallbackOriginModel: string;
    authProfileOverride: string;
    authProfileOverrideSource: "user";
    provider: string;
    model: string;
    isHeartbeat: boolean;
  }) => Promise<{
    state: { provider: string; model: string; resetModelOverride: boolean };
    sessionStore: Record<string, SessionEntry>;
  }>;
}): void {
  it("preserves user auth profile when clearing a stale heartbeat auto-failover override", async () => {
    authProfileStoreMock.store = {
      version: 1,
      profiles: {
        "mac-studio:local": {
          type: "api_key",
          provider: defaultProvider,
          key: "test-key",
        },
      },
    };
    const { state, sessionStore } = await resolveStateWithOverride({
      providerOverride: "openrouter",
      modelOverride: "minimax/minimax-m2.7",
      modelOverrideSource: "auto",
      modelOverrideFallbackOriginProvider: "openai",
      modelOverrideFallbackOriginModel: "gpt-5.3",
      authProfileOverride: "mac-studio:local",
      authProfileOverrideSource: "user",
      provider: "openrouter",
      model: "minimax/minimax-m2.7",
      isHeartbeat: true,
    });

    expect(state.provider).toBe(defaultProvider);
    expect(state.model).toBe(defaultModel);
    expect(state.resetModelOverride).toBe(true);
    expect(sessionStore[sessionKey]?.providerOverride).toBeUndefined();
    expect(sessionStore[sessionKey]?.modelOverride).toBeUndefined();
    expect(sessionStore[sessionKey]?.authProfileOverride).toBe("mac-studio:local");
    expect(sessionStore[sessionKey]?.authProfileOverrideSource).toBe("user");
  });
}

type AuthProfileSelectionTestHarness = {
  createModelSelectionState: typeof import("./model-selection.js").createModelSelectionState;
  resolveAgentDir: typeof import("../../agents/agent-scope.js").resolveAgentDir;
  authProfileStoreMock: {
    store: {
      version: 1;
      profiles: Record<string, { type: "api_key"; provider: string; key: string }>;
    };
    ensureAuthProfileStore: unknown;
    prepareAuthProfileProviderForSelection: unknown;
    resolveAuthProfileProviderForSelection: unknown;
  };
  sessionPersistenceMocks: {
    patchSessionEntryCore: unknown;
    persistReplySessionEntry: unknown;
  };
};

export function registerModelSelectionAuthProfileTests({
  createModelSelectionState,
  resolveAgentDir,
  authProfileStoreMock,
  sessionPersistenceMocks,
}: AuthProfileSelectionTestHarness): void {
  describe("createModelSelectionState auth-profile override flapping regression", () => {
    const sessionKey = "agent:main:telegram:direct:1";

    it("keeps alias-compatible authProfileOverride when stored credential provider is 'anthropic' for a claude-cli session", async () => {
      // Regression: the old code compared profile.provider directly to acceptedAuthProviders,
      // which cleared an 'anthropic' credential when the session ran under the 'claude-cli'
      // provider. The alias (claude-cli -> anthropic) must be respected so the override is kept.
      authProfileStoreMock.store = {
        version: 1,
        profiles: {
          "anthropic:claude-cli": {
            type: "api_key",
            provider: "anthropic",
            key: "test-cli-oauth-token",
          },
        },
      };
      const sessionEntry: SessionEntry = {
        sessionId: "s-cli",
        updatedAt: 1,
        authProfileOverride: "anthropic:claude-cli",
      };
      const sessionStore = { [sessionKey]: sessionEntry };

      await createModelSelectionState({
        agentId: "main",
        cfg: {} as OpenClawConfig,
        agentCfg: undefined,
        sessionEntry,
        sessionStore,
        sessionKey,
        defaultProvider: "claude-cli",
        defaultModel: "claude-opus-4-7",
        provider: "claude-cli",
        model: "claude-opus-4-7",
        hasModelDirective: false,
      });

      // The override must NOT have been cleared — the anthropic credential is
      // alias-compatible with the claude-cli provider.
      expect(sessionStore[sessionKey]?.authProfileOverride).toBe("anthropic:claude-cli");
      expect(sessionEntry.authProfileOverride).toBe("anthropic:claude-cli");
    });
  });

  describe("createModelSelectionState unavailable explicit auth selection", () => {
    const configuredProfileId = "openai:configured";
    const selectedProfileId = "team:selected";

    async function select(params: {
      runtime: "codex" | "openclaw";
      agentId: string;
      source?: SessionEntry["authProfileOverrideSource"];
      compactionCount?: number;
      selectedProvider?: string;
      storePath?: string;
    }) {
      authProfileStoreMock.store = {
        version: 1,
        profiles: {
          [configuredProfileId]: {
            type: "api_key",
            provider: "openai",
            key: "usable-configured-key",
          },
        },
      };
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            model: { primary: `openai/gpt-4o@${configuredProfileId}` },
            models: { "openai/gpt-4o": { agentRuntime: { id: params.runtime } } },
          },
        },
        auth: {
          profiles: {
            [configuredProfileId]: { provider: "openai", mode: "api_key" },
            [selectedProfileId]: { provider: params.selectedProvider ?? "openai", mode: "api_key" },
          },
        },
      };
      const sessionEntry: SessionEntry = {
        sessionId: "explicit-account-selection",
        updatedAt: 1,
        authProfileOverride: selectedProfileId,
        ...(params.source ? { authProfileOverrideSource: params.source } : {}),
        ...(params.compactionCount !== undefined
          ? { authProfileOverrideCompactionCount: params.compactionCount }
          : {}),
      };
      const sessionKey = `agent:${params.agentId}:auth-selection`;
      const before = { ...sessionEntry };
      const sessionStore = { [sessionKey]: sessionEntry };
      await createModelSelectionState({
        cfg,
        agentId: params.agentId,
        agentCfg: cfg.agents?.defaults,
        sessionEntry,
        sessionStore,
        sessionKey,
        storePath: params.storePath,
        defaultProvider: "openai",
        defaultModel: "gpt-4o",
        provider: "openai",
        model: "gpt-4o",
        hasModelDirective: false,
      });
      return { cfg, before, sessionEntry, sessionStore, sessionKey };
    }

    it.each(
      (["codex", "openclaw"] as const).flatMap((runtime) =>
        (["user", "user-link", undefined] as const).flatMap((source) =>
          ["main", "secondary"].map((agentId) => ({ runtime, source, agentId })),
        ),
      ),
    )("keeps explicit B with usable A: $runtime/$source/$agentId", async (params) => {
      const { cfg, before, sessionEntry, sessionStore, sessionKey } = await select({
        ...params,
        storePath: `/tmp/openclaw-auth-selection-fixture/agents/${params.agentId}/sessions/sessions.json`,
      });
      expect(sessionEntry).toEqual(before);
      expect(sessionStore[sessionKey]).toEqual(before);
      expect(authProfileStoreMock.store.profiles[configuredProfileId]).toBeDefined();
      expect(authProfileStoreMock.store.profiles[selectedProfileId]).toBeUndefined();
      const agentDir = resolveAgentDir(cfg, params.agentId);
      expect(authProfileStoreMock.ensureAuthProfileStore).toHaveBeenCalledWith(agentDir, {
        allowKeychainPrompt: false,
        profileId: selectedProfileId,
      });
      expect(
        authProfileStoreMock.prepareAuthProfileProviderForSelection,
      ).toHaveBeenCalledExactlyOnceWith({
        agentDir,
        profileId: selectedProfileId,
      });
      expect(authProfileStoreMock.resolveAuthProfileProviderForSelection).not.toHaveBeenCalled();
      expect(sessionPersistenceMocks.patchSessionEntryCore).not.toHaveBeenCalled();
      expect(sessionPersistenceMocks.persistReplySessionEntry).not.toHaveBeenCalled();
    });

    it.each([
      { source: "auto" as const, compactionCount: undefined, selectedProvider: "openai" },
      { source: undefined, compactionCount: 2, selectedProvider: "openai" },
      { source: "user" as const, compactionCount: undefined, selectedProvider: "anthropic" },
    ])("clears unavailable $source pins for $selectedProvider", async (params) => {
      const { sessionEntry, sessionStore, sessionKey } = await select({
        ...params,
        runtime: "openclaw",
        agentId: "main",
      });
      expect(sessionEntry.authProfileOverride).toBeUndefined();
      expect(sessionEntry.authProfileOverrideSource).toBeUndefined();
      expect(sessionEntry.authProfileOverrideCompactionCount).toBeUndefined();
      expect(sessionStore[sessionKey]).toEqual(sessionEntry);
      expect(authProfileStoreMock.store.profiles[configuredProfileId]).toBeDefined();
    });
  });
}
