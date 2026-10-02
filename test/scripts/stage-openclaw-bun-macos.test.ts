import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { hasNodeErrorCode } from "@openclaw/fs-safe/path";
import { describe } from "vitest";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import { runMacFixtureTool } from "./mac-native-fixtures.test-support.js";
import { createMacScriptTest, type MacScriptFixture } from "./mac-script-fixture.test-support.js";

const it = createMacScriptTest();
const nodeDirectory = path.dirname(resolveTestNodeExecPath());
const hostArch = process.arch === "arm64" ? "arm64" : "x86_64";
const otherArch = hostArch === "arm64" ? "x86_64" : "arm64";
const commit = "0123456789012345678901234567890123456789";
const revision = "fixture+012345678";
const digest = (data: Buffer) => createHash("sha256").update(data).digest("hex");
type Arch = "arm64" | "x86_64";
let compiled: Promise<Record<Arch, Buffer>> | undefined;

function revisionExecutables(root: string, mac: MacScriptFixture) {
  // Share only completed bytes: no case borrows another case's temporary paths.
  compiled ??= mac.lifetime.run(async () => {
    const source = path.join(root, "revision.c");
    const universal = path.join(root, "revision-universal");
    await writeFile(
      source,
      `#include <stdio.h>
#include <string.h>
int main(int argc, char **argv) {
  if (argc == 2 && strcmp(argv[1], "--revision") == 0) { puts("${revision}"); return 0; }
  if (argc == 3 && strcmp(argv[1], "-p") == 0 && strcmp(argv[2], "Bun.revision") == 0) { puts("${commit}"); return 0; }
  return 2;
}
`,
    );
    await runMacFixtureTool(
      "/usr/bin/xcrun",
      ["clang", "-arch", "arm64", "-arch", "x86_64", source, "-o", universal],
      root,
      mac,
    );
    const paths = {
      arm64: path.join(root, "revision-arm64"),
      x86_64: path.join(root, "revision-x86_64"),
    };
    for (const arch of ["arm64", "x86_64"] as const) {
      await runMacFixtureTool(
        "/usr/bin/lipo",
        [universal, "-thin", arch, "-output", paths[arch]],
        root,
        mac,
      );
    }
    return { arm64: await readFile(paths.arm64), x86_64: await readFile(paths.x86_64) };
  });
  return compiled;
}

describe.runIf(process.platform === "darwin")("OpenClaw Bun runtime staging", () => {
  it.concurrent.for([
    "cached-universal",
    "download",
    "archive-checksum",
    "executable-checksum",
    "architecture",
    "revision",
    "commit",
  ])("admits only pinned native payloads: %s", (scenario, { mac, expect }) =>
    mac.lifetime.run(async () => {
      const root = mac.createTempDir("openclaw-bun-stage-");
      const binaries = await revisionExecutables(root, mac);
      const scripts = path.join(root, "scripts");
      const tag = "fixture-release";
      const cache = path.join(root, "apps/macos/.build/openclaw-bun", tag);
      const downloads = path.join(root, "downloads");
      const tools = path.join(root, "tools");
      const runtime = path.join(root, "runtime");
      for (const directory of [
        path.join(scripts, "lib"),
        cache,
        downloads,
        tools,
        path.join(runtime, "bin"),
      ]) {
        await mkdir(directory, { recursive: true });
      }
      await copyFile(
        "scripts/stage-openclaw-bun-macos.sh",
        path.join(scripts, "stage-openclaw-bun-macos.sh"),
      );
      const arches: Arch[] = scenario === "cached-universal" ? ["arm64", "x86_64"] : [hostArch];
      const artifacts: Record<
        string,
        { asset: string; sha256: string; executable: string; executableSha256: string }
      > = {};
      for (const arch of arches) {
        const directory = `bun-darwin-${arch}`;
        const executable = `${directory}/bun`;
        const asset = `${directory}.zip`;
        const binary = binaries[scenario === "architecture" ? otherArch : arch];
        await mkdir(path.join(root, directory));
        await writeFile(path.join(root, executable), binary);
        const archive = path.join(downloads, asset);
        await runMacFixtureTool("/usr/bin/zip", ["-q", archive, executable], root, mac);
        const archiveBytes = await readFile(archive);
        await writeFile(
          path.join(cache, asset),
          ["download", "archive-checksum"].includes(scenario) ? "damaged cache" : archiveBytes,
        );
        artifacts[arch] = {
          asset,
          sha256: scenario === "archive-checksum" ? "0".repeat(64) : digest(archiveBytes),
          executable,
          executableSha256: scenario === "executable-checksum" ? "0".repeat(64) : digest(binary),
        };
      }
      await writeFile(
        path.join(scripts, "lib/openclaw-bun-macos.json"),
        JSON.stringify({
          tag,
          revision: scenario === "revision" ? "wrong-revision" : revision,
          commit: scenario === "commit" ? "f".repeat(40) : commit,
          artifacts,
        }),
      );
      const curlLog = path.join(root, "curl-log");
      await writeFile(
        path.join(tools, "curl"),
        `#!/bin/bash
set -euo pipefail
printf 'download\\n' >> "$fixture_curl_log"
while [[ "$#" -gt 0 ]]; do
  if [[ "$1" == --output ]]; then
    cp "$fixture_downloads/$(basename "$2")" "$2"
    exit 0
  fi
  shift
done
exit 2
`,
        { mode: 0o755 },
      );
      const bun = path.join(runtime, "bin/bun");
      await writeFile(bun, "previous runtime");
      const result = await mac.run(
        "/bin/bash",
        [path.join(scripts, "stage-openclaw-bun-macos.sh"), runtime, ...arches],
        {
          encoding: "utf8",
          env: {
            PATH: `${tools}:${nodeDirectory}:/usr/bin:/bin`,
            TMPDIR: root,
            fixture_downloads: downloads,
            fixture_curl_log: curlLog,
          },
        },
      );
      const downloadsMade = await readFile(curlLog, "utf8").catch((error: unknown) => {
        if (hasNodeErrorCode(error, "ENOENT")) {
          return "";
        }
        throw error;
      });
      expect(downloadsMade).toBe(
        ["download", "archive-checksum"].includes(scenario) ? "download\n" : "",
      );
      if (!["cached-universal", "download"].includes(scenario)) {
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(
          scenario === "archive-checksum"
            ? "sha256 mismatch"
            : ["executable-checksum", "architecture"].includes(scenario)
              ? "executable checksum or architecture mismatch"
              : "fork revision mismatch",
        );
        expect(await readFile(bun, "utf8")).toBe("previous runtime");
        return;
      }
      expect(result.status, result.stderr).toBe(0);
      expect((await stat(bun)).mode & 0o777).toBe(0o755);
      const stagedArches = await runMacFixtureTool("/usr/bin/lipo", ["-archs", bun], root, mac);
      expect(stagedArches.split(/\s+/).toSorted()).toEqual(arches.toSorted());
      expect(await runMacFixtureTool(bun, ["--revision"], root, mac)).toBe(revision);
      expect(await runMacFixtureTool(bun, ["-p", "Bun.revision"], root, mac)).toBe(commit);
      expect(JSON.parse(await readFile(path.join(runtime, "bun-manifest.json"), "utf8")).tag).toBe(
        tag,
      );
    }),
  );
});
