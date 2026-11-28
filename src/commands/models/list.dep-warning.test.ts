import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiKeyCredential } from "../../agents/auth-profiles/credential-fixtures.test-support.js";
import { makePluginLoaderTempDir } from "../../plugins/loader.test-fixtures.js";
import { resolveProviderAuthOverview } from "./list.auth-overview.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

// Mirrors the channels/agents list regressions (#190257): the sync display resolver
// emitted DEP_PLUGIN_SDK whenever a stored profile needed its auth store display path.
describe("models auth overview deprecation warnings", () => {
  it("emits no DEP_PLUGIN_SDK warning for stored profiles", async () => {
    vi.stubEnv("OPENCLAW_STATE_DIR", makePluginLoaderTempDir());
    const emitted: { code?: string; message: string }[] = [];
    const onWarning = (warning: Error & { code?: string }) =>
      emitted.push({ code: warning.code, message: warning.message });
    const emitWarning = vi.spyOn(process, "emitWarning");
    // Deprecations are process-wide deduped; reset the budget so this path is observable.
    (globalThis as unknown as Record<symbol, Set<string>>)[
      Symbol.for("openclaw.pluginSdkDeprecations")
    ]?.clear();
    process.on("warning", onWarning);

    try {
      const overview = await resolveProviderAuthOverview({
        provider: "openai",
        cfg: {},
        store: {
          version: 1,
          profiles: { "openai:default": createApiKeyCredential("openai", "sk-synthetic") },
        },
        modelsPath: "/tmp/synthetic/models.json",
        agentDir: "/tmp/synthetic/agent",
      });
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });

      expect(overview.effective.kind).toBe("profiles");
    } finally {
      process.off("warning", onWarning);
    }

    const emittedCodes = emitWarning.mock.calls.map(
      ([, options]) => (options as { code?: string } | undefined)?.code,
    );
    expect(emittedCodes).not.toContain("DEP_PLUGIN_SDK");
    expect(emitted.filter((warning) => warning.code === "DEP_PLUGIN_SDK")).toEqual([]);
  });
});
