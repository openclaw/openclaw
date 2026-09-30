import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe } from "vitest";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import { createMacScriptTest } from "./mac-script-fixture.test-support.js";

const it = createMacScriptTest();
const nodeDirectory = path.dirname(resolveTestNodeExecPath());

describe.runIf(process.platform === "darwin")("bundled SQLite library", () => {
  it.concurrent.for(["arm64", "x86_64", "universal", "wrong-checksum"])(
    "builds verified source into only the requested native slices: %s",
    (scenario, { mac, expect }) =>
      mac.lifetime.run(async () => {
        const root = mac.createTempDir("openclaw-sqlite-build-");
        const scripts = path.join(root, "scripts");
        const cache = path.join(root, "apps/macos/.build/sqlite/3.53.4");
        const source = path.join(root, "sqlite-amalgamation-3530400");
        const tools = path.join(root, "tools");
        const runtime = path.join(root, "runtime");
        for (const directory of [
          path.join(scripts, "lib"),
          cache,
          source,
          tools,
          path.join(runtime, "lib"),
        ]) {
          await mkdir(directory, { recursive: true });
        }
        await copyFile("scripts/build-mac-sqlite.sh", path.join(scripts, "build-mac-sqlite.sh"));
        // Compile an inert library through the real builder without downloading upstream code.
        await writeFile(
          path.join(source, "sqlite3.c"),
          'const char *sqlite3_libversion(void) { return "fixture"; }\n',
        );
        const archive = path.join(cache, "sqlite-amalgamation-3530400.zip");
        const zipped = await mac.run(
          "/usr/bin/zip",
          ["-q", archive, "sqlite-amalgamation-3530400/sqlite3.c"],
          { cwd: root },
        );
        expect(zipped.status).toBe(0);
        await writeFile(
          path.join(scripts, "lib/sqlite-macos.json"),
          JSON.stringify({
            version: "3.53.4",
            url: "https://sqlite.org/2026/sqlite-amalgamation-3530400.zip",
            sha256:
              scenario === "wrong-checksum"
                ? "0".repeat(64)
                : createHash("sha256")
                    .update(await readFile(archive))
                    .digest("hex"),
          }),
        );
        // A damaged cache must be downloaded and verified again before replacing the library.
        await writeFile(
          path.join(tools, "curl"),
          `#!/bin/bash
set -euo pipefail
while [[ "$#" -gt 0 ]]; do
  if [[ "$1" == --output ]]; then cp "$fixture_archive" "$2"; exit 0; fi
  shift
done
exit 2
`,
          { mode: 0o755 },
        );
        const library = path.join(runtime, "lib/libsqlite3.dylib");
        await writeFile(library, "previous library");
        const arch = scenario === "wrong-checksum" ? "arm64" : scenario;
        const result = await mac.run(
          "/bin/bash",
          [path.join(scripts, "build-mac-sqlite.sh"), arch, runtime],
          {
            encoding: "utf8",
            env: {
              PATH: `${tools}:${nodeDirectory}:/usr/bin:/bin`,
              TMPDIR: root,
              fixture_archive: archive,
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
        expect(slices.stdout.trim().split(/\s+/).sort()).toEqual(
          arch === "universal" ? ["arm64", "x86_64"] : [arch],
        );
        const installName = await mac.run("/usr/bin/otool", ["-D", library], { encoding: "utf8" });
        expect(installName.status).toBe(0);
        expect(installName.stdout).toContain("@loader_path/libsqlite3.dylib");
      }),
  );
});
