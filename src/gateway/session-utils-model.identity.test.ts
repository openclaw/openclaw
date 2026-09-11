import { afterEach, expect, test } from "vitest";
import { resolveSessionModelRef } from "../agents/session-model-ref.js";
import { resetConfigRuntimeState, setRuntimeConfigSnapshot } from "../config/config.js";
import type { SessionEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { withPluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import { applyModelOverrideToSessionEntry } from "../sessions/model-overrides.js";
import { resolveDirectStoredModelOverride } from "../sessions/stored-model-overrides.js";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import { listSessionFixture } from "./session-list.test-support.js";
import { getSessionDefaults, projectSessionPatchResult } from "./session-utils-model.js";
import {
  buildSessionListRowMetadataContext,
  resolveSessionSelectedModelRef,
} from "./session-utils-projection.js";
import { buildGatewaySessionRow } from "./session-utils-row.js";

afterEach(() => {
  resetConfigRuntimeState();
  resetPluginRuntimeStateForTest();
});

const identityConfig: OpenClawConfig = {
  plugins: { enabled: false },
  agents: { entries: { main: {} }, defaults: { model: "custom/default" } },
};
const identityMetadata = createPluginMetadataSnapshotFixture({
  plugins: [
    {
      id: "custom",
      providers: ["custom"],
      modelIdNormalization: {
        providers: { custom: { aliases: { latest: "middle", middle: "final" } } },
      },
    },
  ],
});

function writtenModelOverride(model: string): SessionEntry {
  const entry: SessionEntry = { sessionId: "written-model", updatedAt: 1 };
  applyModelOverrideToSessionEntry({ entry, selection: { provider: "custom", model } });
  return structuredClone(entry);
}

async function withIdentityScope(run: () => void): Promise<void> {
  await withStateDirEnv("session-override-identity-", async () =>
    withPluginRuntimeGenerationScope({ metadataSnapshot: identityMetadata }, run),
  );
}

test.each(["custom/model", "middle"])(
  "preserves writer-resolved model %s across readers",
  async (model) => {
    await withIdentityScope(() => {
      const entry = writtenModelOverride(model);
      const original = structuredClone(entry);
      expect(entry.modelOverrideRouteResolution).toBe("resolved");
      expect
        .soft(
          resolveDirectStoredModelOverride({
            sessionEntry: entry,
            defaultProvider: "custom",
            allowPluginNormalization: false,
          }),
        )
        .toMatchObject({ provider: "custom", model, routeResolution: "resolved" });
      expect
        .soft(
          resolveSessionModelRef(identityConfig, entry, "main", {
            allowPluginNormalization: false,
          }),
        )
        .toEqual({ provider: "custom", model });
      expect
        .soft(
          resolveSessionSelectedModelRef({
            cfg: identityConfig,
            agentId: "main",
            source: { entry, loadSessionEntry: () => undefined },
            allowPluginNormalization: false,
          }),
        )
        .toEqual({ provider: "custom", model, storedOverrideSource: "session" });
      expect(entry).toEqual(original);
    });
  },
);

test.each([false, true])(
  "separates cached raw and resolved selections (resolved first=%s)",
  async (resolvedFirst) => {
    await withIdentityScope(() => {
      const resolved = { entry: writtenModelOverride("middle"), model: "middle" };
      const raw = {
        entry: {
          sessionId: "raw-model",
          updatedAt: 1,
          providerOverride: "custom",
          modelOverride: "latest",
        },
        model: "final",
      };
      const rowContext = buildSessionListRowMetadataContext({ now: 1 });
      for (const { entry, model } of resolvedFirst ? [resolved, raw] : [raw, resolved]) {
        expect
          .soft(
            resolveSessionSelectedModelRef({
              cfg: identityConfig,
              agentId: "main",
              source: { entry, loadSessionEntry: () => undefined },
              rowContext,
              allowPluginNormalization: false,
            }),
          )
          .toEqual({ provider: "custom", model, storedOverrideSource: "session" });
      }
    });
  },
);

test.each([
  { provider: "demo-cli", model: "shared-model", expectedProvider: "demo-provider" },
  { provider: "standalone-cli", model: "shared-model", expectedProvider: "standalone-cli" },
  { provider: "demo-cli", model: "demo-provider/shared-model", expectedProvider: "demo-provider" },
  { provider: "demo-provider", model: "shared-model", expectedProvider: "demo-provider" },
])("keeps $provider/$model identity across session reads", async (fixture) => {
  await withStateDirEnv("session-model-identity-", async ({ stateDir }) => {
    const registry = createEmptyPluginRegistry();
    registry.cliBackends = [
      {
        pluginId: "fixture",
        source: "fixture",
        backend: {
          id: "demo-cli",
          modelProvider: "demo-provider",
          config: { command: "false", output: "text", input: "arg" },
        },
      },
      {
        pluginId: "fixture",
        source: "fixture",
        backend: {
          id: "standalone-cli",
          config: { command: "false", output: "text", input: "arg" },
        },
      },
    ];
    setActivePluginRegistry(registry);
    const selected = `${fixture.provider}/${fixture.model}`;
    const cfg: OpenClawConfig = {
      agents: {
        entries: { main: {} },
        defaults: {
          model: "unrelated/shared-model",
          models: { [selected]: { agentRuntime: { id: "openclaw" } } },
        },
      },
    };
    setRuntimeConfigSnapshot(cfg);
    const key = "agent:main:identity";
    const entry: SessionEntry = {
      sessionId: "identity",
      updatedAt: 1,
      providerOverride: fixture.provider,
      modelOverride: fixture.model,
      modelOverrideRouteResolution: "resolved",
    };
    const store = { [key]: entry };
    const expected = { modelProvider: fixture.expectedProvider, model: "shared-model" };
    for (const lightweightListRow of [false, true]) {
      const row = buildGatewaySessionRow({
        cfg,
        agentId: "main",
        storePath: stateDir,
        store,
        key,
        entry,
        lightweightListRow,
        skipTranscriptUsageFallback: true,
      });
      expect(row).toMatchObject(expected);
      expect(row.agentRuntime?.id).toBe("openclaw");
    }
    expect(
      projectSessionPatchResult({
        cfg,
        canonicalKey: key,
        entry,
        targetAgentId: "main",
        storePath: stateDir,
      }).resolved,
    ).toMatchObject({ ...expected, agentRuntime: { id: "openclaw" } });
    const listed = await listSessionFixture({
      cfg,
      storePath: stateDir,
      store,
      opts: { agentId: "main", search: `${fixture.expectedProvider}/shared-model` },
    });
    expect(listed.sessions).toMatchObject([{ key, ...expected }]);
    const defaultConfig: OpenClawConfig = {
      ...cfg,
      agents: { ...cfg.agents, defaults: { ...cfg.agents?.defaults, model: selected } },
    };
    expect(getSessionDefaults(defaultConfig, [], { agentId: "main" })).toMatchObject(expected);
  });
});
