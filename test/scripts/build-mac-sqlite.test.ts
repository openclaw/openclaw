import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe } from "vitest";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import { makeStoredZip } from "./actions-artifact-zip.test-support.js";
import { createMacScriptTest } from "./mac-script-fixture.test-support.js";

const it = createMacScriptTest();
const nodeDirectory = path.dirname(resolveTestNodeExecPath());

describe.runIf(process.platform === "darwin")("bundled SQLite library", () => {
  it.concurrent.for(["arm64", "x86_64", "universal", "wrong-checksum"])(
    "builds verified source into only the requested native slices: %s",
    (scenario, { mac, expect }) =>
      mac.lifetime.run(async () => {
        const root = mac.createTempDir("openclaw-sqlite-build-");
        const at = (file: string) => path.join(root, file);
        const write = async (file: string, data: string | Uint8Array, mode?: number) => {
          await mkdir(path.dirname(at(file)), { recursive: true });
          await writeFile(at(file), data, { mode });
        };
        const archive = "apps/macos/.build/sqlite/3.53.4/sqlite-amalgamation-3530400.zip";
        // Compile an inert library through the real builder without downloading upstream code.
        await write(
          archive,
          makeStoredZip({
            "sqlite-amalgamation-3530400/sqlite3.c":
              'const char *sqlite3_libversion(void) { return "fixture"; }\n',
          }),
        );
        await write(
          "scripts/lib/sqlite-macos.json",
          JSON.stringify({
            version: "3.53.4",
            url: "https://sqlite.org/2026/sqlite-amalgamation-3530400.zip",
            sha256:
              scenario === "wrong-checksum"
                ? "0".repeat(64)
                : createHash("sha256")
                    .update(await readFile(at(archive)))
                    .digest("hex"),
          }),
        );
        await copyFile("scripts/build-mac-sqlite.sh", at("scripts/build-mac-sqlite.sh"));
        // A damaged cache must be downloaded and verified again before replacing the library.
        await write(
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
        const library = at("runtime/lib/libsqlite3.dylib");
        await write("runtime/lib/libsqlite3.dylib", "previous library");
        const arch = scenario === "wrong-checksum" ? "arm64" : scenario;
        const result = await mac.run(
          "/bin/bash",
          [at("scripts/build-mac-sqlite.sh"), arch, at("runtime")],
          {
            encoding: "utf8",
            env: {
              PATH: `${at("tools")}:${nodeDirectory}:/usr/bin:/bin`,
              TMPDIR: root,
              fixture_archive: at(archive),
            },
          },
        );
        if (scenario === "wrong-checksum") {
          expect(result.status).not.toBe(0);
          expect(result.stderr).toContain("sha256 mismatch");
          expect(await readFile(library, "utf8")).toBe("previous library");
          return;
        }
        expect(result.status, result.stderr).toBe(0);
        const slices = await mac.run("/usr/bin/lipo", ["-archs", library], { encoding: "utf8" });
        expect(slices.status).toBe(0);
        expect(slices.stdout.trim().split(/\s+/).toSorted()).toEqual(
          arch === "universal" ? ["arm64", "x86_64"] : [arch],
        );
        const installName = await mac.run("/usr/bin/otool", ["-D", library], { encoding: "utf8" });
        expect(installName.status).toBe(0);
        expect(installName.stdout).toContain("@loader_path/libsqlite3.dylib");
      }),
  );
});
