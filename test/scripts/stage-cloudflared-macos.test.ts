import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import * as tar from "tar";
import { afterEach, expect, it } from "vitest";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const testNodeExecPath = resolveTestNodeExecPath();
const digest = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");

it
  .runIf(process.platform === "darwin")
  .each(["arm64", "x86_64", "wrong-architecture", "wrong-checksum"])(
  "verifies cached and downloaded payloads before staging: %s",
  async (scenario) => {
    const root = tempDirs.make("openclaw-cloudflared-stage-");
    const write = (relative: string, content: string | Buffer, mode = 0o644) => {
      const absolute = path.join(root, relative);
      mkdirSync(path.dirname(absolute), { recursive: true });
      writeFileSync(absolute, content, { mode });
      return absolute;
    };
    const arch = scenario === "x86_64" ? "x86_64" : "arm64";
    const scriptFile = "scripts/stage-cloudflared-macos.sh";
    const script = write(scriptFile, readFileSync(scriptFile));
    // lipo reads the actual Mach-O architecture; the inert fixture is never executed.
    const binary = Buffer.alloc(32);
    const x64 = arch === "x86_64" || scenario === "wrong-architecture";
    [0xfeedfacf, x64 ? 0x01000007 : 0x0100000c, x64 ? 3 : 0, 2].forEach((value, index) =>
      binary.writeUInt32LE(value, index * 4),
    );
    const fixture = path.dirname(write("fixture/cloudflared", binary));
    const asset = `cloudflared-darwin-${arch === "arm64" ? "arm64" : "amd64"}.tgz`;
    const license = "Cloudflared license fixture\n";
    const cache = path.dirname(write("apps/macos/.build/cloudflared/2026.8.3/LICENSE", license));
    const archive = path.join(cache, asset);
    await tar.c({ file: archive, gzip: true, cwd: fixture }, ["cloudflared"]);
    const sha256 = scenario === "wrong-checksum" ? "0".repeat(64) : digest(readFileSync(archive));
    write(
      "scripts/lib/cloudflared-macos.json",
      JSON.stringify({
        version: "2026.8.3",
        licenseSha256: digest(license),
        artifacts: { [arch]: { asset, sha256 } },
      }),
    );
    // A corrupt cache must be downloaded and checked again, never copied into the app.
    const curl = write(
      "tools/curl",
      `#!/bin/bash
set -euo pipefail
while [[ "$#" -gt 0 ]]; do
  if [[ "$1" == --output ]]; then cp "$fixture_archive" "$2"; exit 0; fi
  shift
done
exit 2
`,
      0o755,
    );
    const staged = write(`resources/cloudflared/${arch}/cloudflared`, "previous helper");
    const destination = path.dirname(path.dirname(staged));
    const result = spawnSync("/bin/bash", [script, arch, destination], {
      encoding: "utf8",
      env: {
        PATH: `${path.dirname(curl)}:${path.dirname(testNodeExecPath)}:/usr/bin:/bin`,
        TMPDIR: root,
        fixture_archive: archive,
      },
    });
    if (scenario.startsWith("wrong-")) {
      expect(result.status).not.toBe(0);
      expect(readFileSync(staged, "utf8")).toBe("previous helper");
      expect(result.stderr).toContain(
        scenario === "wrong-checksum" ? "sha256 mismatch" : "expected arm64 executable",
      );
    } else {
      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(staged)).toEqual(binary);
      expect(statSync(staged).mode & 0o777).toBe(0o755);
      expect(readFileSync(path.join(destination, "LICENSE"), "utf8")).toBe(license);
      const manifest = JSON.parse(readFileSync(path.join(destination, "manifest.json"), "utf8"));
      expect(manifest).toMatchObject({ version: "2026.8.3" });
    }
  },
);
