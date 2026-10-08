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

function windowsExecutable(arch: Arch) {
  const bytes = Buffer.alloc(128);
  bytes.write("MZ");
  bytes.writeUInt32LE(64, 60);
  bytes.write("PE\0\0", 64);
  bytes.writeUInt16LE(arch === "arm64" ? 0xaa64 : 0x8664, 68);
  bytes.writeUInt16LE(0x20b, 88);
  return bytes;
}
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
      "windows-signed",
      "windows-arm64",
      "windows-unsigned",
      "windows-missing",
      "windows-local",
      "windows-local-arm64",
      "windows-local-checksum",
      "windows-architecture",
      "windows-truncated-pe",
      "windows-signing-mismatch",
      "windows-release-identity",
    ])("admits only pinned native payloads: %s", (scenario, { command, expect }) =>
      command.lifetime.run(async () => {
        const root = command.createTempDir("openclaw-bun-stage-");
        const windows = scenario.startsWith("windows-");
        const platform = windows ? "windows" : process.platform;
        const binaries = windows ? undefined : await revisionExecutables(root, command);
        const localProof = scenario.startsWith("windows-local");
        const scripts = path.join(root, "scripts");
        const tag = windows ? "fixture-windows-release" : "fixture-release";
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
        const arches: [Arch, ...Arch[]] = windows
          ? [scenario.endsWith("-arm64") ? "arm64" : "x64"]
          : scenario === "cached" && process.platform === "darwin"
            ? ["arm64", "x64"]
            : [hostArch];
        const artifacts: Record<
          string,
          {
            asset: string;
            sha256: string;
            executable: string;
            executableSha256: string;
            tag?: string;
            commit?: string;
            authenticodeSigned?: boolean;
          }
        > = {};
        for (const arch of arches) {
          const directory = `bun-${platform}-${arch}`;
          const executable = `${directory}/${windows ? "bun.exe" : "bun"}`;
          const asset = `${directory}.zip`;
          const binary = windows
            ? scenario === "windows-truncated-pe"
              ? Buffer.from("MZ")
              : windowsExecutable(scenario === "windows-architecture" ? "arm64" : arch)
            : binaries![scenario === "architecture" ? otherArch : arch];
          await mkdir(path.join(root, directory));
          await writeFile(path.join(root, executable), binary);
          const archive = path.join(downloads, asset);
          await runTool("/usr/bin/zip", ["-q", archive, executable], root, command);
          const archiveBytes = await readFile(archive);
          await writeFile(
            path.join(cache, asset),
            ["download", "archive-checksum"].includes(scenario) ? "damaged cache" : archiveBytes,
          );
          artifacts[`${platform}-${arch}`] = {
            asset,
            sha256: ["archive-checksum", "windows-local-checksum"].includes(scenario)
              ? "0".repeat(64)
              : digest(archiveBytes),
            executable,
            executableSha256: scenario === "executable-checksum" ? "0".repeat(64) : digest(binary),
            ...(windows
              ? { tag, commit, authenticodeSigned: scenario !== "windows-unsigned" && !localProof }
              : {}),
          };
        }
        const pin = {
          tag: windows ? "unrelated-unix-tag" : tag,
          revision: windows || scenario === "revision" ? "wrong-revision" : revision,
          commit: windows || scenario === "commit" ? "f".repeat(40) : commit,
          artifacts: scenario === "windows-missing" ? {} : artifacts,
        };
        await writeFile(path.join(scripts, "lib/openclaw-bun.json"), JSON.stringify(pin));
        const release = {
          repository: "openclaw/bun",
          tag: ["release-identity", "windows-release-identity"].includes(scenario)
            ? "different-release"
            : tag,
          bun: windows ? { commit } : { commit: pin.commit, revision: pin.revision },
          assets: Object.entries(artifacts).map(([target, artifact]) => ({
            target,
            name: artifact.asset,
            sha256: scenario === "release-artifact" ? "0".repeat(64) : artifact.sha256,
            executable: {
              path: artifact.executable,
              sha256: artifact.executableSha256,
              ...(artifact.authenticodeSigned
                ? { authenticodeSigned: scenario !== "windows-signing-mismatch" }
                : {}),
            },
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
        const bun = path.join(runtime, windows ? "bin/bun.exe" : "bin/bun");
        await writeFile(bun, "previous runtime");
        const result = await command.run(
          "/bin/bash",
          [
            path.join(scripts, "stage-openclaw-bun.sh"),
            runtime,
            platform,
            ...arches,
            ...(localProof ? ["--unsigned-windows-artifact", downloads] : []),
          ],
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
          localProof || ["windows-unsigned", "windows-missing"].includes(scenario)
            ? ""
            : "download\ndownload\n" +
                (["download", "archive-checksum"].includes(scenario) ? "download\n" : ""),
        );
        if (
          [
            "windows-signed",
            "windows-arm64",
            "windows-local",
            "windows-local-arm64",
            "windows-unsigned",
            "windows-missing",
          ].includes(scenario)
        ) {
          const desktopScripts = path.join(root, "apps/linux/scripts");
          const desktopRuntime = path.join(root, "apps/linux/src-tauri/target/desktop-runtime");
          await mkdir(desktopScripts, { recursive: true });
          await mkdir(path.join(desktopRuntime, "bin"), { recursive: true });
          await copyFile(
            "apps/linux/scripts/stage-runtime.mjs",
            path.join(desktopScripts, "stage-runtime.mjs"),
          );
          await writeFile(path.join(desktopRuntime, "bin/bun.exe"), "stale bundled runtime");
          const staged = await command.run(
            resolveTestNodeExecPath(),
            [
              path.join(desktopScripts, "stage-runtime.mjs"),
              ...(localProof ? ["--unsigned-windows-artifact", downloads] : []),
            ],
            {
              env: {
                PATH: `${tools}:${nodeDirectory}:/usr/bin:/bin`,
                TMPDIR: root,
                HOME: root,
                TAURI_ENV_TARGET_TRIPLE: `${arches[0] === "x64" ? "x86_64" : "aarch64"}-pc-windows-msvc`,
                fixture_downloads: downloads,
                fixture_curl_log: curlLog,
              },
            },
          );
          expect(staged.status, staged.stderr).toBe(0);
          const manifest = JSON.parse(
            await readFile(path.join(desktopRuntime, "manifest.json"), "utf8"),
          );
          if (["windows-unsigned", "windows-missing"].includes(scenario)) {
            expect(manifest).toEqual({});
            await expect(readFile(path.join(desktopRuntime, "bin/bun.exe"))).rejects.toMatchObject({
              code: "ENOENT",
            });
            await expect(readFile(curlLog)).rejects.toMatchObject({ code: "ENOENT" });
          } else {
            const binary = windowsExecutable(arches[0]);
            expect(manifest).toEqual({
              tag,
              commit,
              platform: "windows",
              arch: arches[0],
              authenticodeSigned: !localProof,
              ...(localProof ? { testOnly: true } : {}),
              files: { "bin/bun.exe": digest(binary) },
            });
            expect(await readFile(path.join(desktopRuntime, "bin/bun.exe"))).toEqual(
              Buffer.concat([Buffer.from("OPENCLAW-BUN-RUNTIME-V1\n"), binary]),
            );
          }
        }
        if (
          ![
            "cached",
            "download",
            "windows-signed",
            "windows-arm64",
            "windows-local",
            "windows-local-arm64",
          ].includes(scenario)
        ) {
          expect(result.status).not.toBe(0);
          expect(result.stderr).toContain(
            scenario.includes("checksum") && scenario !== "executable-checksum"
              ? "sha256 mismatch"
              : scenario === "executable-checksum"
                ? "executable checksum mismatch"
                : ["architecture", "windows-architecture", "windows-truncated-pe"].includes(
                      scenario,
                    )
                  ? "executable architecture mismatch"
                  : scenario === "windows-unsigned"
                    ? "needs an Authenticode-signed release"
                    : scenario === "windows-missing"
                      ? "Missing pinned Bun target"
                      : scenario === "windows-signing-mismatch"
                        ? "Authenticode admission differs from pin"
                        : ["release-identity", "windows-release-identity"].includes(scenario)
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
        if (windows) {
          expect(await readFile(bun)).toEqual(windowsExecutable(arches[0]));
          expect(
            JSON.parse(await readFile(path.join(runtime, "bun-manifest.json"), "utf8")),
          ).toEqual(pin);
          return;
        }
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
