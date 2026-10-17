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
const sourceHomeEnv = {
  HOME: "/tmp/openclaw-source-home",
  OPENCLAW_NO_ONBOARD: "1",
  OPENCLAW_NO_PROMPT: "1",
  COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
  OPENCLAW_SOURCE_SHA: "a".repeat(40),
};
const e2e = (script: string) => path.join(harness, "scripts/e2e", script);

function fixture(root: string) {
  const at = (...parts: string[]) => path.join(root, ...parts);
  const dir = (name: string) => {
    const target = at(name);
    mkdirSync(target, { recursive: true });
    return target;
  };
  const file = (name: string, body: string) => {
    const target = at(name);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, body);
    return target;
  };
  const bin = dir("bin");
  return {
    at,
    dir,
    file,
    bin,
    log: file("commands", ""),
    env: { PATH: `${bin}${path.delimiter}${process.env.PATH}`, TMPDIR: root },
  };
}

type CommandCall = {
  command: string;
  args: string[];
  status?: number | null;
  aliasKind?: "symlink" | "directory" | null;
  installerSource?: string;
};

function readCommandCalls(log: string): CommandCall[] {
  return readFileSync(log, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as CommandCall);
}

function writeNodeCommand(bin: string, command: string, source: string) {
  const file = path.join(bin, command);
  writeFileSync(
    file,
    `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const command = ${JSON.stringify(command)};
const args = process.argv.slice(2);
function run(bin, args, timeout = 1_000, record = () => {}) {
  const result = spawnSync(bin, args, {
    env: process.env, encoding: "utf8", timeout, killSignal: "SIGKILL", maxBuffer: 1024 * 1024,
  });
  if (result.error) throw result.error;
  record(result);
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exit(result.status ?? 1);
}
${source}`,
  );
  chmodSync(file, 0o755);
}

function runBash(args: string[], env: NodeJS.ProcessEnv, cwd?: string, bin = "bash") {
  return spawnSync(bin, args, {
    cwd,
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env, ...env },
  });
}

function flagValues(args: string[], flag: string, missing: string) {
  return args.flatMap((arg, index) => {
    if (arg !== flag) {
      return [];
    }
    const value = args[index + 1];
    if (value === undefined) {
      throw new Error(missing);
    }
    return [value];
  });
}

async function runFixtureBash(
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
) {
  const overflow = new AbortController();
  let bytes = 0;
  const output = { stdout: "", stderr: "" };
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
      for (const name of ["stdout", "stderr"] as const) {
        child[name]!.on("data", (chunk: Buffer) => {
          bytes += chunk.byteLength;
          if (bytes > 1024 * 1024) {
            overflow.abort(new Error("fixture command output exceeded 1 MiB"));
            return;
          }
          output[name] += chunk.toString();
        });
      }
    },
  });
  return { status, ...output };
}

