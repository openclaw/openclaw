import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
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
const stageScript = "scripts/stage-openclaw-bun.sh";

function toolRunner(root: string, command: CommandFixture) {
  return async (bin: string, args: string[]) => {
    const result = await command.run(bin, args, {
      cwd: root,
      env: { HOME: root, TMPDIR: root, PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
    });
    if (result.status !== 0 || result.error) {
      throw new Error(`${bin}: ${result.stderr}`, { cause: result.error });
    }
    return result.stdout.trim();
  };
}

function revisionExecutables(root: string, command: CommandFixture) {
  // Share only completed bytes: no case borrows another case's temporary paths.
  compiled ??= command.lifetime.run(async () => {
    const run = toolRunner(root, command);
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
      await run("cc", [source, "-o", universal]);
      const native = await readFile(universal);
      const other = Buffer.from(native);
      other.writeUInt16LE(hostArch === "arm64" ? 62 : 183, 18);
      return hostArch === "arm64" ? { arm64: native, x64: other } : { arm64: other, x64: native };
    }
    const compile = async (arch: string) => {
      const output = path.join(root, `revision-${arch}`);
      await run("/usr/bin/xcrun", ["clang", "-arch", arch, source, "-o", output]);
      return readFile(output);
    };
    return { arm64: await compile("arm64"), x64: await compile("x86_64") };
  });
  return compiled;
}

it.runIf(["darwin", "linux"].includes(process.platform)).concurrent.for([
  ["cached", ""],
  ["download", ""],
  ["archive-checksum", "sha256 mismatch"],
  ["executable-checksum", "executable checksum mismatch"],
  ["architecture", "executable architecture mismatch"],
  ["revision", "fork revision mismatch"],
  ["commit", "fork revision mismatch"],
  ["release-manifest-checksum", "sha256 mismatch"],
  ["release-identity", "release tag mismatch"],
  ["release-artifact", "release artifact differs from pin"],
  ["release-archive-checksum", "sha256 mismatch"],
] as const)(
  "admits only pinned native payloads: %s",
  ([scenario, expectedError], { command, expect }) =>
    command.lifetime.run(async () => {
      const root = command.createTempDir("openclaw-bun-stage-");
      const file = (name: string) => path.join(root, name);
      const write = async (name: string, data: string | Buffer, mode?: number) => {
        await mkdir(path.dirname(file(name)), { recursive: true });
        await writeFile(file(name), data, { mode });
      };
      const run = toolRunner(root, command);
      const checksum = (kind: string, value: string) =>
        scenario === kind ? "0".repeat(64) : value;
      const redownload = ["download", "archive-checksum"].includes(scenario);
      const binaries = await revisionExecutables(root, command);
      const tag = "fixture-release";
      await mkdir(file("downloads"));
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
        await write(executable, binary);
        const archive = file(`downloads/${asset}`);
        await run("/usr/bin/zip", ["-q", archive, executable]);
        const archiveBytes = await readFile(archive);
        await write(
          `.cache/openclaw-bun/${tag}/${asset}`,
          redownload ? "damaged cache" : archiveBytes,
        );
        artifacts[`${process.platform}-${arch}`] = {
          asset,
          sha256: checksum("archive-checksum", digest(archiveBytes)),
          executable,
          executableSha256: checksum("executable-checksum", digest(binary)),
        };
      }
      const pin = {
        tag,
        revision: scenario === "revision" ? "wrong-revision" : revision,
        commit: scenario === "commit" ? "f".repeat(40) : commit,
        artifacts,
      };
      await write("scripts/lib/openclaw-bun.json", JSON.stringify(pin));
      await copyFile(stageScript, file(stageScript));
      const release = {
        repository: "openclaw/bun",
        tag: scenario === "release-identity" ? "different-release" : tag,
        bun: { commit: pin.commit, revision: pin.revision },
        assets: Object.entries(artifacts).map(([target, artifact]) => ({
          target,
          name: artifact.asset,
          sha256: checksum("release-artifact", artifact.sha256),
          executable: { path: artifact.executable, sha256: artifact.executableSha256 },
        })),
      };
      const releaseBytes = Buffer.from(JSON.stringify(release));
      await write("downloads/manifest.json", releaseBytes);
      await write(
        "downloads/SHA256SUMS",
        [
          `${checksum("release-manifest-checksum", digest(releaseBytes))}  manifest.json`,
          ...Object.values(artifacts).map(
            (artifact) =>
              `${checksum("release-archive-checksum", artifact.sha256)}  ${artifact.asset}`,
          ),
        ].join("\n") + "\n",
      );
      const curlLog = file("curl-log");
      await write(
        "tools/curl",
        `#!/bin/bash
set -euo pipefail
printf 'download\\n' >> "$fixture_curl_log"
while [[ "$1" != --output ]]; do shift; done
cp "$fixture_downloads/$(basename "$2")" "$2"
`,
        0o755,
      );
      const bun = file("runtime/bin/bun");
      await write("runtime/bin/bun", "previous runtime");
      const result = await command.run(
        "/bin/bash",
        [file(stageScript), file("runtime"), process.platform, ...arches],
        {
          encoding: "utf8",
          env: {
            PATH: `${file("tools")}:${nodeDirectory}:/usr/bin:/bin`,
            TMPDIR: root,
            fixture_downloads: file("downloads"),
            fixture_curl_log: curlLog,
            HOME: root,
          },
        },
      );
      const downloadsMade = await readFile(curlLog, "utf8");
      expect(downloadsMade).toBe("download\ndownload\n" + (redownload ? "download\n" : ""));
      if (expectedError) {
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(expectedError);
        expect(await readFile(bun, "utf8")).toBe("previous runtime");
        return;
      }
      expect(result.status, result.stderr).toBe(0);
      expect((await stat(bun)).mode & 0o777).toBe(0o755);
      if (process.platform === "darwin") {
        const stagedArches = await run("/usr/bin/lipo", ["-archs", bun]);
        expect(stagedArches.split(/\s+/).toSorted()).toEqual(
          arches.map((arch) => (arch === "x64" ? "x86_64" : arch)).toSorted(),
        );
      }
      expect(await run(bun, ["--revision"])).toBe(revision);
      expect(await run(bun, ["-p", "Bun.revision"])).toBe(commit);
      expect(JSON.parse(await readFile(file("runtime/bun-manifest.json"), "utf8")).tag).toBe(tag);
    }),
);
