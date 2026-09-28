import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { runCliProcessChild } from "../../src/cli/cli-process-child.test-helpers.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

// The E2E lane prepares the built CLI before starting test workers.
describe("Doctor JSON runtime failures", () => {
  it("owns JSON runtime failures before findings at the built CLI entrypoint", async () => {
    const root = tempDirs.make("openclaw-doctor-json-error-");
    const entry = pathToFileURL(path.resolve("dist/entry.js"));
    const health = new URL("./plugin-sdk/health.js", entry);
    const token = "fixture-secret-1234567890";
    const preload = `
      import { registerHealthCheck } from ${JSON.stringify(health.href)};
      registerHealthCheck({
        id: ${JSON.stringify(`core/doctor/collision?token=${token}`)},
        kind: "plugin", description: "Synthetic collision",
        async detect() { return []; },
      });
    `;
    const result = await runCliProcessChild({
      nodeArgs: [
        "--import",
        `data:text/javascript,${encodeURIComponent(preload)}`,
        fileURLToPath(entry),
        "doctor",
        "--lint",
        "--json",
      ],
      cwd: root,
      env: {
        PATH: path.dirname(process.execPath),
        HOME: root,
        USERPROFILE: root,
        OPENCLAW_HOME: root,
        OPENCLAW_STATE_DIR: path.join(root, "state"),
        OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
        OPENCLAW_NO_RESPAWN: "1",
        NODE_DISABLE_COMPILE_CACHE: "1",
        NO_COLOR: "1",
      },
    });

    const message = expect.stringContaining(
      "health check already registered: core/doctor/collision",
    );
    expect(JSON.parse(result.stdout)).toEqual({
      schemaVersion: 1,
      ok: false,
      checksRun: 0,
      checksSkipped: 0,
      findings: [
        {
          checkId: "core/doctor/lint-inspection",
          severity: "error",
          source: "doctor",
          message,
          fixHint: "Resolve this inspection error, then rerun `openclaw doctor --lint`.",
        },
      ],
      error: {
        type: "cli_error",
        message,
      },
    });
    expect(result.stdout).not.toContain(token);
    expect(result.signal).toBeNull();
    expect(result.code, result.stderr).toBe(2);
    expect(result.stderr).toBe("");
  });
});
