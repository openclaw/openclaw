import { describe, expect, onTestFinished, test } from "vitest";
import type { ModelChoice } from "../../../packages/gateway-protocol/src/schema/agents-models-skills.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import * as sessionAccessor from "../../config/sessions/session-accessor.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  createChatMetadataHarness,
  createChatMetadataOwner,
} from "./chat-metadata-runtime.test-support.js";
import { projectSessionModelCatalog } from "./chat-metadata-session-projection.js";

const sol = { provider: "openai", id: "gpt-5.6-sol", name: "Sol" };
const luna = { provider: "openai", id: "gpt-5.6-luna", name: "Luna" };
const nativeConfig = (): OpenClawConfig => ({
  agents: { defaults: { model: { primary: "openai/gpt-5.6-sol" } }, entries: { main: {} } },
});
function nativeRegistry(
  harness: Partial<
    ReturnType<typeof createEmptyPluginRegistry>["agentHarnesses"][number]["harness"]
  >,
  id = "test-native",
) {
  const registry = createEmptyPluginRegistry();
  registry.agentHarnesses.push({
    pluginId: id,
    source: "test",
    harness: {
      id,
      label: "Native metadata owner",
      supports: () => ({ supported: true }),
      async runAttempt() {
        throw new Error("metadata must not start a model turn");
      },
      ...harness,
    },
  });
  return registry;
}