function prepareSourceCaptureCommands(bin: string, root: string) {
  // Only these outer-script utilities are executable; neither captured container runs here.
  for (const name of "basename dirname cat chmod mktemp mkfifo tee tail wc".split(" ")) {
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
if (JSON.stringify(args) === JSON.stringify(["--kill-after=1s", "1s", "true"])) process.exit(0);
if (args[0] !== "--kill-after=30s" || !/^\\d+s$/.test(args[1]) || args[2] !== "docker") {
  throw new Error("unexpected capture timeout command");
}
run(${JSON.stringify(path.join(bin, "docker"))}, args.slice(3), 5_000);
`,
  );
  writeNodeCommand(
    bin,
    "rm",
    `
for (const arg of args) {
  if (/^-[frR]+$/.test(arg) || arg === "--") continue;
  if (!arg.startsWith(${JSON.stringify(root + path.sep)}) || path.resolve(arg) !== arg) {
    throw new Error("capture cleanup escaped fixture");
  }
}
run("/bin/rm", args);
`,
  );
}

async function assertSourceBootstrapIsolation(args: string[], root: string) {
  expect(args.slice(-3, -1)).toEqual(["bash", "-lc"]);
  expect(args[args.indexOf("--user") + 1]).toBe("root");
  const mounts = flagValues(args, "-v", "missing captured Docker mount");
  for (const destination of ["/tmp/openclaw-source.bundle:ro", "/tmp/source-proof.sh:ro"]) {
    const mount = mounts.find((value) => value.endsWith(`:${destination}`));
    expect(mount).toBeDefined();
    expect(path.dirname(mount!.slice(0, -destination.length - 1))).toBe(root);
  }
  const containerEnv = Object.fromEntries(
    flagValues(args, "-e", "missing captured Docker environment entry").map((entry) => {
      const separator = entry.indexOf("=");
      return [entry.slice(0, separator), entry.slice(separator + 1)];
    }),
  );
  expect(containerEnv).toEqual({ ...sourceHomeEnv, OPENCLAW_NO_AUTO_UPDATE: "1" });
  const body = args.at(-1)!;
  for (const kind of ["symlink", "absent", "directory"] as const) {
    const rootForKind = path.join(root, kind);
    const { at, dir, file, bin, log } = fixture(rootForKind);
    const modules = at("node_modules");
    const target = dir("opt/openclaw-e2e/node_modules");
    const aptLists = dir("var/lib/apt/lists");
    file("opt/openclaw-e2e/node_modules/keep", "shared image dependencies");
    file("var/lib/apt/lists/cache", "fixture apt cache");
    if (kind === "symlink") {
      symlinkSync(target, modules);
    } else if (kind === "directory") {
      file("node_modules/keep", "real directory must survive");
    }
    for (const command of ["apt-get", "rm", "curl", "install", "runuser"]) {
      writeNodeCommand(
        bin,
        command,
        `
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
  run("/bin/rm", mapped, 1_000, (result) => log({ command: "rm-result", args, status: result.status }));
}
if (command === "apt-get") {
  if (!["update", "install -y --no-install-recommends curl"].includes(args.join(" "))) {
    throw new Error("unexpected fixture apt command");
  }
} else if (command === "install") {
  if (JSON.stringify(args) !== JSON.stringify(["-d", "-o", "appuser", "-g", "appuser", "/tmp/openclaw-source-home"])) {
    throw new Error("unexpected bootstrap home");
  }
  fs.mkdirSync(${JSON.stringify(at("home"))}, { recursive: true });
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
      rootForKind,
      { ...containerEnv, PATH: bin, TMPDIR: rootForKind, LANG: "C" },
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
            ...Object.entries(sourceHomeEnv).map(([key, value]) => `${key}=${value}`),
            "bash",
            "/tmp/source-proof.sh",
          ],
          aliasKind: null,
        },
      ]);
      expect(lstatSync(modules, { throwIfNoEntry: false }), kind).toBeUndefined();
      expect(existsSync(at("home")), kind).toBe(true);
      expect(existsSync(path.join(aptLists, "cache")), kind).toBe(false);
    }
  }
}

