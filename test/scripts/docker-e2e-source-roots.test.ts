import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runManagedCommand } from "../../scripts/lib/managed-child-process.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const harness = process.cwd();
const posixIt = process.platform === "win32" ? it.skip : it;

type CommandCall = {
  command: string;
  args: string[];
  status?: number | null;
  aliasKind?: "symlink" | "directory" | null;
};

function readCommandCalls(log: string): CommandCall[] {
  return readFileSync(log, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as CommandCall);
}

function writeNodeCommand(bin: string, command: string, source: string) {
  const file = path.join(bin, command);
  writeFileSync(file, `#!${process.execPath}\n${source}`);
  chmodSync(file, 0o755);
}

async function runFixtureBash(
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
) {
  const overflow = new AbortController();
  let bytes = 0;
  let stdout = "";
  let stderr = "";
  const status = await runManagedCommand({
    bin: "/bin/bash",
    args: ["--noprofile", "--norc", "-f", ...args],
    cwd,
    env,
    timeoutMs,
    timeoutKillGraceMs: 500,
    abortKillGraceMs: 500,
    cleanupDrainTimeoutMs: 1_000,
    requireProcessTreeExit: true,
    signal: overflow.signal,
    stdio: ["ignore", "pipe", "pipe"],
    onReady(child) {
      for (const [name, pipe] of [
        ["stdout", child.stdout!],
        ["stderr", child.stderr!],
      ] as const) {
        pipe.on("data", (chunk: Buffer) => {
          bytes += chunk.byteLength;
          if (bytes > 1024 * 1024) {
            overflow.abort(new Error("fixture command output exceeded 1 MiB"));
            return;
          }
          if (name === "stdout") {
            stdout += chunk.toString();
          } else {
            stderr += chunk.toString();
          }
        });
      }
    },
  });
  return { status, stdout, stderr };
}

function prepareSourceCaptureCommands(bin: string, root: string) {
  // Only these outer-script utilities are executable; neither captured container runs here.
  for (const name of [
    "basename",
    "dirname",
    "cat",
    "chmod",
    "mktemp",
    "mkfifo",
    "tee",
    "tail",
    "wc",
  ]) {
    const executable = [`/usr/bin/${name}`, `/bin/${name}`].find(existsSync);
    if (!executable) {
      throw new Error(`missing fixture utility: ${name}`);
    }
    symlinkSync(executable, path.join(bin, name));
  }
  symlinkSync(process.execPath, path.join(bin, "node"));
  writeNodeCommand(
    bin,
    "timeout",
    `
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
if (JSON.stringify(args) === JSON.stringify(["--kill-after=1s", "1s", "true"])) process.exit(0);
if (args[0] !== "--kill-after=30s" || !/^\\d+s$/.test(args[1]) || args[2] !== "docker") {
  throw new Error("unexpected capture timeout command");
}
const result = spawnSync(${JSON.stringify(path.join(bin, "docker"))}, args.slice(3), {
  env: process.env, encoding: "utf8", timeout: 5_000, killSignal: "SIGKILL", maxBuffer: 1024 * 1024,
});
if (result.error) throw result.error;
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
process.exit(result.status ?? 1);
`,
  );
  writeNodeCommand(
    bin,
    "rm",
    `
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
for (const arg of args) {
  if (/^-[frR]+$/.test(arg) || arg === "--") continue;
  if (!arg.startsWith(${JSON.stringify(root + path.sep)}) || path.resolve(arg) !== arg) {
    throw new Error("capture cleanup escaped fixture");
  }
}
const result = spawnSync("/bin/rm", args, {
  env: process.env, encoding: "utf8", timeout: 1_000, killSignal: "SIGKILL", maxBuffer: 1024 * 1024,
});
if (result.error) throw result.error;
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
process.exit(result.status ?? 1);
`,
  );
}

