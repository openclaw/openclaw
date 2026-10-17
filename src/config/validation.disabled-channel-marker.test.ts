// Verifies intentional disabled channel markers remain distinguishable from authored config.

import { describe, expect, it } from "vitest";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import { validateConfigObjectWithPlugins } from "./validation.js";

const emptyRegistry: PluginManifestRegistry = { diagnostics: [], plugins: [] };

function validate(raw: unknown) {
  return validateConfigObjectWithPlugins(raw, {
    pluginMetadataSnapshot: { manifestRegistry: emptyRegistry },
  });
}

describe("disabled channel marker validation", () => {
  it("warns instead of failing for an exact disabled unknown channel config", () => {
    const result = validate({
      agents: { list: [{ id: "openclaw" }] },
      channels: {
        "missing-chat": { enabled: false },
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.warnings).toContainEqual({
      path: "channels.missing-chat",
      message:
        "unknown channel id: missing-chat (disabled channel marker preserved; install the plugin to validate it)",
    });
  });

  it("keeps disabled unknown channel config with authored settings fatal", () => {
    const result = validate({
      agents: { list: [{ id: "openclaw" }] },
      channels: {
        "missing-chat": { enabled: false, token: "stale" },
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.issues.filter((issue) => issue.path === "channels.missing-chat")).toEqual([
      {
        path: "channels.missing-chat",
        message: "unknown channel id: missing-chat",
      },
    ]);
    expect(result.warnings.some((warning) => warning.path === "channels.missing-chat")).toBe(false);
  });
});
