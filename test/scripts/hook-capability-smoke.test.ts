import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const SCRIPT_PATH = "scripts/hook-capability-smoke.mjs";

describe("scripts/hook-capability-smoke.mjs", () => {
  it("is wired into the root package scripts", () => {
    const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
    expect(packageJson.scripts["smoke:hook-capability"]).toBe(`node ${SCRIPT_PATH}`);
  });

  it("reports dry-run parity status without needing to execute Vitest", () => {
    const result = spawnSync(process.execPath, [SCRIPT_PATH, "--json", "--skip-tests"], {
      cwd: process.cwd(),
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");

    const report = JSON.parse(result.stdout);
    expect(report).toMatchObject({
      ok: true,
      testResult: {
        skipped: true,
        ok: true,
        command: "not run",
        status: 0,
      },
    });
    expect(report.sourceChecks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "plugin shape inspection keeps typed hooks separate from explicit capabilities",
          ok: true,
          file: "src/plugins/inspect-shape.ts",
        }),
        expect.objectContaining({
          name: "Codex native PreToolUse relay has a blocking parity test",
          ok: true,
          file: "src/agents/harness/native-hook-relay.test.ts",
        }),
        expect.objectContaining({
          name: "Codex native PostToolUse relay has an observation parity test",
          ok: true,
          file: "src/agents/harness/native-hook-relay.test.ts",
        }),
        expect.objectContaining({
          name: "OpenClaw-owned Pi tools have fail-closed before_tool_call coverage",
          ok: true,
          file: "src/agents/openclaw-owned-tool-runtime-contract.test.ts",
        }),
        expect.objectContaining({
          name: "Codex dynamic tools have fail-closed before_tool_call coverage",
          ok: true,
          file: "extensions/codex/src/app-server/openclaw-owned-tool-runtime-contract.test.ts",
        }),
      ]),
    );
  });
});