async function assertSourceBootstrapIsolation(args: string[], root: string) {
  expect(args.slice(-3, -1)).toEqual(["bash", "-lc"]);
  expect(args[args.indexOf("--user") + 1]).toBe("root");
  const mounts = args.flatMap((arg, index) => {
    if (arg !== "-v") {
      return [];
    }
    const mount = args[index + 1];
    if (mount === undefined) {
      throw new Error("missing captured Docker mount");
    }
    return [mount];
  });
  for (const destination of ["/tmp/openclaw-source.bundle:ro", "/tmp/source-proof.sh:ro"]) {
    const mount = mounts.find((value) => value.endsWith(`:${destination}`));
    expect(mount).toBeDefined();
    expect(path.dirname(mount!.slice(0, -destination.length - 1))).toBe(root);
  }
  const containerEnv = Object.fromEntries(
    args.flatMap((arg, index) => {
      if (arg !== "-e") {
        return [];
      }
      const entry = args[index + 1];
      if (entry === undefined) {
        throw new Error("missing captured Docker environment entry");
      }
      const separator = entry.indexOf("=");
      return [[entry.slice(0, separator), entry.slice(separator + 1)]];
    }),
  );
  expect(containerEnv).toEqual({
    HOME: "/tmp/openclaw-source-home",
    OPENCLAW_NO_ONBOARD: "1",
    OPENCLAW_NO_PROMPT: "1",
    COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
    OPENCLAW_SOURCE_SHA: "a".repeat(40),
    OPENCLAW_NO_AUTO_UPDATE: "1",
  });
  const body = args.at(-1)!;
  for (const kind of ["symlink", "absent", "directory"] as const) {
    const fixture = path.join(root, kind);
    const bin = path.join(fixture, "bin");
    const modules = path.join(fixture, "node_modules");
    const target = path.join(fixture, "opt/openclaw-e2e/node_modules");
    const aptLists = path.join(fixture, "var/lib/apt/lists");
    const log = path.join(fixture, "bootstrap.jsonl");
    mkdirSync(bin, { recursive: true });
    mkdirSync(target, { recursive: true });
    mkdirSync(aptLists, { recursive: true });
    writeFileSync(path.join(target, "keep"), "shared image dependencies");
    writeFileSync(path.join(aptLists, "cache"), "fixture apt cache");
    writeFileSync(log, "");
    if (kind === "symlink") {
      symlinkSync(target, modules);
    } else if (kind === "directory") {
      mkdirSync(modules);
      writeFileSync(path.join(modules, "keep"), "real directory must survive");
    }
    for (const command of ["apt-get", "rm", "curl", "install", "runuser"]) {
      writeNodeCommand(
        bin,
        command,
        `
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const command = ${JSON.stringify(command)};
const args = process.argv.slice(2);
const log = (record) => fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(record) + "\\n");
const modules = ${JSON.stringify(modules)};
const aptLists = ${JSON.stringify(aptLists)};
log({ command, args });
if (command === "rm") {
  // Keep the final component lexical: resolving it would follow the very alias under test.
  const mapped = args.flatMap((arg) => {
    if (/^-[frR]+$/.test(arg) || arg === "--") return [arg];
    if (arg === "/node_modules") return [modules];
    if (arg === "/var/lib/apt/lists/*") {
      const entries = fs.readdirSync(aptLists).filter((name) => !name.startsWith(".")).sort();
      return (entries.length ? entries : ["*"]).map((name) => path.join(aptLists, name));
    }
    throw new Error("bootstrap rm operand outside fixture namespace");
  });
  const result = spawnSync("/bin/rm", mapped, {
    env: process.env, encoding: "utf8", timeout: 1_000, killSignal: "SIGKILL", maxBuffer: 1024 * 1024,
  });
  if (result.error) throw result.error;
  log({ command: "rm-result", args, status: result.status });
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exit(result.status ?? 1);
}
if (command === "apt-get") {
  if (!["update", "install -y --no-install-recommends curl"].includes(args.join(" "))) {
    throw new Error("unexpected fixture apt command");
  }
} else if (command === "install") {
  if (JSON.stringify(args) !== JSON.stringify(["-d", "-o", "appuser", "-g", "appuser", "/tmp/openclaw-source-home"])) {
    throw new Error("unexpected bootstrap home");
  }
  fs.mkdirSync(${JSON.stringify(path.join(fixture, "home"))}, { recursive: true });
} else if (command === "runuser") {
  const stat = fs.lstatSync(modules, { throwIfNoEntry: false });
  log({ command: "handoff", args, aliasKind: stat?.isSymbolicLink() ? "symlink" : stat?.isDirectory() ? "directory" : null });
  // This is the boundary observation, not an execution of env/bash or a success oracle.
} else {
  throw new Error("curl must only be located, never executed");
}
`,
      );
    }
    // No login/profile, inherited shell functions/options, operator PATH, or host glob expansion.
    const result = await runFixtureBash(
      ["-c", body],
      fixture,
      { ...containerEnv, PATH: bin, TMPDIR: fixture, LANG: "C" },
      5_000,
    );
    const calls = readCommandCalls(log);
    const handoffs = calls.filter((call) => call.command === "handoff");
    expect(readFileSync(path.join(target, "keep"), "utf8"), kind).toBe("shared image dependencies");
    if (kind === "directory") {
      const refusal = calls.find(
        (call) => call.command === "rm-result" && call.args.includes("/node_modules"),
      );
      expect(refusal, result.stderr).toBeDefined();
      expect(refusal!.status).not.toBe(0);
      expect(result.status).toBe(refusal!.status);
      expect(handoffs).toEqual([]);
      expect(readFileSync(path.join(modules, "keep"), "utf8")).toBe("real directory must survive");
    } else {
      expect(result.status, `${kind}: ${result.stdout}${result.stderr}`).toBe(0);
      expect(handoffs, kind).toEqual([
        {
          command: "handoff",
          args: [
            "-u",
            "appuser",
            "--",
            "env",
            "HOME=/tmp/openclaw-source-home",
            "OPENCLAW_NO_ONBOARD=1",
            "OPENCLAW_NO_PROMPT=1",
            "COREPACK_ENABLE_DOWNLOAD_PROMPT=0",
            `OPENCLAW_SOURCE_SHA=${"a".repeat(40)}`,
            "bash",
            "/tmp/source-proof.sh",
          ],
          aliasKind: null,
        },
      ]);
      expect(lstatSync(modules, { throwIfNoEntry: false }), kind).toBeUndefined();
      expect(existsSync(path.join(fixture, "home")), kind).toBe(true);
      expect(existsSync(path.join(aptLists, "cache")), kind).toBe(false);
    }
  }
}

