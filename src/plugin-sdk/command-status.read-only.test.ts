/** Direct status must inspect pinned sessions without changing their saved selections. */
import "../test-utils/prepare-compiled-subprocesses.js";
import { describe, expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.sqlite-entry.js";
import { loadExactSessionEntryReadOnly } from "../config/sessions/session-accessor.sqlite-exact-read.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { resolveDirectStatusReplyForSessionCore } from "./command-status.runtime.js";

// mock-isolation: Keep native plugin credentials and external CLI accounts outside this fixture.
vi.mock("../agents/auth-profiles.runtime.js", async () => {
  const { createExternalAuthRuntime } = await import("../agents/auth-profiles/external-auth.js");
  const { createAuthProfileStoreRuntime } = await import("../agents/auth-profiles/store.js");
  const runtime = createAuthProfileStoreRuntime(
    createExternalAuthRuntime(
      () => [],
      async (_params, run) => run(),
    ),
  );
  return {
    ensureAuthProfileStoreAsync: runtime.ensureAuthProfileStoreWithoutExternalProfilesAsync,
    prepareAuthProfileProvider: runtime.prepareAuthProfileProvider,
  };
});

// mock-isolation: Render auth labels from the real owned credential store without native CLI overlays.
vi.mock("../agents/auth-profiles/store-runtime.js", async () => {
  const { createExternalAuthRuntime } = await import("../agents/auth-profiles/external-auth.js");
  const { createAuthProfileStoreRuntime } = await import("../agents/auth-profiles/store.js");
  const runtime = createAuthProfileStoreRuntime(
    createExternalAuthRuntime(
      () => [],
      async (_params, run) => run(),
    ),
  );
  return {
    ...runtime,
    ensureAuthProfileStoreAsync: runtime.ensureAuthProfileStoreWithoutExternalProfilesAsync,
  };
});

vi.mock("../infra/provider-usage.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/provider-usage.js")>()),
  loadProviderUsageSummary: async () => ({ updatedAt: 1, providers: [] }),
}));

// mock-isolation: Model discovery is external I/O; selection and its live identity guard stay real.
vi.mock("../agents/model-catalog.runtime.js", () => ({
  loadPreparedModelCatalogSnapshot: async () => ({ entries: [], authoritative: true }),
  loadProviderScopedThinkingCatalog: async () => [],
}));

vi.mock("../plugins/current-plugin-metadata-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/current-plugin-metadata-snapshot.js")>()),
  getCurrentPluginMetadataSnapshot: () => createPluginMetadataSnapshotFixture(),
}));

const model = "claude-opus-4-6";
const sessionKey = "agent:main:primary";
const cfg: OpenClawConfig = {
  agents: {
    ownership: "explicit",
    entries: { main: {} },
    defaults: {
      model: { primary: `anthropic/${model}` },
      models: { [`anthropic/${model}`]: {} },
      thinkingDefault: "off",
      reasoningDefault: "off",
    },
  },
  session: { mainKey: "primary" },
};

describe("direct status selection is read-only", () => {
  it.each([
    { source: "auto", available: true },
    { source: "auto", available: false },
    { source: "user", available: true },
    { source: "user", available: false },
  ] as const)(
    "renders an $source auth pin (available=$available) without changing it",
    async ({ source, available }) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        await state.writeConfig(cfg);
        setRuntimeConfigSnapshot(cfg);
        await state.writeAuthProfiles({
          version: 1,
          profiles: available
            ? {
                "anthropic:status": {
                  type: "api_key",
                  provider: "anthropic",
                  key: "synthetic-status-key",
                },
              }
            : {},
        });
        const target = { agentId: "main", sessionKey, env: state.env };
        replaceSessionEntrySync(target, {
          sessionId: "status-pinned-session",
          updatedAt: 1,
          modelProvider: "anthropic",
          model,
          authProfileOverride: "anthropic:status",
          authProfileOverrideSource: source,
        });
        const before = loadExactSessionEntryReadOnly(target)?.entry;
        expect(before?.authProfileOverride).toBe("anthropic:status");

        const result = await resolveDirectStatusReplyForSessionCore({
          cfg,
          sessionKey: "main",
          channel: "discord",
          senderIsOwner: true,
          isAuthorizedSender: true,
          isGroup: false,
          defaultGroupActivation: () => "mention",
        });

        expect(result?.text).toContain(`🧠 Model: anthropic/${model}`);
        expect(result?.text).toContain(`🧵 Session: ${sessionKey}`);
        expect(loadExactSessionEntryReadOnly(target)?.entry).toEqual(before);
      });
    },
  );

  it("does not reset a disallowed saved model while rendering status", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      await state.writeConfig(cfg);
      setRuntimeConfigSnapshot(cfg);
      const target = { agentId: "main", sessionKey, env: state.env };
      replaceSessionEntrySync(target, {
        sessionId: "status-model-session",
        updatedAt: 1,
        modelProvider: "anthropic",
        model,
        providerOverride: "anthropic",
        modelOverride: "no-longer-allowed-model",
        modelOverrideSource: "user",
      });
      const before = loadExactSessionEntryReadOnly(target)?.entry;
      expect(before?.modelOverride).toBe("no-longer-allowed-model");

      const result = await resolveDirectStatusReplyForSessionCore({
        cfg,
        sessionKey: "main",
        channel: "discord",
        senderIsOwner: true,
        isAuthorizedSender: true,
        isGroup: false,
        defaultGroupActivation: () => "mention",
      });

      expect(result?.text).toContain("anthropic/no-longer-allowed-model");
      expect(result?.text).toContain(`🧵 Session: ${sessionKey}`);
      expect(loadExactSessionEntryReadOnly(target)?.entry).toEqual(before);
    });
  });
});