describe("Docker E2E source and harness inputs", () => {
  posixIt.each<
    [script: string, dockerfiles?: string[], harnessDockerfile?: boolean, reuse?: boolean]
  >([
    ["docker-selected-plugins.sh", ["Dockerfile", "Dockerfile", "Dockerfile"]],
    [
      "plugin-binding-command-escape-docker.sh",
      ["scripts/e2e/plugin-binding-command-escape.Dockerfile"],
      true,
    ],
    ["qr-import-docker.sh", ["scripts/e2e/Dockerfile.qr-import"], true],
    ["agents-delete-shared-workspace-docker.sh", ["Dockerfile"]],
    [
      "sandbox-browser-sidecar-docker.sh",
      ["scripts/docker/sandbox/Dockerfile", "scripts/docker/sandbox/Dockerfile.browser"],
      false,
      true,
    ],
    ["compose-setup.sh", undefined, false, true],
    ["cli-installer-distribution-docker.sh", undefined, false, true],
  ])(
    "keeps candidate product inputs for %s",
    async (script, dockerfiles, harnessDockerfile, reuse) => {
      const root = tempDirs.make("e2e-src-");
      const { at, dir, file, bin, log, env } = fixture(root);
      const target = dir("candidate source");
      file(
        "candidate source/Dockerfile",
        'HEALTHCHECK CMD ["node", "dist/docker-healthcheck.js"]\n',
      );
      const packageTgz = file("candidate.tgz", "fixture package bytes");
      const captureSource = script === "cli-installer-distribution-docker.sh";
      if (captureSource) {
        file("candidate source/scripts/install.sh", "#!/bin/bash\necho installer\n");
        file("candidate source/scripts/install-cli.sh", "#!/bin/bash\necho cli\n");
        prepareSourceCaptureCommands(bin, root);
      }
      for (const command of ["docker", "git"]) {
        writeNodeCommand(
          bin,
          command,
          `
const installerMount = args.find((arg) => arg.endsWith(':/tmp/install.sh:ro'));
const installerSource = installerMount ? fs.readFileSync(installerMount.slice(0, -':/tmp/install.sh:ro'.length), 'utf8') : undefined;
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ command, args, installerSource }) + '\\n');
if (command === 'git') {
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
      }
      const socketPath = at("docker.sock");
      const socket = createServer();
      await new Promise<void>((resolve, reject) => {
        socket.once("error", reject);
        socket.listen(socketPath, resolve);
      });
      try {
        const sourceEnv = {
          PATH: bin,
          HOME: at("capture-home"),
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
          ? await runFixtureBash([e2e(script)], target, sourceEnv, 30_000)
          : runBash(
              [e2e(script)],
              {
                ...env,
                OPENCLAW_DOCKER_E2E_REPO_ROOT: target,
                OPENCLAW_CURRENT_PACKAGE_TGZ: packageTgz,
                OPENCLAW_SKIP_DOCKER_BUILD: reuse ? "1" : "0",
                OPENCLAW_DOCKER_SOCKET: socketPath,
              },
              target,
            );
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
            calls.find((call) => call.args[0] === "run" && call.args.includes("-d"))
              ?.installerSource,
          ).toBe("#!/bin/bash\necho installer\n");
          expect(existsSync(path.join(target, "dist"))).toBe(false);
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
  posixIt.each([
    { runner: "cli", mode: "ready", exit: 0 },
    { runner: "package", mode: "ready", exit: 49 },
    { runner: "cli", mode: "pending", exit: 0 },
    { runner: "package", mode: "stopped", exit: 1 },
    { runner: "cli", mode: "exhausted", exit: 1 },
    { runner: "package", mode: "exhausted", exit: 1 },
    { runner: "cli", mode: "inspect-empty", exit: 1 },
    { runner: "package", mode: "inspect-true", exit: 49 },
    { runner: "cli", mode: "success-log-error", exit: 73 },
    { runner: "package", mode: "failure-log-error", exit: 73 },
  ])("preserves $runner proof settlement: $mode", ({ runner, mode, exit }) => {
    const root = tempDirs.make("e2e-wait-");
    const { at, file, bin, log, env } = fixture(root);
    file("package/package.json", JSON.stringify({ name: "openclaw", version: "1.2.3" }));
    const packageTgz = at("candidate.tgz");
    expect(spawnSync("tar", ["-czf", packageTgz, "-C", root, "package"]).status).toBe(0);
    for (const [command, body] of Object.entries({
      git: `if [[ "$*" == *rev-parse* ]]; then printf '%040d\\n' 0; fi`,
      sleep: `printf 'sleep %s\\n' "$*" >> "$PROOF_TRACE"`,
      docker: `
case "$1" in
  run)
    shift
    while (($#)); do
      if [[ "$1" == --name ]]; then
        printf 'start %s\\n' "\${2%-*}" >> "$PROOF_TRACE"
        break
      fi
      shift
    done
    ;;
  exec)
    container="$2"
    shift 2
    if [[ "$*" != 'test -f /tmp/openclaw-proof-ready' ]]; then
      printf 'identity %s %s\\n' "\${container%-*}" "$*" >> "$PROOF_TRACE"
      echo 'fixture-stop at package identity boundary' >&2
      exit 49
    fi
    printf 'probe %s\\n' "\${container%-*}" >> "$PROOF_TRACE"
    count=0
    if [[ -f "$PROOF_STATE/$container" ]]; then read -r count < "$PROOF_STATE/$container"; fi
    count=$((count + 1))
    printf '%s\\n' "$count" > "$PROOF_STATE/$container"
    case "$PROOF_MODE" in
      ready|success-log-error) exit 0 ;;
      pending|inspect-true) if ((count > 1)); then exit 0; fi ;;
    esac
    exit 1
    ;;
  inspect)
    printf 'inspect %s %s\\n' "\${4%-*}" "$2 $3" >> "$PROOF_TRACE"
    case "$PROOF_MODE" in
      stopped|failure-log-error) echo false ;;
      inspect-empty) echo 'inspect-error' >&2; exit 72 ;;
      inspect-true) echo true; echo 'inspect-error' >&2; exit 72 ;;
      *) echo true ;;
    esac
    ;;
  logs)
    printf 'logs %s\\n' "\${2%-*}" >> "$PROOF_TRACE"
    printf 'proof-out:%s\\n' "\${2%-*}"
    printf 'proof-err:%s\\n' "\${2%-*}" >&2
    case "$PROOF_MODE" in *log-error) exit 73 ;; esac
    ;;
  rm)
    shift 2
    for container in "$@"; do printf 'cleanup %s\\n' "\${container%-*}" >> "$PROOF_TRACE"; done
    ;;