describe("Docker E2E source and harness inputs", () => {
  posixIt.each<{
    script: string;
    dockerfiles?: string[];
    harnessDockerfile?: boolean;
    reuse?: boolean;
  }>([
    {
      script: "docker-selected-plugins.sh",
      dockerfiles: ["Dockerfile", "Dockerfile", "Dockerfile"],
    },
    {
      script: "plugin-binding-command-escape-docker.sh",
      dockerfiles: ["scripts/e2e/plugin-binding-command-escape.Dockerfile"],
      harnessDockerfile: true,
    },
    {
      script: "qr-import-docker.sh",
      dockerfiles: ["scripts/e2e/Dockerfile.qr-import"],
      harnessDockerfile: true,
    },
    { script: "agents-delete-shared-workspace-docker.sh", dockerfiles: ["Dockerfile"] },
    {
      script: "sandbox-browser-sidecar-docker.sh",
      dockerfiles: [
        "scripts/docker/sandbox/Dockerfile",
        "scripts/docker/sandbox/Dockerfile.browser",
      ],
      reuse: true,
    },
    { script: "compose-setup.sh", reuse: true },
    { script: "cli-installer-distribution-docker.sh", reuse: true },
  ])(
    "keeps candidate product inputs for $script",
    async ({ script, dockerfiles, harnessDockerfile, reuse }) => {
      const root = tempDirs.make("e2e-src-");
      const target = path.join(root, "candidate source");
      const bin = path.join(root, "bin");
      const log = path.join(root, "commands.jsonl");
      mkdirSync(target);
      mkdirSync(bin);
      writeFileSync(
        path.join(target, "Dockerfile"),
        'HEALTHCHECK CMD ["node", "dist/docker-healthcheck.js"]\n',
      );
      const packageTgz = path.join(root, "candidate.tgz");
      writeFileSync(packageTgz, "fixture package bytes");
      const captureSource = script === "cli-installer-distribution-docker.sh";
      if (captureSource) {
        prepareSourceCaptureCommands(bin, root);
      }
      for (const command of ["docker", "git"]) {
        const file = path.join(bin, command);
        writeFileSync(
          file,
          `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ command: ${JSON.stringify(command)}, args }) + '\\n');
if (${JSON.stringify(command)} === 'git') {
  if (args.includes('rev-parse')) console.log('a'.repeat(40));
} else if (args[0] === 'build' || args[0] === 'buildx') {
  if (args.some((arg) => arg.includes('OPENCLAW_EXTENSIONS=missing-plugin'))) {
    console.error('unknown OPENCLAW_EXTENSIONS plugin id: missing-plugin');
    process.exit(49);
  }
} else if (
  args[0] === 'compose' ||
  (args[0] === 'run' && !args.some((arg) => arg.endsWith('-dependency-only')))
) {
  if (${captureSource} && args[0] === 'run') {
    const name = args[args.indexOf('--name') + 1];
    if (/^openclaw-hosted-installer-proof-[0-9]+$/.test(name)) process.exit(0);
    if (!/^openclaw-source-installer-proof-[0-9]+$/.test(name)) {
      throw new Error('unexpected source capture container');
    }
  }
  console.error('fixture-stop at product input boundary');
  process.exit(49);
}
`,
        );
        chmodSync(file, 0o755);
      }
      const socketPath = path.join(root, "docker.sock");
      const socket = createServer();
      await new Promise<void>((resolve, reject) => {
        socket.once("error", reject);
        socket.listen(socketPath, resolve);
      });
      try {
        const sourceEnv = {
          PATH: bin,
          HOME: path.join(root, "capture-home"),
          TMPDIR: root,
          LANG: "C",
          OPENCLAW_DOCKER_E2E_REPO_ROOT: target,
          OPENCLAW_CURRENT_PACKAGE_TGZ: packageTgz,
          OPENCLAW_SKIP_DOCKER_BUILD: "1",
          OPENCLAW_DOCKER_E2E_REQUIRE_LOCAL_IMAGE: "1",
          OPENCLAW_DOCKER_E2E_AVAILABLE_CPUS: "2",
          OPENCLAW_DOCKER_SOCKET: socketPath,
        };
        const result = captureSource
          ? await runFixtureBash(
              [path.join(harness, "scripts/e2e", script)],
              target,
              sourceEnv,
              30_000,
            )
          : spawnSync("bash", [path.join(harness, "scripts/e2e", script)], {
              cwd: target,
              encoding: "utf8",
              timeout: 30_000,
              env: {
                ...process.env,
                PATH: `${bin}${path.delimiter}${process.env.PATH}`,
                TMPDIR: root,
                OPENCLAW_DOCKER_E2E_REPO_ROOT: target,
                OPENCLAW_CURRENT_PACKAGE_TGZ: packageTgz,
                OPENCLAW_SKIP_DOCKER_BUILD: reuse ? "1" : "0",
                OPENCLAW_DOCKER_SOCKET: socketPath,
              },
            });
        expect(result.status).not.toBe(0);
        expect(result.stdout + result.stderr).toContain("fixture-stop at product input boundary");
        const calls = readCommandCalls(log);
        if (dockerfiles) {
          const builds = calls.filter(
            (call) =>
              call.command === "docker" &&
              (call.args[0] === "build" || call.args[0] === "buildx") &&
              call.args.at(-1) === target,
          );
          expect(builds.map((build) => build.args[build.args.indexOf("-f") + 1])).toEqual(
            dockerfiles.map((dockerfile) =>
              path.join(harnessDockerfile ? harness : target, dockerfile),
            ),
          );
        } else if (script === "compose-setup.sh") {
          expect(calls.find((call) => call.args[0] === "compose")?.args).toContain(
            path.join(target, "docker-compose.yml"),
          );
        } else {
          const gitCalls = calls.filter((call) => call.command === "git");
          expect(gitCalls.map((call) => call.args.slice(0, 2))).toEqual([
            ["-C", target],
            ["-C", target],
          ]);
          expect(
            calls.find((call) => call.args[0] === "run" && call.args.includes("-d"))?.args,
          ).toContain(`${target}/scripts/install.sh:/tmp/install.sh:ro`);
          const runs = calls.filter(
            (call) =>
              call.command === "docker" && call.args[0] === "run" && call.args.includes("-d"),
          );
          expect(runs).toHaveLength(2);
          expect(runs.map((call) => call.args[call.args.indexOf("--name") + 1])).toEqual([
            expect.stringMatching(/^openclaw-hosted-installer-proof-[0-9]+$/),
            expect.stringMatching(/^openclaw-source-installer-proof-[0-9]+$/),
          ]);
          const sourceRun = runs[1];
          if (!sourceRun) {
            throw new Error("missing captured source container run");
          }
          await assertSourceBootstrapIsolation(sourceRun.args, root);
        }
      } finally {
        await new Promise<void>((resolve, reject) => {
          socket.close((error) => (error ? reject(error) : resolve()));
        });
      }
    },
  );
  posixIt("packs candidate source through the sourced trusted package helper", () => {
    const root = tempDirs.make("e2e-pack-");
    const trusted = path.join(root, "trusted harness");
    const target = path.join(root, "candidate source");
    const lib = path.join(trusted, "scripts/lib");
    mkdirSync(lib, { recursive: true });
    mkdirSync(path.join(target, "scripts"), { recursive: true });
    copyFileSync("scripts/lib/docker-e2e-package.sh", path.join(lib, "docker-e2e-package.sh"));
    writeFileSync(
      path.join(target, "scripts/package-openclaw-for-docker.mjs"),
      "process.exit(47);\n",
    );
    const marker = path.join(root, "packer-source");
    writeFileSync(
      path.join(trusted, "scripts/package-openclaw-for-docker.mjs"),
      `
import fs from 'node:fs'; import path from 'node:path';
const value = (name) => process.argv[process.argv.indexOf(name) + 1];
fs.writeFileSync(${JSON.stringify(marker)}, value('--source-dir'));
const output = path.join(value('--output-dir'), value('--output-name'));
fs.writeFileSync(output, 'candidate bytes');
console.log(output);
`,
    );
    const result = spawnSync(
      "bash",
      [
        "-c",
        `
set -euo pipefail
run_logged() { :; }
docker_e2e_docker_cmd() { :; }
docker_e2e_docker_run_cmd() { :; }
source "$TRUSTED/scripts/lib/docker-e2e-package.sh"
package="$(docker_e2e_prepare_package_tgz fixture)"
[[ "$(cat "$package")" == 'candidate bytes' ]]
docker_e2e_cleanup_package_tgz "$package"
`,
      ],
      {
        encoding: "utf8",
        timeout: 30_000,
        env: {
          ...process.env,
          ROOT_DIR: target,
          TRUSTED: trusted,
          TMPDIR: root,
          OPENCLAW_DOCKER_E2E_REPO_ROOT: target,
          OPENCLAW_CURRENT_PACKAGE_TGZ: "",
        },
      },
    );
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(readFileSync(marker, "utf8")).toBe(target);
  });
});
