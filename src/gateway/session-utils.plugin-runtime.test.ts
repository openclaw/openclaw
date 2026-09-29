import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveSessionStorePathCore, type SessionEntry } from "../config/sessions.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";

const normalize = vi.fn();
const manifests = vi.hoisted(() => vi.fn(() => ({ plugins: [], diagnostics: [] })));
const metadata = vi.hoisted(() => vi.fn());
vi.mock("../agents/provider-model-normalization.runtime.js", () => ({
  normalizeProviderModelIdWithRuntime: (params: unknown) => normalize(params),
}));
vi.mock("../plugins/current-plugin-metadata-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/current-plugin-metadata-snapshot.js")>()),
  getCurrentPluginMetadataSnapshot: metadata,
}));
vi.mock("../plugins/manifest-registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/manifest-registry.js")>()),
  loadPluginManifestRegistryCore: manifests,
}));
let sessionUtils: typeof import("./session-utils.js");
const model = "custom-provider/custom-legacy-model";
const cfg: OpenClawConfig = { agents: { defaults: { model: { primary: model } } } };

describe("gateway session list plugin runtime normalization", () => {
  beforeAll(async () => {
    vi.resetModules();
    const { createPluginMetadataSnapshotFixture } =
      await import("../plugins/plugin-metadata.test-support.js");
    metadata.mockReturnValue(createPluginMetadataSnapshotFixture());
    sessionUtils = await import("./session-utils.js");
  });
  beforeEach(() => {
    normalize
      .mockReset()
      .mockImplementation(
        ({ provider, context }: { provider?: string; context?: { modelId?: string } }) =>
          provider === "custom-provider" && context?.modelId === "custom-legacy-model"
            ? "custom-modern-model"
            : undefined,
      );
    manifests.mockClear();
  });

  it.each([true, false])(
    "preserves inherited persisted overrides (lightweight=%s)",
    (lightweight) => {
      const parent: SessionEntry = {
        sessionId: "parent",
        updatedAt: 1,
        providerOverride: "custom-provider",
        modelOverride: "custom-legacy-model",
        modelOverrideSource: "user",
        ...(lightweight ? {} : { modelOverrideRouteResolution: "resolved" as const }),
      };
      const child: SessionEntry = {
        sessionId: "child",
        updatedAt: 2,
        parentSessionKey: "agent:main:parent",
      };
      const row = sessionUtils.buildGatewaySessionRow({
        cfg: { agents: { defaults: { model: { primary: "openai/gpt-5.4" } } } },
        agentId: "main",
        storePath: "",
        key: "agent:main:child",
        entry: child,
        store: { "agent:main:parent": parent, "agent:main:child": child },
        lightweightListRow: lightweight,
      });
      expect(row).toMatchObject({ modelProvider: "custom-provider", model: "custom-legacy-model" });
      if (lightweight) {
        expect(normalize).not.toHaveBeenCalled();
      } else {
        expect(
          normalize.mock.calls.filter(([call]) => call.provider === "custom-provider"),
        ).toHaveLength(0);
      }
    },
  );

  it("keeps provider runtime normalization for raw detail rows", () => {
    const row = sessionUtils.buildGatewaySessionRow({
      cfg,
      agentId: "main",
      storePath: "",
      store: {},
      key: "main",
    });
    expect(row.model).toBe("custom-modern-model");
    expect(normalize).toHaveBeenCalled();
  });

  it("serves lifecycle and detail snapshots from the same prepared model facts", async () => {
    await withStateDirEnv("openclaw-lifecycle-row-plugin-runtime-", async () => {
      const runtime = await import("../config/config.js");
      runtime.resetConfigRuntimeState();
      runtime.setRuntimeConfigSnapshot(cfg, cfg);
      const key = "agent:main:lifecycle-plugin-runtime";
      const storePath = resolveSessionStorePathCore(cfg.session?.store, { agentId: "main" });
      await replaceSessionEntry(
        { sessionKey: key, storePath },
        { sessionId: "lifecycle-plugin-runtime", updatedAt: 1 },
      );
      const { createSessionRowProjection } = await import("./session-row-projection.js");
      const projection = await createSessionRowProjection({ cfg });
      try {
        await projection.ensureMaterialized();
        normalize.mockClear();
        manifests.mockClear();
        const lifecycle = projection.snapshot({ key, agentId: "main" });
        expect(lifecycle.row?.model).toBe("custom-modern-model");
        expect(
          projection.snapshot({ key, agentId: "main" }, { now: lifecycle.row?.snapshotAt }).row,
        ).toEqual(lifecycle.row);
        expect(normalize).not.toHaveBeenCalled();
        expect(manifests).not.toHaveBeenCalled();
      } finally {
        projection.dispose();
        runtime.resetConfigRuntimeState();
      }
    });
  });
});