esac
`,
    })) {
      const executable = path.join(bin, command);
      writeFileSync(executable, `#!/bin/bash\nset -eu\n${body}\n`);
      chmodSync(executable, 0o755);
    }
    const cli = runner === "cli";
    const containers = cli
      ? ["openclaw-hosted-installer-proof", "openclaw-source-installer-proof"]
      : [
          "openclaw-package-npm-proof",
          "openclaw-package-pnpm-proof",
          "openclaw-package-bun-proof",
          "openclaw-package-musl-proof",
        ];
    const script = cli ? "cli-installer-distribution-docker.sh" : "docker-package-install.sh";
    const result = runBash(
      [e2e(script)],
      {
        ...env,
        OPENCLAW_CURRENT_PACKAGE_TGZ: packageTgz,
        OPENCLAW_SKIP_DOCKER_BUILD: "1",
        OPENCLAW_DOCKER_ARTIFACT_IDENTITY_PATH: at("identity.json"),
        PROOF_TRACE: log,
        PROOF_STATE: root,
        PROOF_MODE: mode,
      },
      harness,
      "/bin/bash",
    );
    expect(result.error).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(exit);
    const calls = readFileSync(log, "utf8").trim().split("\n");
    const expected = containers.map((container) => `start ${container}`);
    const settled = exit === 0 || exit === 49;
    for (const container of settled ? containers : containers.slice(0, 1)) {
      const attempts = mode === "exhausted" ? (cli ? 1200 : 240) : 1;
      for (let attempt = 0; attempt < attempts; attempt++) {
        expected.push(`probe ${container}`);
        if (mode !== "ready" && mode !== "success-log-error") {
          expected.push(`inspect ${container} --format {{.State.Running}}`);
          if (["pending", "inspect-true", "exhausted"].includes(mode)) {
            expected.push("sleep 1");
          }
        }
      }
      if (mode === "pending" || mode === "inspect-true") {
        expected.push(`probe ${container}`);
      }
      if (cli || !settled) {
        expected.push(`logs ${container}`);
      }
    }
    if (exit === 49) {
      // Waits completed; this fixture does not claim installed package acceptance.
      expected.push("identity openclaw-package-pnpm-proof cat /tmp/openclaw-package-root");
      expect(result.stderr).toContain("fixture-stop at package identity boundary");
    }
    expected.push(...containers.map((container) => `cleanup ${container}`));
    expect(calls).toEqual(expected);
    if (cli && (settled || mode === "success-log-error")) {
      expect(result.stdout).toContain(`proof-out:${containers[0]}`);
      expect(result.stderr).toContain(`proof-err:${containers[0]}`);
      expect(result.stderr).not.toContain("proof-out:");
    } else if (!settled) {
      expect(result.stdout).not.toContain("proof-out:");
      expect(result.stderr).toContain(`proof-out:${containers[0]}`);
      expect(result.stderr).toContain(`proof-err:${containers[0]}`);
    } else {
      expect(result.stdout + result.stderr).not.toContain("proof-out:");
    }
    expect(result.stderr.includes("inspect-error")).toBe(mode.startsWith("inspect-"));
    expect(result.stdout.includes("CLI installer distribution proof passed.")).toBe(
      cli && exit === 0,
    );
    expect(result.stdout).not.toContain("npm, pnpm, and Bun package artifact proofs passed.");
  });
  posixIt("packs candidate source through the sourced trusted package helper", () => {
    const root = tempDirs.make("e2e-pack-");
    const { at, dir, file } = fixture(root);
    const trusted = dir("trusted harness");
    const target = dir("candidate source");
    const lib = dir("trusted harness/scripts/lib");
    copyFileSync("scripts/lib/docker-e2e-package.sh", path.join(lib, "docker-e2e-package.sh"));
    file("candidate source/scripts/package-openclaw-for-docker.mjs", "process.exit(47);\n");
    const marker = at("packer-source");
    file(
      "trusted harness/scripts/package-openclaw-for-docker.mjs",
      `
import fs from 'node:fs'; import path from 'node:path';
const value = (name) => process.argv[process.argv.indexOf(name) + 1];
fs.writeFileSync(${JSON.stringify(marker)}, value('--source-dir'));
const output = path.join(value('--output-dir'), value('--output-name'));
fs.writeFileSync(output, 'candidate bytes');
console.log(output);
`,
    );
    const result = runBash(
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
        ROOT_DIR: target,
        TRUSTED: trusted,
        TMPDIR: root,
        OPENCLAW_DOCKER_E2E_REPO_ROOT: target,
        OPENCLAW_CURRENT_PACKAGE_TGZ: "",
      },
    );
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(readFileSync(marker, "utf8")).toBe(target);
  });
});
