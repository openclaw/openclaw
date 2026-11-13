import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const SCRIPT = "scripts/mcp-events-test-server.mjs";

function runControl(args: string[]) {
  return spawnSync(process.execPath, [SCRIPT, "control", ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
}

for (const source of ["--json-file", "--json"] as const) {
  it(`reports malformed ${source} JSON without a traceback`, () => {
    const dir = tempDirs.make("openclaw-mcp-events-control-");
    const value = source === "--json-file" ? join(dir, "control.json") : "{not json";
    if (source === "--json-file") {
      writeFileSync(value, "{not json");
    }

    const result = runControl(["--url", "https://example.invalid/", source, value]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Failed to parse --json/--json-file JSON");
    expect(result.stderr).not.toMatch(/\n\s+at /);
  });
}
