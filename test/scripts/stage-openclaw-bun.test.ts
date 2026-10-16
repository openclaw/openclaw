import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { hasNodeErrorCode } from "@openclaw/fs-safe/path";
import { describe } from "vitest";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import { createCommandTest, type CommandFixture } from "../helpers/command-fixture.js";

const it = createCommandTest();
const nodeDirectory = path.dirname(resolveTestNodeExecPath());
const hostArch = process.arch === "arm64" ? "arm64" : "x64";
const otherArch = hostArch === "arm64" ? "x64" : "arm64";
const commit = "0123456789012345678901234567890123456789";
const revision = "fixture+012345678";
const digest = (data: Buffer) => createHash("sha256").update(data).digest("hex");
type Arch = "arm64" | "x64";
let compiled: Promise<Record<Arch, Buffer>> | undefined;

async function runTool(bin: string, args: string[], root: string, command: CommandFixture) {
  const result = await command.run(bin, args, {
    cwd: root,
    env: { HOME: root, TMPDIR: root, PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
  });
  if (result.status !== 0 || result.error) {
    throw new Error(`${bin}: ${result.stderr}`, { cause: result.error });
  }
  return result.stdout.trim();
}

function revisionExecutables(root: string, command: CommandFixture) {
  // Share only completed bytes: no case borrows another case's temporary paths.
  compiled ??= command.lifetime.run(async () => {
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
    if (process.platform === "linux") {
      await runTool("cc", [source, "-o", universal], root, command);
      const native = await readFile(universal);
      const other = Buffer.from(native);
      other.writeUInt16LE(hostArch === "arm64" ? 62 : 183, 18);
      return hostArch === "arm64" ? { arm64: native, x64: other } : { arm64: other, x64: native };
    }
    await runTool(
      "/usr/bin/xcrun",
      ["clang", "-arch", "arm64", "-arch", "x86_64", source, "-o", universal],
      root,
      command,
    );
    const paths = {
      arm64: path.join(root, "revision-arm64"),
      x64: path.join(root, "revision-x64"),
    };
    for (const arch of ["arm64", "x64"] as const) {
      await runTool(
        "/usr/bin/lipo",
        [universal, "-thin", arch === "x64" ? "x86_64" : arch, "-output", paths[arch]],
        root,
        command,
      );
    }
    return { arm64: await readFile(paths.arm64), x64: await readFile(paths.x64) };
  });
  return compiled;
}

describe.runIf(["darwin", "linux"].includes(process.platform))(
  "OpenClaw Bun runtime staging",
  () => {
    it.concurrent.for([
      "cached",
      "download",
      "archive-checksum",
      "executable-checksum",
      "architecture",
      "revision",
      "commit",
      "release-manifest-checksum",
      "release-identity",
      "release-artifact",
      "release-archive-checksum",
    ])("admits only pinned native payloads: %s", (scenario, { command, expect }) =>
      command.lifetime.run(async () => {
        const root = command.createTempDir("openclaw-bun-stage-");
        const binaries = await revisionExecutables(root, command);
        const scripts = path.join(root, "scripts");
        const tag = "fixture-release";
        const cache = path.join(root, ".cache/openclaw-bun", tag);
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
          "scripts/stage-openclaw-bun.sh",
          path.join(scripts, "stage-openclaw-bun.sh"),
        );
        const arches: Arch[] =
          scenario === "cached" && process.platform === "darwin" ? ["arm64", "x64"] : [hostArch];
        const artifacts: Record<
          string,
          { asset: string; sha256: string; executable: string; executableSha256: string }
        > = {};
        for (const arch of arches) {
          const directory = `bun-${process.platform}-${arch}`;
          const executable = `${directory}/bun`;
          const asset = `${directory}.zip`;
          const binary = binaries[scenario === "architecture" ? otherArch : arch];
          await mkdir(path.join(root, directory));
          await writeFile(path.join(root, executable), binary);
          const archive = path.join(downloads, asset);
          await runTool("/usr/bin/zip", ["-q", archive, executable], root, command);
          const archiveBytes = await readFile(archive);
          await writeFile(
            path.join(cache, asset),
            ["download", "archive-checksum"].includes(scenario) ? "damaged cache" : archiveBytes,
          );
          artifacts[`${process.platform}-${arch}`] = {
            asset,
            sha256: scenario === "archive-checksum" ? "0".repeat(64) : digest(archiveBytes),
            executable,
            executableSha256: scenario === "executable-checksum" ? "0".repeat(64) : digest(binary),
          };
        }
        const pin = {
          tag,
          revision: scenario === "revision" ? "wrong-revision" : revision,
          commit: scenario === "commit" ? "f".repeat(40) : commit,
          artifacts,
        };
        await writeFile(path.join(scripts, "lib/openclaw-bun.json"), JSON.stringify(pin));
        const release = {
          repository: "openclaw/bun",
          tag: scenario === "release-identity" ? "different-release" : tag,
          bun: { commit: pin.commit, revision: pin.revision },
          assets: Object.entries(artifacts).map(([target, artifact]) => ({
            target,
            name: artifact.asset,
            sha256: scenario === "release-artifact" ? "0".repeat(64) : artifact.sha256,
            executable: { path: artifact.executable, sha256: artifact.executableSha256 },
          })),
        };
        const releaseBytes = Buffer.from(JSON.stringify(release));
        await writeFile(path.join(downloads, "manifest.json"), releaseBytes);
        await writeFile(
          path.join(downloads, "SHA256SUMS"),
          [
            `${scenario === "release-manifest-checksum" ? "0".repeat(64) : digest(releaseBytes)}  manifest.json`,
            ...Object.values(artifacts).map(
              (artifact) =>
                `${scenario === "release-archive-checksum" ? "0".repeat(64) : artifact.sha256}  ${artifact.asset}`,
            ),
          ].join("\n") + "\n",
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
        const result = await command.run(
          "/bin/bash",
          [path.join(scripts, "stage-openclaw-bun.sh"), runtime, process.platform, ...arches],
          {
            encoding: "utf8",
            env: {
              PATH: `${tools}:${nodeDirectory}:/usr/bin:/bin`,
              TMPDIR: root,
              fixture_downloads: downloads,
              fixture_curl_log: curlLog,
              HOME: root,
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
          "download\ndownload\n" +
            (["download", "archive-checksum"].includes(scenario) ? "download\n" : ""),
        );
        if (!["cached", "download"].includes(scenario)) {
          expect(result.status).not.toBe(0);
          expect(result.stderr).toContain(
            scenario.includes("checksum") && scenario !== "executable-checksum"
              ? "sha256 mismatch"
              : scenario === "executable-checksum"
                ? "executable checksum mismatch"
                : scenario === "architecture"
                  ? "executable architecture mismatch"
                  : scenario === "release-identity"
                    ? "release tag mismatch"
                    : scenario === "release-artifact"
                      ? "release artifact differs from pin"
                      : "fork revision mismatch",
          );
          expect(await readFile(bun, "utf8")).toBe("previous runtime");
          return;
        }
        expect(result.status, result.stderr).toBe(0);
        expect((await stat(bun)).mode & 0o777).toBe(0o755);
        if (process.platform === "darwin") {
          const stagedArches = await runTool("/usr/bin/lipo", ["-archs", bun], root, command);
          expect(stagedArches.split(/\s+/).toSorted()).toEqual(
            arches.map((arch) => (arch === "x64" ? "x86_64" : arch)).toSorted(),
          );
        }
        expect(await runTool(bun, ["--revision"], root, command)).toBe(revision);
        expect(await runTool(bun, ["-p", "Bun.revision"], root, command)).toBe(commit);
        expect(
          JSON.parse(await readFile(path.join(runtime, "bun-manifest.json"), "utf8")).tag,
        ).toBe(tag);
      }),
    );
  },
);
