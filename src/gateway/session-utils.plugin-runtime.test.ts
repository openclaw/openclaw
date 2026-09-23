/**
 * Tests session utility interactions with plugin runtime state.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveSessionStorePathCore, type SessionEntry } from "../config/sessions.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";

const normalizeProviderModelIdWithPluginMock = vi.fn();
const loadPluginManifestRegistryCoreMock = vi.hoisted(() =>
  vi.fn(() => ({ plugins: [], diagnostics: [] })),
);
const getCurrentPluginMetadataSnapshotMock = vi.hoisted(() => vi.fn());

vi.mock("../agents/provider-model-normalization.runtime.js", () => ({
  normalizeProviderModelIdWithRuntime: (params: unknown) =>
    normalizeProviderModelIdWithPluginMock(params),
}));

vi.mock("../plugins/current-plugin-metadata-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/current-plugin-metadata-snapshot.js")>()),
  getCurrentPluginMetadataSnapshot: getCurrentPluginMetadataSnapshotMock,
}));

vi.mock("../plugins/manifest-registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/manifest-registry.js")>()),
  loadPluginManifestRegistryCore: loadPluginManifestRegistryCoreMock,
}));

let sessionUtils: typeof import("./session-utils.js");
let createSessionRowProjectionFixture: (typeof import("./session-row-projection.test-support.js"))["createSessionRowProjectionFixture"];
let listProjectedSessions: (typeof import("./session-utils-list.js"))["listProjectedSessions"];

describe("gateway session list plugin runtime normalization", () => {
  beforeAll(async () => {
    vi.resetModules();
    const { createPluginMetadataSnapshotFixture } =
      await import("../plugins/plugin-metadata.test-support.js");
    getCurrentPluginMetadataSnapshotMock.mockReturnValue(createPluginMetadataSnapshotFixture());
    sessionUtils = await import("./session-utils.js");
    ({ createSessionRowProjectionFixture } =
      await import("./session-row-projection.test-support.js"));
    ({ listProjectedSessions } = await import("./session-utils-list.js"));
  });

  beforeEach(() => {
    normalizeProviderModelIdWithPluginMock.mockReset();
    loadPluginManifestRegistryCoreMock.mockClear();
  });

  it("does not normalize provider models while selecting prepared list rows", async () => {
    const cfg = {
      agents: {
        defaults: { model: { primary: "custom-provider/custom-legacy-model" } },
      },
    } as OpenClawConfig;
    const store = Object.fromEntries(
      Array.from({ length: 3 }, (_value, index) => [
        `session-${index}`,
        { sessionId: `session-${index}`, updatedAt: 1_000 - index } satisfies SessionEntry,
      ]),
    );

    const projection = createSessionRowProjectionFixture({ cfg, store, agentId: "main" });
    try {
      normalizeProviderModelIdWithPluginMock.mockClear();
      const listed = await listProjectedSessions({ projection, opts: {} });
      expect(listed.sessions.map((session) => session.model)).toEqual([
        "custom-legacy-model",
        "custom-legacy-model",
        "custom-legacy-model",
      ]);
      expect(normalizeProviderModelIdWithPluginMock).not.toHaveBeenCalled();
    } finally {
      projection.dispose();
    }
  });

  it.each([
    { name: "direct", parentSessionKey: undefined },
    { name: "inherited", parentSessionKey: "agent:main:parent" },
  ])(
    "skips provider runtime normalization for $name persisted overrides",
    ({ parentSessionKey }) => {
      normalizeProviderModelIdWithPluginMock.mockImplementation(
        ({ provider, context }: { provider?: string; context?: { modelId?: string } }) =>
          provider === "custom-provider" && context?.modelId === "custom-legacy-model"
            ? "custom-modern-model"
            : undefined,
      );
      const cfg = {
        agents: { defaults: { model: { primary: "openai/gpt-5.4" } } },
      } as OpenClawConfig;
      const selectedEntry: SessionEntry = {
        sessionId: parentSessionKey ? "parent" : "child",
        updatedAt: 1,
        providerOverride: "custom-provider",
        modelOverride: "custom-legacy-model",
        modelOverrideSource: "user",
      };
      const childEntry: SessionEntry = {
        sessionId: "child",
        updatedAt: 2,
        ...(parentSessionKey ? { parentSessionKey } : selectedEntry),
      };
      const store = parentSessionKey
        ? { [parentSessionKey]: selectedEntry, "agent:main:child": childEntry }
        : { "agent:main:child": childEntry };

      const row = sessionUtils.buildGatewaySessionRow({
        cfg,
        agentId: "main",
        storePath: "",
        store,
        key: "agent:main:child",
        entry: childEntry,
        lightweightListRow: true,
      });

      expect(row.modelProvider).toBe("custom-provider");
      expect(row.model).toBe("custom-legacy-model");
      expect(normalizeProviderModelIdWithPluginMock).not.toHaveBeenCalled();
    },
  );

  it.each([
    { name: "direct", parentSessionKey: undefined },
    { name: "inherited", parentSessionKey: "agent:main:parent" },
  ])("does not re-normalize $name resolved overrides in detail rows", ({ parentSessionKey }) => {
    normalizeProviderModelIdWithPluginMock.mockImplementation(
      ({ provider, context }: { provider?: string; context?: { modelId?: string } }) =>
        provider === "custom-provider" && context?.modelId === "custom-legacy-model"
          ? "custom-modern-model"
          : undefined,
    );
    const cfg = {
      agents: { defaults: { model: { primary: "openai/gpt-5.4" } } },
    } as OpenClawConfig;
    const selectedEntry: SessionEntry = {
      sessionId: parentSessionKey ? "parent" : "child",
      updatedAt: 1,
      providerOverride: "custom-provider",
      modelOverride: "custom-legacy-model",
      modelOverrideSource: "user",
      modelOverrideRouteResolution: "resolved",
    };
    const childEntry: SessionEntry = {
      sessionId: "child",
      updatedAt: 2,
      ...(parentSessionKey ? { parentSessionKey } : selectedEntry),
    };
    const store = parentSessionKey
      ? { [parentSessionKey]: selectedEntry, "agent:main:child": childEntry }
      : { "agent:main:child": childEntry };

    const row = sessionUtils.buildGatewaySessionRow({
      cfg,
      agentId: "main",
      storePath: "",
      store,
      key: "agent:main:child",
      entry: childEntry,
    });

    expect(row.modelProvider).toBe("custom-provider");
    expect(row.model).toBe("custom-legacy-model");
    expect(
      normalizeProviderModelIdWithPluginMock.mock.calls.filter(
        ([call]) => (call as { provider?: string }).provider === "custom-provider",
      ),
    ).toHaveLength(0);
  });

  it("keeps provider runtime normalization for raw detail rows", async () => {
    normalizeProviderModelIdWithPluginMock.mockImplementation(
      ({ provider, context }: { provider?: string; context?: { modelId?: string } }) => {
        if (provider === "custom-provider" && context?.modelId === "custom-legacy-model") {
          return "custom-modern-model";
        }
        return undefined;
      },
    );

    const cfg = {
      agents: {
        defaults: { model: { primary: "custom-provider/custom-legacy-model" } },
      },
    } as OpenClawConfig;

    const row = sessionUtils.buildGatewaySessionRow({
      cfg,
      agentId: "main",
      storePath: "",
      store: {},
      key: "main",
    });

    expect(row.model).toBe("custom-modern-model");
    expect(normalizeProviderModelIdWithPluginMock).toHaveBeenCalled();
  });

  it("serves lifecycle and detail snapshots from the same prepared model facts", async () => {
    await withStateDirEnv("openclaw-lifecycle-row-plugin-runtime-", async () => {
      normalizeProviderModelIdWithPluginMock.mockImplementation(
        ({ provider, context }: { provider?: string; context?: { modelId?: string } }) =>
          provider === "custom-provider" && context?.modelId === "custom-legacy-model"
            ? "custom-modern-model"
            : undefined,
      );
      const cfg = {
        agents: {
          defaults: { model: { primary: "custom-provider/custom-legacy-model" } },
        },
      } as OpenClawConfig;
      const configRuntime = await import("../config/config.js");
      configRuntime.resetConfigRuntimeState();
      configRuntime.setRuntimeConfigSnapshot(cfg, cfg);
      const sessionKey = "agent:main:lifecycle-plugin-runtime";
      const storePath = resolveSessionStorePathCore(cfg.session?.store, { agentId: "main" });
      await replaceSessionEntry({ sessionKey, storePath }, {
        sessionId: "lifecycle-plugin-runtime",
        updatedAt: 1,
      } satisfies SessionEntry);

      const { createSessionRowProjection } = await import("./session-row-projection.js");
      const projection = await createSessionRowProjection({ cfg });
      try {
        await projection.ensureMaterialized();
        normalizeProviderModelIdWithPluginMock.mockClear();
        loadPluginManifestRegistryCoreMock.mockClear();
        const lifecycle = projection.snapshot({ key: sessionKey, agentId: "main" });
        expect(lifecycle.row?.model).toBe("custom-modern-model");
        expect(
          projection.snapshot(
            { key: sessionKey, agentId: "main" },
            { now: lifecycle.row?.snapshotAt },
          ).row,
        ).toEqual(lifecycle.row);
        expect(normalizeProviderModelIdWithPluginMock).not.toHaveBeenCalled();
        expect(loadPluginManifestRegistryCoreMock).not.toHaveBeenCalled();
      } finally {
        projection.dispose();
      }
      configRuntime.resetConfigRuntimeState();
    });
  });
});