describe("gateway chat metadata native session ownership", () => {
  test("projects only ambient worker-owned auth failures as available", () => {
    const models = [sol, luna].map((model) =>
      Object.assign({}, model, { available: false, unavailableReason: "missing-auth" as const }),
    ) satisfies ModelChoice[];
    const scope = { agentId: "main", workerInference: "worker" as const };
    const project = (
      sessionEntry?: Parameters<typeof projectSessionModelCatalog>[0]["sessionEntry"],
      entries: ModelChoice[] = models,
    ) => projectSessionModelCatalog({ ...scope, sessionEntry }, entries, nativeConfig(), undefined);

    expect(project()).toEqual([sol, models[1]]);
    const cooldown: ModelChoice[] = [
      { ...models[0]!, unavailableReason: "cooldown", unavailableUntil: 123 },
    ];
    expect(project(undefined, cooldown)).toEqual(cooldown);
    expect(project({ modelOverride: "gpt-5.6-luna" })).toEqual(models);
    for (const authProfileOverrideSource of ["user", undefined, "user-link"] as const) {
      expect(
        project({
          authProfileOverride: "openai:personal",
          ...(authProfileOverrideSource ? { authProfileOverrideSource } : {}),
        }),
      ).toEqual(models);
    }
  });

  test.each([false, true])(
    "keeps runtime-only startup projections scoped to their provider (default model: %s)",
    async (defaultModel) => {
      const config: OpenClawConfig = {
        plugins: { entries: { copilot: { enabled: true } } },
        agents: {
          defaults: {
            model: { primary: "github-copilot/fixture-model" },
            models: { "github-copilot/fixture-model": { agentRuntime: { id: "openclaw" } } },
          },
          entries: { main: {} },
        },
      };
      const harness = createChatMetadataHarness(config, { useDefaultProjection: true });
      const registry = nativeRegistry({}, "copilot");
      harness.setOwner({
        ...createChatMetadataOwner(config, "fixture-model", {}, "github-copilot"),
        pluginRegistry: registry,
        metadataSnapshot: createPluginMetadataSnapshotFixture({
          plugins: [{ id: "github-copilot", providers: ["github-copilot"] }, { id: "copilot" }],
        }),
      });
      harness.setAuthStore({
        version: 1,
        profiles: {
          "github-copilot:work": {
            type: "token",
            provider: "github-copilot",
            token: "fixture-token",
          },
        },
      });
      const provider = defaultModel ? {} : { providerOverride: "github-copilot" };
      const native = { ...provider, agentRuntimeOverride: "copilot" };
      const host = { ...provider, agentRuntimeOverride: "openclaw" };
      const otherProvider = { providerOverride: "unrelated", agentRuntimeOverride: "copilot" };
      try {
        await harness.refresh();
        await expect(
          harness.startup({ sessionEntry: native, readPolicy: "ready" }),
        ).resolves.toBeUndefined();
        await harness.read();
        await harness.read({ sessionEntry: native });
        const nativeStartup = await harness.startup({ sessionEntry: native });
        expect((await harness.read({ sessionEntry: host })).models?.[0]?.agentRuntime?.id).toBe(
          "openclaw",
        );
        expect(
          (await harness.read({ sessionEntry: otherProvider })).models?.[0]?.agentRuntime?.id,
        ).toBe("openclaw");
        await expect(
          harness.startup({ sessionEntry: native, readPolicy: "ready" }),
        ).resolves.toEqual({
          sessionModelCatalog: nativeStartup?.sessionModelCatalog,
          defaultModelCatalog: nativeStartup?.defaultModelCatalog,
        });
        expect((await harness.read({ sessionEntry: native })).models?.[0]?.agentRuntime?.id).toBe(
          "copilot",
        );
      } finally {
        await harness.runtime.stop();
      }
    },
  );

  test("keeps native-owned model auth scoped across pending and materialized chat metadata", async () => {
    const config = nativeConfig();
    const harness = createChatMetadataHarness(config);
    const hostModels = [
      { ...sol, available: false, unavailableReason: "missing-auth" },
      { ...luna, available: false, unavailableReason: "cooldown", unavailableUntil: 123_456 },
    ];
    harness.buildProjection.mockResolvedValue({ modelCatalog: hostModels, models: hostModels });
    const sessionEntry: InternalSessionEntry = {
      sessionId: "native-metadata-session",
      updatedAt: 1,
      agentHarnessId: "test-native",
      modelSelectionLocked: true,
    };
    const request = {
      agentId: "main",
      sessionKey: "agent:main:harness:test-native:metadata",
      sessionEntry,
    };
    let boundSessionId = sessionEntry.sessionId;
    let ownership:
      | { model: "native"; auth: "native" | "host"; modelRef?: { provider: string; model: string } }
      | undefined = { model: "native", auth: "native" };
    const registry = nativeRegistry({
      resolveSessionRuntimeOwnership() {
        throw new Error("Chat metadata must use worker-owned ownership preparation");
      },
      resolveSessionRuntimeOwnershipAsync: async (params) => {
        params.assertCurrent();
        return params.sessionKey === request.sessionKey && params.sessionId === boundSessionId
          ? ownership
          : undefined;
      },
    });
    setActivePluginRegistry(registry);
    onTestFinished(resetPluginRuntimeStateForTest);
    await harness.refresh();
    const neutral = await harness.read();
    expect(neutral.models).toEqual(hostModels);

    const pending = await harness.read(request);
    expect(pending.runtimeSelectionLocked).toBe(true);
    expect(pending.models).toEqual([sol, hostModels[1]]);
    const history = await harness.startup({ ...request, readPolicy: "ready" });
    expect(history).not.toHaveProperty("metadata");
    expect(history?.sessionModelCatalog).toBe(hostModels);

    ownership = {
      model: "native",
      auth: "native",
      modelRef: { provider: "openai", model: "gpt-5.6-luna" },
    };
    sessionEntry.model = "gpt-5.6-luna";
    sessionEntry.modelProvider = "openai";
    const materialized = await harness.read(request);
    expect(materialized.models).toEqual([hostModels[0], luna]);
    expect(await harness.read()).toEqual(neutral);
    expect(hostModels[0]).toHaveProperty("available", false);
    expect(hostModels[1]).toHaveProperty("unavailableUntil", 123_456);

    // The same pin can retain native model ownership while requiring host auth.
    ownership = { ...ownership, auth: "host" };
    expect((await harness.read(request)).models).toEqual(hostModels);
    ownership = { ...ownership, auth: "native" };
    sessionEntry.pluginOwnerId = "test-native";
    expect((await harness.read(request)).models).toEqual(hostModels);
    delete sessionEntry.pluginOwnerId;
    boundSessionId = "replacement-session";
    expect((await harness.read(request)).models).toEqual(hostModels);
    boundSessionId = sessionEntry.sessionId;
    ownership = undefined;
    expect((await harness.read(request)).models).toEqual(hostModels);
    setActivePluginRegistry(createEmptyPluginRegistry());
    expect((await harness.read(request)).models).toEqual(hostModels);
  });

  test.each([
    { change: "same-id lineage mutation", expectedNative: true },
    { change: "physical session replacement", expectedNative: false },
  ])("resolves $change after metadata preparation", (scenario) =>
    withOpenClawTestState({ label: "metadata-native-lineage" }, async (state) => {
      const config = {
        ...nativeConfig(),
        session: { store: state.path("alternate", "sessions.json") },
      } satisfies OpenClawConfig;
      const harness = createChatMetadataHarness(config);
      const hostModels = [{ ...sol, available: false, unavailableReason: "missing-auth" }];
      const projection = { modelCatalog: hostModels, models: hostModels };
      harness.buildProjection.mockResolvedValue(projection);
      const initialPredecessor =
        scenario.change === "same-id lineage mutation" ? "old-predecessor" : "new-predecessor";
      const entry: InternalSessionEntry = {
        sessionId: "metadata-current",
        previousSessionId: initialPredecessor,
        updatedAt: 1,
        agentHarnessId: "test-native",
        modelSelectionLocked: true,
        authProfileOverride: "openai:fixture",
        authProfileOverrideSource: "user",
      };
      const target = {
        agentId: "main",
        sessionKey: "agent:main:harness:test-native:lineage",
        storePath: config.session.store,
      };
      const registry = nativeRegistry({
        resolveSessionRuntimeOwnershipAsync: async ({ readPreviousSessionId }) =>
          (await readPreviousSessionId?.()) === "new-predecessor"
            ? { model: "native", auth: "native" }
            : undefined,
      });
      const entered = createDeferred();
      const release = createDeferred();
      let pending: ReturnType<typeof harness.runtime.read> | undefined;
      try {
        setActivePluginRegistry(registry);
        await sessionAccessor.replaceSessionEntry(target, entry);
        await harness.refresh();
        harness.buildProjection.mockImplementationOnce(async () => {
          entered.resolve();
          await release.promise;
          return projection;
        });
        pending = harness.read({
          agentId: target.agentId,
          sessionKey: target.sessionKey,
          sessionEntry: entry,
        });
        await entered.promise;
        await sessionAccessor.patchSessionEntryCore(target, () =>
          scenario.change === "physical session replacement"
            ? { sessionId: "metadata-replacement" }
            : { previousSessionId: "new-predecessor" },
        );
        release.resolve();
        const result = await pending;
        expect(result.models).toEqual(scenario.expectedNative ? [sol] : hostModels);
        expect(entry).toMatchObject({
          sessionId: "metadata-current",
          previousSessionId: initialPredecessor,
        });
      } finally {
        release.resolve();
        await pending?.catch(() => undefined);
        try {
          await harness.runtime.stop();
        } finally {
          resetPluginRuntimeStateForTest();
        }
      }
    }),
  );
});
