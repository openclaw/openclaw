import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createScriptTestHarness } from "../scripts/test-helpers.js";

const scriptPath = path.join(
  process.cwd(),
  ".agents",
  "skills",
  "openclaw-secret-scanning-maintainer",
  "scripts",
  "secret-scanning.mjs",
);

const { createTempDir } = createScriptTestHarness();

function writeExecutable(filePath: string, contents: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, contents, { encoding: "utf8", mode: 0o755 });
}

describe("secret-scanning skill script", () => {
  it("supports a mock CLI smoke flow", () => {
    const binDir = createTempDir("openclaw-secret-scan-bin-");
    const fakeGhPath = path.join(binDir, "gh");

    writeExecutable(
      fakeGhPath,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        'printf \'%s\' \'{"id":321,"html_url":"https://github.com/openclaw/openclaw/issues/12#issuecomment-321"}\'',
      ].join("\n") + "\n",
    );

    const output = execFileSync(process.execPath, [scriptPath, "smoke"], {
      encoding: "utf8",
      env: {
        ...process.env,
        OPENCLAW_SECRET_SCAN_GH_BIN: fakeGhPath,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    expect(output).toContain('"ok":true');
    expect(output).toContain("## Secret Scanning Results");
    expect(output).toContain("comment redacted; author notified");
    expect(output).toContain("Issues requiring GitHub Support to purge edit history:");
  });
});
