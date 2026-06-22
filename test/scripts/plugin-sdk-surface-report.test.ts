// Plugin Sdk Surface Report tests cover plugin sdk surface report script behavior.
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

function runSurfaceReport(env: Record<string, string>) {
  return spawnSync(process.execPath, ["scripts/plugin-sdk-surface-report.mjs", "--check"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      ...env,
    },
  });
}

describe("plugin SDK surface report", () => {
  it("rejects loose numeric budget env vars before collecting SDK stats", () => {
    const result = runSurfaceReport({
      OPENCLAW_PLUGIN_SDK_MAX_PUBLIC_EXPORTS: "1e9",
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(
      "OPENCLAW_PLUGIN_SDK_MAX_PUBLIC_EXPORTS must be a non-negative integer",
    );
    expect(result.stderr).not.toContain("at ");
  });

  it("rejects unsafe budget env vars before collecting SDK stats", () => {
    const result = runSurfaceReport({
      OPENCLAW_PLUGIN_SDK_MAX_PUBLIC_EXPORTS: "9007199254740992",
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(
      "OPENCLAW_PLUGIN_SDK_MAX_PUBLIC_EXPORTS must be a safe non-negative integer",
    );
    expect(result.stderr).not.toContain("at ");
  });

  it("accepts exact deprecated export budget overrides by public entrypoint", () => {
    const result = runSurfaceReport({
      OPENCLAW_PLUGIN_SDK_MAX_PUBLIC_DEPRECATED_EXPORTS_BY_ENTRYPOINT: JSON.stringify({ core: 2 }),
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });

  it("keeps generated package declarations out of source surface counts", () => {
    const result = runSurfaceReport({
      OPENCLAW_PLUGIN_SDK_MAX_PUBLIC_FUNCTION_EXPORTS: "5173",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("public callable exports 5185 > 5173");
  });

  it("rejects deprecated export growth by public entrypoint", () => {
    const result = runSurfaceReport({
      OPENCLAW_PLUGIN_SDK_MAX_PUBLIC_DEPRECATED_EXPORTS_BY_ENTRYPOINT: JSON.stringify({ core: 1 }),
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("public deprecated exports in core 2 > 1");
  });
});
