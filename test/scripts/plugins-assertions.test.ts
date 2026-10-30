import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import {
  createServer,
  request as httpRequest,
  type RequestListener,
  type IncomingMessage,
} from "node:http";
import path from "node:path";
import { createInterface } from "node:readline";
import { text } from "node:stream/consumers";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import { createBoundedChildOutput } from "../helpers/bounded-child-output.js";
import { createFixtureLifetime } from "../helpers/fixture-lifetime.js";
import { closeHttpServer, listenLoopback } from "../helpers/gateway-integration-fixtures.js";
import { awaitGateBeforeSettlement, withinTest } from "../helpers/promise.js";
import { runNodeScript } from "../helpers/run-node-script.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { isProcessPresent } from "./run-process.test-support.js";

const npmArtifact = {
  artifactKind: "npm-pack",
  artifactFormat: "tgz",
  clawpackSha256: "digest",
  clawpackSize: 0,
  npmIntegrity: "integrity",
  npmShasum: "shasum",
  npmTarballName: "package.tgz",
};
const ASSERTIONS_SCRIPT = "scripts/e2e/lib/plugins/assertions.mjs";
const CLAWHUB_ID = "openclaw-kitchen-sink-fixture";
const CLAWHUB_SPEC = "clawhub:@openclaw/kitchen-sink";
const fixtures = createFixtureLifetime();
const autoCleanupTempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(async () => {
    await fixtures.cleanup();
    cleanup();
  });
});

function shellQuote(value: string): string {
  return `'${value.replace(/'/gu, `'\\''`)}'`;
}

function writeJson(filePath: string, value: unknown) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
function runAssertion(command: string, env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [ASSERTIONS_SCRIPT, command], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

function pluginHome(prefix: string) {
  const root = autoCleanupTempDirs.make(prefix);
  const home = path.join(root, "home");
  const state = path.join(home, ".openclaw");
  const scratch = path.join(root, "scratch");
  return {
    root,
    state,
    scratch,
    env: {
      HOME: home,
      OPENCLAW_STATE_DIR: state,
      OPENCLAW_CONFIG_PATH: path.join(state, "openclaw.json"),
      OPENCLAW_PLUGINS_TMP_DIR: scratch,
    },
  };
}

async function clawhubPreflight(
  signal: AbortSignal,
  listener: RequestListener,
  env: NodeJS.ProcessEnv,
) {
  const { origin } = await useUpstream(listener);
  const result = await runNodeScript(
    [ASSERTIONS_SCRIPT, "clawhub-preflight"],
    {
      ...process.env,
      CLAWHUB_PLUGIN_ID: CLAWHUB_ID,
      CLAWHUB_PLUGIN_SPEC: CLAWHUB_SPEC,
      OPENCLAW_CLAWHUB_URL: origin,
      ...env,
    },
    undefined,
    { signal, executable: process.execPath },
  );
  if (result.error) {
    throw new Error("ClawHub preflight command failed", { cause: result.error });
  }
  return result;
}

function writeFixtureServerShims(
  binDir: string,
  pidPath: string,
  termAction: "exit 0" | ":" = "exit 0",
): void {
  mkdirSync(binDir, { recursive: true });
  writeFileSync(
    path.join(binDir, "node"),
    [
      "#!/bin/bash",
      'printf "%s\\n" "$$" >"$OPENCLAW_TEST_FIXTURE_SERVER_PID"',
      `trap '${termAction}' TERM`,
      "while true; do /bin/sleep 1; done",
      "",
    ].join("\n"),
  );
  writeFileSync(path.join(binDir, "sleep"), "#!/bin/bash\nexit 0\n");
  chmodSync(path.join(binDir, "node"), 0o755);
  chmodSync(path.join(binDir, "sleep"), 0o755);
  writeFileSync(pidPath, "");
}

function runPluginsSweepShell(script: string, env: NodeJS.ProcessEnv = {}) {
  return spawnSync("/bin/bash", ["-c", script], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

async function requestFixtureRegistry(
  port: number,
  requestPath: string,
  headers: Record<string, string> = {},
) {
  const response = await new Promise<IncomingMessage>((resolve, reject) => {
    const request = httpRequest(
      { headers, host: "127.0.0.1", method: "GET", path: requestPath, port },
      resolve,
    );
    request.setTimeout(2_000, () => {
      request.destroy(new Error(`timed out requesting ${requestPath}`));
    });
    request.on("error", reject);
    request.end();
  });
  return {
    body: await text(response),
    contentLength: response.headers["content-length"],
    statusCode: response.statusCode,
  };
}

async function useRegistry(
  signal: AbortSignal,
  options: {
    packageName?: string;
    version?: string;
    cwd?: string;
    portFile?: string;
    tarballPath?: string;
    tarballName?: string;
    archive?: string;
    env?: NodeJS.ProcessEnv;
    upstream?: RequestListener;
    preload?: string;
  } = {},
) {
  const root = options.portFile
    ? path.dirname(options.portFile)
    : autoCleanupTempDirs.make("openclaw-plugin-registry-");
  const portFile = options.portFile ?? path.join(root, "port");
  const tarballPath =
    options.tarballPath ?? path.join(root, options.tarballName ?? "demo-plugin.tgz");
  if (!options.tarballPath) {
    writeFileSync(tarballPath, options.archive ?? "fixture package archive", "utf8");
  }
  const upstream = options.upstream ? await useUpstream(options.upstream) : undefined;
  const preload = options.preload ? path.join(root, "preload.mjs") : undefined;
  if (options.preload && preload) {
    writeFileSync(preload, options.preload);
  }
  return fixtures.acquire(async (rollback) => {
    const child = spawn(
      process.execPath,
      [
        ...(preload ? ["--import", pathToFileURL(preload).href] : []),
        path.resolve("scripts/e2e/lib/plugins/npm-registry-server.mjs"),
        portFile,
        options.packageName ?? "@openclaw/demo-plugin-npm",
        options.version ?? "1.0.0",
        tarballPath,
      ],
      {
        cwd: options.cwd ?? process.cwd(),
        env: {
          ...process.env,
          ...(upstream ? { OPENCLAW_NPM_REGISTRY_UPSTREAM: upstream.origin } : {}),
          ...options.env,
        },
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      },
    );
    const closed = once(child, "close");
    const listening = new Promise<number>((resolve, reject) => {
      child.once("message", (message: unknown) => {
        if (typeof message === "number" && Number.isInteger(message) && message > 0) {
          resolve(message);
        } else {
          reject(new Error(`invalid fixture registry readiness: ${JSON.stringify(message)}`));
        }
      });
    });
    const stderr = child.stderr;
    if (stderr === null) {
      throw new Error("expected fixture registry stderr pipe");
    }
    const diagnostic = createBoundedChildOutput();
    stderr.setEncoding("utf8");
    stderr.on("data", diagnostic.append);
    const cleanup = async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
      }
      await closed;
    };
    try {
      const port = await withinTest(
        awaitGateBeforeSettlement(listening, closed, `timed out waiting for ${portFile}`),
        signal,
      );
      expect(Number(readFileSync(portFile, "utf8"))).toBe(port);
      return { child, diagnostic, port, cleanup };
    } catch (error) {
      return rollback(error, cleanup);
    }
  });
}

async function assertRegistryRecovers(
  registry: Awaited<ReturnType<typeof useRegistry>>,
  requestPath: string,
  statusCode: number,
  body: string,
) {
  const response = await requestFixtureRegistry(registry.port, requestPath);
  expect(response.statusCode, registry.diagnostic.text()).toBe(statusCode);
  expect(response.body).toContain(body);
  const local = await requestFixtureRegistry(registry.port, "/@openclaw%2Fdemo-plugin-npm");
  expect(local.statusCode, registry.diagnostic.text()).toBe(200);
  expect(registry.child.exitCode, registry.diagnostic.text()).toBeNull();
  return local;
}

async function useUpstream(listener: RequestListener) {
  return fixtures.acquire(async (rollback) => {
    const server = createServer(listener);
    const cleanup = () => closeHttpServer(server);
    try {
      return { origin: await listenLoopback(server), cleanup };
    } catch (error) {
      return rollback(error, cleanup);
    }
  });
}

describe("plugins Docker assertions", () => {
  it("preserves caller-provided plugin sweep scratch roots", () => {
    const root = autoCleanupTempDirs.make("openclaw-plugin-sweep-caller-");
    const scratchRoot = path.join(root, "scratch");
    const result = runPluginsSweepShell(
      `
set -euo pipefail
export OPENCLAW_PLUGINS_SWEEP_SOURCE_ONLY=1
export OPENCLAW_PLUGINS_TMP_DIR="$SCRATCH_ROOT"
source scripts/e2e/lib/plugins/sweep.sh
test -d "$OPENCLAW_PLUGINS_TMP_DIR"
cleanup_openclaw_plugins_sweep
test -d "$OPENCLAW_PLUGINS_TMP_DIR"
`,
      { SCRATCH_ROOT: scratchRoot },
    );

    expect(result).toMatchObject({ stdout: "", stderr: "", status: 0 });
    expect(existsSync(scratchRoot)).toBe(true);
  });

  it.each([
    { mode: "capture", status: 0, traceValue: "0", changeAfterSource: false },
    { mode: "logged", status: 23, traceValue: "0", changeAfterSource: false },
    { mode: "logged", status: 0, traceValue: "1", changeAfterSource: true },
  ])(
    "bounds $mode diagnostics (exit $status, trace $traceValue, changed: $changeAfterSource)",
    (testCase) => {
      const root = autoCleanupTempDirs.make("openclaw-plugin-sweep-diagnostics-");
      const outputFile = path.join(root, "plugins-git-inspect.json");
      const capturedOutput = `DO_NOT_DUMP_CAPTURED_PLUGIN_OUTPUT\n${"x".repeat(32 * 1024)}\nCAPTURED_PLUGIN_OUTPUT_TAIL`;
      const fixtureApiKey = ["sk", "proj", "plugin", "fixture", "secret"].join("-");
      const punctuationApiKey = ["sess", "plugin", "punctuation", "secret"].join("-");
      const startOfLineApiKey = ["rk", "plugin", "start", "secret"].join("-");
      const boundarySecretSuffix = "PLUGIN_BOUNDARY_SECRET_SUFFIX_MUST_NOT_LEAK";
      const boundaryApiKey = ["sk", "proj", "z".repeat(256), boundarySecretSuffix].join("-");
      const capturedError = `DO_NOT_DUMP_PLUGIN_STDERR_PREFIX\n${"y".repeat(32 * 1024)}\n${startOfLineApiKey}\nPLUGIN_STDERR_TAIL_MARKER task-runner Authorization: Bearer plugin-fixture-bearer OPENAI_API_KEY=${fixtureApiKey} [${punctuationApiKey}]\n${boundaryApiKey}`;
      const command =
        testCase.mode === "capture"
          ? 'run_plugins_openclaw_capture "$OUTPUT_FILE" plugins inspect demo-plugin --runtime --json'
          : 'run_plugins_openclaw_logged install-git plugins install "git:file:///tmp/fixture@revision" --force';

      const result = runPluginsSweepShell(
        `
set -euo pipefail
export OPENCLAW_PLUGINS_SWEEP_SOURCE_ONLY=1
export OPENCLAW_PLUGINS_TMP_DIR="$SCRATCH_ROOT"
export OPENCLAW_PLUGINS_CLI_TIMEOUT=1s
export OPENCLAW_ENTRY=fixture-entry
source scripts/e2e/lib/plugins/sweep.sh
${
  testCase.changeAfterSource
    ? `export OPENCLAW_PLUGIN_LIFECYCLE_TRACE=${shellQuote(testCase.traceValue)}`
    : ""
}
umask 000
openclaw_e2e_maybe_timeout() {
  local raw_stderr_file
  local raw_stderr_mode
  for raw_stderr_file in "$SCRATCH_ROOT"/openclaw-plugin-stderr.*; do
    [[ -f "$raw_stderr_file" ]] || return 86
    if raw_stderr_mode="$(stat -f '%Lp' "$raw_stderr_file" 2>/dev/null)"; then
      :
    elif raw_stderr_mode="$(stat -c '%a' "$raw_stderr_file" 2>/dev/null)"; then
      :
    else
      return 87
    fi
    [[ "$raw_stderr_mode" == "600" ]] || return 88
  done
  printf '%s\\n' "$CAPTURED_OUTPUT"
  printf '%s\\n' "$CAPTURED_STDERR" >&2
  if [[ "\${OPENCLAW_PLUGIN_LIFECYCLE_TRACE:-}" == "1" ]]; then
    printf '%s\\n' '[plugins:lifecycle] shim' >&2
  fi
  return "$CAPTURE_STATUS"
}
${command}
`,
        {
          CAPTURED_OUTPUT: capturedOutput,
          CAPTURED_STDERR: capturedError,
          CAPTURE_STATUS: String(testCase.status),
          OPENCLAW_DOCKER_E2E_LOG_PRINT_BYTES: "192",
          OPENCLAW_PLUGIN_LIFECYCLE_TRACE: testCase.changeAfterSource ? "0" : testCase.traceValue,
          OUTPUT_FILE: outputFile,
          SCRATCH_ROOT: root,
        },
      );

      expect(result).toMatchObject({ status: testCase.status, stdout: "" });
      if (testCase.mode === "capture") {
        expect(readFileSync(outputFile, "utf8")).toBe(`${capturedOutput}\n`);
      }
      expect(result.stderr.length).toBeLessThan(1_024);
      for (const secret of [
        "DO_NOT_DUMP_CAPTURED_PLUGIN_OUTPUT",
        "CAPTURED_PLUGIN_OUTPUT_TAIL",
        "DO_NOT_DUMP_PLUGIN_STDERR_PREFIX",
        "plugin-fixture-bearer",
        fixtureApiKey,
        punctuationApiKey,
        startOfLineApiKey,
        boundarySecretSuffix,
        boundaryApiKey,
      ]) {
        expect(result.stderr).not.toContain(secret);
      }
      expect(
        readdirSync(root).filter(
          (name) => name.startsWith("openclaw-plugin-") || name.endsWith(".stderr.log"),
        ),
      ).toEqual([]);

      for (const fragment of [
        "truncated: showing last 192",
        "PLUGIN_STDERR_TAIL_MARKER",
        "task-runner",
        "Authorization: Bearer [REDACTED]",
        "OPENAI_API_KEY=[REDACTED]",
        "[[REDACTED]]",
      ]) {
        expect(result.stderr).toContain(fragment);
      }
      expect(result.stderr.includes("[plugins:lifecycle]")).toBe(testCase.traceValue === "1");
      if (testCase.status !== 0) {
        expect(result.stderr).toContain(
          `Plugin sweep command failed with status ${testCase.status}: install-git`,
        );
      }
    },
  );

  it("replaces both npm registry environment spellings", () => {
    const root = autoCleanupTempDirs.make("openclaw-plugin-npm-fixture-routing-");
    writeFileSync(path.join(root, "fixture.tgz"), "fixture package archive");
    const result = runPluginsSweepShell(
      `
set -euo pipefail
source scripts/e2e/lib/plugins/fixtures.sh
unset NPM_CONFIG_REGISTRY npm_config_registry
export NPM_CONFIG_REGISTRY=http://127.0.0.1:1 npm_config_registry=http://127.0.0.1:1
start_npm_fixture_registry fixture-pkg 1.0.0 "$REGISTRY_ROOT/fixture.tgz" "$REGISTRY_ROOT"
# Duplicate-case precedence depends on environment order; exercise each accepted spelling.
registry_index=0
for registry_key in NPM_CONFIG_REGISTRY npm_config_registry; do
  env -u "$registry_key" npm view fixture-pkg@1.0.0 version --json --fetch-retries=0 --fetch-timeout=1000 --cache "$REGISTRY_ROOT/cache" > "$REGISTRY_ROOT/version-$registry_index.json"
  registry_index=$((registry_index + 1))
done
`,
      {
        HOME: root,
        REGISTRY_ROOT: root,
      },
    );

    expect(result.status, result.stderr).toBe(0);
    for (const index of [0, 1]) {
      const version = JSON.parse(readFileSync(path.join(root, `version-${index}.json`), "utf8"));
      // npm versions differ in scalar/array output; each command emits one complete JSON value.
      expect(Array.isArray(version) ? version : [version]).toEqual(["1.0.0"]);
    }
  });

  it.each([false, true])("cleans timed-out npm fixture children (stubborn=%s)", (stubborn) => {
    const root = autoCleanupTempDirs.make("openclaw-plugin-npm-fixture-cleanup-");
    const binDir = path.join(root, "bin");
    const fixtureDir = path.join(root, "fixture");
    const cleanupPath = path.join(root, "caller-cleanup");
    const pidPath = path.join(root, "server.pid");
    mkdirSync(fixtureDir);
    writeFixtureServerShims(binDir, pidPath, stubborn ? ":" : "exit 0");
    const trap = stubborn
      ? ""
      : `set -e; trap 'printf caller-cleanup > ${shellQuote(cleanupPath)}' EXIT; `;

    const result = runPluginsSweepShell(
      [
        "set -euo pipefail",
        "source scripts/e2e/lib/plugins/fixtures.sh",
        "set +e",
        `( ${trap}start_npm_fixture_registry fixture-pkg 1.0.0 ${shellQuote(path.join(root, "fixture.tgz"))} ${shellQuote(fixtureDir)} )`,
        'status="$?"',
        "set -e",
        '[ "$status" != "0" ]',
      ].join("\n"),
      {
        ...(stubborn
          ? {
              OPENCLAW_PLUGINS_FIXTURE_STOP_ATTEMPTS: "2",
              OPENCLAW_PLUGINS_FIXTURE_STOP_INTERVAL_SECONDS: "0.05",
            }
          : {}),
        OPENCLAW_TEST_FIXTURE_SERVER_PID: pidPath,
        PATH: `${binDir}${path.delimiter}/usr/bin${path.delimiter}/bin`,
      },
    );

    expect(result.status, result.stderr || result.stdout).toBe(0);
    const pid = Number(readFileSync(pidPath, "utf8"));
    expect(Number.isInteger(pid)).toBe(true);
    // The shell EXIT trap joins this exact fixture child before returning.
    expect(isProcessPresent(pid)).toBe(false);
    if (!stubborn) {
      expect(readFileSync(cleanupPath, "utf8")).toBe("caller-cleanup");
    }
  });

  it.for([
    { initial: null, fault: "", label: "new destination" },
    { initial: "12345", fault: "", label: "existing port" },
    { initial: null, fault: "write", label: "failed write" },
    { initial: "12345", fault: "rename", label: "failed replacement" },
  ])("publishes complete registry port bytes: $label", ({ initial, fault }, { signal }) =>
    fixtures.run(async () => {
      const root = fixtures.createTempDir("openclaw-plugin-npm-publication-");
      const registryScript = "scripts/e2e/lib/plugins/npm-registry-server.mjs";
      // Docker and private observers copy this plain-Node closure without repository packages.
      for (const file of [registryScript, "scripts/lib/bounded-response.mjs"]) {
        mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
        copyFileSync(file, path.join(root, file));
      }
      const portDir = path.join(root, "readiness");
      mkdirSync(portDir);
      const portFile = path.join(portDir, "port");
      if (initial !== null) {
        writeFileSync(portFile, initial);
      }
      const tarballPath = path.join(root, "fixture.tgz");
      writeFileSync(tarballPath, "fixture package archive");
      const preload = path.join(root, "publication-preload.mjs");
      writeFileSync(
        preload,
        `import fs from "node:fs";
import path from "node:path";
const portFile = process.argv[2];
const fault = ${JSON.stringify(fault)};
const acknowledgments = ${JSON.stringify(root)};
const wait = new Int32Array(new SharedArrayBuffer(4));
function observe(phase, payload) {
  fs.writeSync(1, JSON.stringify({ phase, payload }) + "\\n");
  while (!fs.existsSync(path.join(acknowledgments, phase + ".ack"))) {
    Atomics.wait(wait, 0, 0, 5);
  }
}
const writeFile = fs.writeFileSync;
fs.writeFileSync = (file, data, options) => {
  if (path.dirname(file) !== path.dirname(portFile)) return writeFile(file, data, options);
  const bytes = Buffer.from(data);
  const fd = fs.openSync(file, options?.flag ?? "w", options?.mode);
  try {
    observe("opened", data);
    fs.writeSync(fd, bytes, 0, 1);
    observe("first-byte", data);
    if (fault === "write") throw new Error("injected port write failure");
    fs.writeSync(fd, bytes, 1, bytes.length - 1);
  } finally {
    fs.closeSync(fd);
  }
  observe("complete", data);
  setImmediate(() => observe("ready", data));
};
const rename = fs.renameSync;
fs.renameSync = (source, destination) => {
  if (destination === portFile && fault === "rename") throw new Error("injected port rename failure");
  return rename(source, destination);
};
`,
      );
      const nodeExecPath = resolveTestNodeExecPath();
      const child = spawn(
        nodeExecPath,
        [
          "--import",
          pathToFileURL(preload).href,
          registryScript,
          portFile,
          "fixture-pkg",
          "1.0.0",
          tarballPath,
        ],
        {
          cwd: root,
          env: {
            ...process.env,
            OPENCLAW_NPM_REGISTRY_PORT: "0",
            OPENCLAW_NPM_REGISTRY_BIND_HOST: "127.0.0.1",
            OPENCLAW_NPM_REGISTRY_UPSTREAM: "",
            OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_URL: "",
            OPENCLAW_NPM_REGISTRY_MERGE_UPSTREAM: "",
            OPENCLAW_NPM_REGISTRY_DIST_TAGS: "",
          },
          signal,
          killSignal: "SIGKILL",
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      const stderr = createBoundedChildOutput();
      child.stderr.on("data", stderr.append);
      child.on("error", (error) => stderr.append(error));
      const closed = new Promise<void>((resolve) => {
        child.once("close", () => resolve());
      });
      const lines = createInterface({ input: child.stdout });
      const observations: Array<{ phase: string; payload: string; observed: string | null }> = [];
      try {
        for await (const line of lines) {
          const observation = JSON.parse(line) as (typeof observations)[number];
          // The writer stays at this boundary until this independent process has read it.
          observations.push({
            ...observation,
            observed: existsSync(portFile) ? readFileSync(portFile, "utf8") : null,
          });
          writeFileSync(path.join(root, `${observation.phase}.ack`), "");
          if (observation.phase === "ready") {
            break;
          }
        }
        expect(
          observations.map(({ phase }) => phase),
          stderr.text(),
        ).toEqual(
          ["opened", "first-byte", "complete", "ready"].slice(
            0,
            fault === "write" ? 2 : fault === "rename" ? 3 : 4,
          ),
        );
        for (const { phase, payload, observed } of observations) {
          expect(payload).toMatch(/^[1-9][0-9]*$/u);
          expect([initial, payload], `port file exposed incomplete bytes at ${phase}`).toContain(
            observed,
          );
        }
        if (fault) {
          await closed;
          expect(child.exitCode, stderr.text()).toBe(1);
          expect(stderr.text()).toContain(`injected port ${fault} failure`);
          expect(existsSync(portFile) ? readFileSync(portFile, "utf8") : null).toBe(initial);
        } else {
          const published = readFileSync(portFile, "utf8");
          expect(observations.at(-1)).toEqual({
            phase: "ready",
            payload: published,
            observed: published,
          });
        }
        expect(readdirSync(portDir)).toEqual(initial !== null || !fault ? ["port"] : []);
      } finally {
        lines.close();
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
        }
        await closed;
      }
    }),
  );

  it("survives malformed npm package paths", ({ signal }) =>
    fixtures.run(async () => {
      const registry = await useRegistry(signal);
      const valid = await assertRegistryRecovers(registry, "/%", 404, "not found");
      expect(JSON.parse(valid.body)).toMatchObject({
        name: "@openclaw/demo-plugin-npm",
        "dist-tags": { latest: "1.0.0" },
      });
    }));

  it("serves scoped tarballs through shrinkwrap paths", ({ signal }) =>
    fixtures.run(async () => {
      const archive = "scoped candidate package archive";
      const { port, diagnostic: stderr } = await useRegistry(signal, {
        archive,
        tarballName: "openclaw-ai-2026.7.34.tgz",
        packageName: "@openclaw/ai",
        version: "2026.7.34",
      });
      for (const pathname of [
        "/@openclaw/ai/-/ai-2026.7.34.tgz",
        "/@openclaw%2Fai/-/ai-2026.7.34.tgz",
        "/@openclaw%2Fai/-/openclaw-ai-2026.7.34.tgz",
      ]) {
        const response = await requestFixtureRegistry(port, pathname);
        expect(response.statusCode, `${pathname}: ${stderr.text()}`).toBe(200);
        expect(response.body).toBe(archive);
        expect(response.contentLength).toBe(String(Buffer.byteLength(archive)));
      }
    }));

  it("uses request origins for drive-qualified tarballs", ({ signal }) =>
    fixtures.run(async () => {
      const root = autoCleanupTempDirs.make("openclaw-plugin-npm-fixture-package-");
      const packageDir = path.join(root, "package");
      const portFile = path.join(root, "port");
      // On POSIX, a relative D:/ path reproduces GNU tar's Windows remote-archive parsing.
      const archiveDir = process.platform === "win32" ? root : "D:/packages";
      const tarballPath = path.join(archiveDir, "openclaw.tgz");
      mkdirSync(path.resolve(root, archiveDir), { recursive: true });
      mkdirSync(packageDir);
      const dependencies = { "@openclaw/ai": "2026.7.1-beta.3", zod: "4.3.6" };
      const optionalDependencies = { "sqlite-vec": "0.1.7-alpha.2" };
      writeJson(path.join(packageDir, "package.json"), {
        name: "openclaw",
        version: "2026.7.1-beta.3",
        dependencies,
        optionalDependencies,
      });
      const packed = spawnSync("tar", ["-czf", "openclaw.tgz", "-C", root, "package"], {
        cwd: path.resolve(root, archiveDir),
        encoding: "utf8",
      });
      expect(packed.status, packed.stderr).toBe(0);

      const { port } = await useRegistry(signal, {
        portFile,
        tarballPath,
        cwd: root,
        packageName: "openclaw",
        version: "2026.7.1-beta.3",
        env: {
          OPENCLAW_NPM_REGISTRY_DIST_TAGS: "latest=0.0.0,beta=2026.7.1-beta.3",
          // Fail locally if GNU tar mistakes the synthetic drive letter for a remote host.
          TAR_OPTIONS: "--rsh-command=false",
        },
      });

      const response = await requestFixtureRegistry(port, "/openclaw", {
        host: `192.0.2.2:${port}`,
      });
      const metadata = JSON.parse(response.body);

      expect(response.statusCode).toBe(200);
      expect(metadata["dist-tags"]).toEqual({ latest: "0.0.0", beta: "2026.7.1-beta.3" });
      const manifest = metadata.versions["2026.7.1-beta.3"];
      expect({
        dependencies: manifest.dependencies,
        optionalDependencies: manifest.optionalDependencies,
        tarball: manifest.dist.tarball,
      }).toEqual({
        dependencies,
        optionalDependencies,
        tarball: `http://192.0.2.2:${port}/openclaw/-/openclaw.tgz`,
      });
    }));

  it.for([false, true])(
    "projects upstream tarballs per request origin (merged=%s)",
    (merged, { signal }) =>
      fixtures.run(async () => {
        const packageName = merged ? "@openclaw/demo-plugin-npm" : "upstream-package";
        const externalTarball = "https://external.invalid/upstream-package.tgz";
        let upstreamRequests = 0;
        const { port } = await useRegistry(signal, {
          upstream: (request, response) => {
            upstreamRequests += 1;
            const tarball = `http://${request.headers.host}/upstream-package/-/package.tgz?download=1`;
            const versions = {
              "0.9.0": { dist: { tarball } },
              "0.8.0": { dist: { tarball: externalTarball } },
            };
            const compressedBody = gzipSync(
              JSON.stringify({ name: packageName, payload: "x".repeat(1_000), versions }),
            );
            response.writeHead(200, {
              "content-encoding": "gzip",
              "content-length": String(compressedBody.length),
              "content-type": "application/json",
            });
            response.end(compressedBody);
          },
          env: { OPENCLAW_NPM_REGISTRY_MERGE_UPSTREAM: merged ? "1" : "" },
        });

        for (const host of [`192.0.2.2:${port}`, `192.0.2.3:${port}`]) {
          const response = await requestFixtureRegistry(
            port,
            `/${encodeURIComponent(packageName)}`,
            { host },
          );
          const metadata = JSON.parse(response.body);

          expect(response.statusCode).toBe(200);
          expect(metadata.versions["0.9.0"].dist.tarball).toBe(
            `http://${host}/upstream-package/-/package.tgz?download=1`,
          );
          expect(metadata.versions["0.8.0"].dist.tarball).toBe(externalTarball);
          if (merged) {
            expect(new URL(metadata.versions["1.0.0"].dist.tarball).origin).toBe(`http://${host}`);
          }
          if (!merged) {
            expect(response.contentLength).toBe(String(Buffer.byteLength(response.body)));
          }
        }
        expect(upstreamRequests).toBe(merged ? 1 : 2);
      }),
  );

  it("streams npm tarballs without a content length", ({ signal }) =>
    fixtures.run(async () => {
      const upstreamBody = "x".repeat(1024 * 1024);
      const { port } = await useRegistry(signal, {
        upstream: (_request, response) => {
          response.writeHead(200, { "content-type": "application/octet-stream" });
          response.write(upstreamBody.slice(0, upstreamBody.length / 2));
          response.end(upstreamBody.slice(upstreamBody.length / 2));
        },
      });

      const response = await requestFixtureRegistry(
        port,
        "/@openai/codex/-/codex-0.145.0-linux-arm64.tgz",
      );

      expect(response).toEqual({ statusCode: 200, contentLength: undefined, body: upstreamBody });
    }));

  it.for(["oversized", "stalled"])(
    "rejects %s upstream bodies without stopping the registry",
    (mode, { signal }) =>
      fixtures.run(async () => {
        const stalled = mode === "stalled";
        let upstreamHits = 0;
        const preload = [
          "const nativeFetch = globalThis.fetch;",
          "let timeoutController;",
          "let timeoutWatchdog;",
          "AbortSignal.timeout = () => {",
          "  timeoutController = new AbortController();",
          "  timeoutWatchdog = setTimeout(() => process.exit(86), 5_000);",
          "  timeoutWatchdog.unref();",
          "  return timeoutController.signal;",
          "};",
          "globalThis.fetch = async (...args) => {",
          "  const response = await nativeFetch(...args);",
          "  let firstChunk = true;",
          "  const body = response.body.pipeThrough(",
          "    new TransformStream({",
          "      transform(chunk, controller) {",
          "        controller.enqueue(chunk);",
          "        if (firstChunk) {",
          "          firstChunk = false;",
          "          clearTimeout(timeoutWatchdog);",
          '          queueMicrotask(() => timeoutController.abort(new DOMException("timeout", "TimeoutError")));',
          "        }",
          "      },",
          "    }),",
          "  );",
          "  return new Response(body, response);",
          "};",
          "",
        ].join("\n");

        const registry = await useRegistry(signal, {
          upstream: (_request, response) => {
            upstreamHits += 1;
            response.writeHead(200, {
              "content-length": stalled ? "1024" : String(64 * 1024 * 1024 + 1),
              "content-type": stalled ? "application/json" : "application/octet-stream",
            });
            if (stalled) {
              response.write('{"partial":');
            } else {
              response.end("oversized");
            }
          },
          preload: stalled ? preload : undefined,
        });

        await assertRegistryRecovers(
          registry,
          `/${mode}-package`,
          502,
          stalled
            ? "upstream registry request failed"
            : "npm registry upstream response body exceeded 67108864 bytes",
        );
        expect(upstreamHits).toBe(1);
      }),
  );

  it("rejects absolute-form requests escaping upstream", ({ signal }) =>
    fixtures.run(async () => {
      let configuredUpstreamHits = 0;
      let escapeServerHits = 0;
      let configuredUpstreamTarget: string | undefined;
      const { port } = await useRegistry(signal, {
        upstream: (request, response) => {
          configuredUpstreamHits += 1;
          configuredUpstreamTarget = request.url;
          response.writeHead(200, { "content-type": "text/plain" });
          response.end("configured upstream");
        },
      });
      const escapeServer = await useUpstream((_request, response) => {
        escapeServerHits += 1;
        response.writeHead(200, { "content-type": "text/plain" });
        response.end("escaped upstream");
      });
      const escaped = await requestFixtureRegistry(
        port,
        `http://registry.invalid//${new URL(escapeServer.origin).host}/probe`,
      );

      expect(escaped.statusCode).toBe(502);
      expect(escaped.body).toContain("refusing non-origin registry request URL");
      expect(configuredUpstreamHits).toBe(0);
      expect(escapeServerHits).toBe(0);

      const valid = await requestFixtureRegistry(port, "/pkg?x=1");

      expect(valid).toMatchObject({ statusCode: 200, body: "configured upstream" });
      expect(configuredUpstreamHits).toBe(1);
      expect(configuredUpstreamTarget).toBe("/pkg?x=1");
      expect(escapeServerHits).toBe(0);
    }));

  it("gates pre-marker uninstall on the resolved legacy profile", () => {
    const { state, scratch, env } = pluginHome("openclaw-plugins-assertions-");
    writeJson(path.join(scratch, "plugins2-uninstalled.json"), { plugins: [] });
    writeFileSync(
      path.join(scratch, "plugins2-install-path.txt"),
      path.join(state, "extensions", "demo-plugin-tgz"),
    );
    writeJson(path.join(state, "plugins", "installs.json"), { installRecords: {} });
    for (const overrides of [{}, { OPENCLAW_ALLOW_FROZEN_TARGET_SCENARIO_OMISSIONS: "1" }]) {
      const current = runAssertion("plugin-tgz-removed", { ...env, ...overrides });
      expect(current.status).not.toBe(0);
      expect(current.stderr).toContain("exact disabled uninstall marker missing");
    }
    const legacy = runAssertion("plugin-tgz-removed", {
      ...env,
      OPENCLAW_FROZEN_TARGET_PLUGIN_UNINSTALL_MODE: "legacy",
    });

    expect(legacy.status).toBe(0);
  });

  it.each([
    { boundary: "managed root", standaloneHost: false },
    { boundary: "peer host", standaloneHost: false },
    { boundary: "peer host", standaloneHost: true },
    { boundary: "peer symlink", standaloneHost: true },
    { boundary: "optional dependency", standaloneHost: true },
    { boundary: "valid peer", standaloneHost: false },
    { boundary: "valid peer", standaloneHost: true },
  ])(
    "checks ClawHub $boundary (standalone host=$standaloneHost)",
    ({ boundary, standaloneHost }) => {
      const escaped = boundary === "managed root";
      const wrongPeerTarget = boundary === "peer host";
      const { root, state, scratch, env } = pluginHome("openclaw-plugins-clawhub-path-");
      const extensionsRoot = path.join(state, "extensions");
      const installPath = escaped
        ? `${extensionsRoot}${path.sep}..${path.sep}escaped-clawhub`
        : path.join(extensionsRoot, CLAWHUB_ID);
      mkdirSync(extensionsRoot, { recursive: true });
      mkdirSync(installPath, { recursive: true });
      const expectedHostRoot = standaloneHost
        ? path.join(root, "standalone", "runtime")
        : process.cwd();
      mkdirSync(expectedHostRoot, { recursive: true });
      const record = {
        artifactFormat: "zip",
        artifactKind: "legacy-zip",
        clawhubFamily: "code-plugin",
        clawhubPackage: "@openclaw/kitchen-sink",
        installPath,
        source: "clawhub",
        spec: CLAWHUB_SPEC,
        ...(!escaped ? npmArtifact : {}),
      };
      if (record.artifactKind === "npm-pack") {
        mkdirSync(path.join(installPath, "node_modules"), { recursive: true });
        const peerTarget = wrongPeerTarget ? path.join(root, "other-host") : expectedHostRoot;
        if (wrongPeerTarget) {
          mkdirSync(peerTarget);
        }
        const peerPath = path.join(installPath, "node_modules", "openclaw");
        if (boundary === "peer symlink") {
          mkdirSync(peerPath);
        } else {
          symlinkSync(peerTarget, peerPath, process.platform === "win32" ? "junction" : "dir");
        }
        if (boundary === "optional dependency") {
          const dependencyPath = path.join(installPath, "node_modules", "is-number");
          const dependencyTarget = path.join(root, "other-dependency");
          writeJson(path.join(dependencyTarget, "package.json"), { name: "is-number" });
          symlinkSync(
            dependencyTarget,
            dependencyPath,
            process.platform === "win32" ? "junction" : "dir",
          );
        }
      }

      writeJson(path.join(scratch, "plugins-clawhub-installed.json"), {
        plugins: [{ id: CLAWHUB_ID, status: "loaded" }],
      });
      writeJson(path.join(scratch, "plugins-clawhub-inspect.json"), { plugin: { id: CLAWHUB_ID } });
      writeJson(path.join(state, "plugins", "installs.json"), {
        installRecords: { [CLAWHUB_ID]: record },
      });

      const result = runAssertion("clawhub-installed", {
        ...env,
        CLAWHUB_PLUGIN_ID: CLAWHUB_ID,
        CLAWHUB_PLUGIN_SPEC: CLAWHUB_SPEC,
        OPENCLAW_E2E_HOST_ROOT: standaloneHost ? expectedHostRoot : "",
      });

      if (boundary === "valid peer") {
        expect(result.status, result.stderr).toBe(0);
        return;
      }
      expect(result.status).toBe(1);
      if (escaped) {
        expect(result.stderr).toContain("ClawHub install path resolved outside");
      } else {
        const expectedError =
          boundary === "peer symlink"
            ? `ClawHub openclaw peer is not a symlink: ${path.join(installPath, "node_modules", "openclaw")}`
            : wrongPeerTarget
              ? `expected ClawHub openclaw peer ${realpathSync(path.join(root, "other-host"))} to target ${realpathSync(expectedHostRoot)}`
              : `ClawHub isolated dependency resolved outside ${installPath}: ${realpathSync(path.join(root, "other-dependency", "package.json"))}`;
        expect(result.stderr.match(/^(?:Error|error): (.*)$/m)?.[1]).toBe(expectedError);
      }
    },
  );

  it.for(["2147483648", String(Number.MAX_SAFE_INTEGER)])(
    "rejects overflowing ClawHub preflight timeout %s before making a request",
    (timeoutMs, { signal }) =>
      fixtures.run(async () => {
        let requests = 0;
        const result = await clawhubPreflight(
          signal,
          (_request, response) => {
            requests += 1;
            response.end("{}");
          },
          { OPENCLAW_PLUGINS_E2E_CLAWHUB_PREFLIGHT_TIMEOUT_MS: timeoutMs },
        );
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(
          `invalid OPENCLAW_PLUGINS_E2E_CLAWHUB_PREFLIGHT_TIMEOUT_MS: ${timeoutMs}`,
        );
        expect(result.stderr).not.toContain("TimeoutOverflowWarning");
        expect(requests).toBe(0);
      }),
  );

  it("accepts the maximum ClawHub preflight timeout for request and response body", ({ signal }) =>
    fixtures.run(async () => {
      const result = await clawhubPreflight(
        signal,
        (_request, response) => {
          setImmediate(() => {
            response.writeHead(200, { "content-type": "application/json" });
            response.write('{"package":');
            setImmediate(() => {
              response.end(JSON.stringify({ family: "code-plugin", runtimeId: CLAWHUB_ID }) + "}");
            });
          });
        },
        { OPENCLAW_PLUGINS_E2E_CLAWHUB_PREFLIGHT_TIMEOUT_MS: "2147483647" },
      );
      expect(result.status).toBe(0);
      expect(result.stdout).toContain(
        "Using ClawHub package @openclaw/kitchen-sink (code-plugin).",
      );
      expect(result.stderr).not.toContain("TimeoutOverflowWarning");
    }));

  it.for(["request timeout", "body timeout", "body limit"])(
    "bounds ClawHub package preflight: %s",
    (mode, { signal }) =>
      fixtures.run(async () => {
        const bodyTimeout = mode === "body timeout";
        const bodyLimit = mode === "body limit";
        const timeout = bodyTimeout ? "75" : bodyLimit ? "1000" : "25";
        const result = await clawhubPreflight(
          signal,
          (_request, response) => {
            if (bodyLimit) {
              response.writeHead(500, { "content-type": "text/plain" });
              response.end("x".repeat(128));
            } else if (bodyTimeout) {
              response.writeHead(200, { "content-type": "application/json" });
              response.flushHeaders();
              response.write("{");
            }
          },
          {
            NODE_OPTIONS: bodyTimeout
              ? `--import=data:text/javascript,${encodeURIComponent(
                  "const response = await fetch(process.env.OPENCLAW_CLAWHUB_URL); globalThis.fetch = async () => response;",
                )}`
              : process.env.NODE_OPTIONS,
            ...(bodyLimit ? { OPENCLAW_PLUGINS_E2E_CLAWHUB_PREFLIGHT_BODY_MAX_BYTES: "16" } : {}),
            OPENCLAW_PLUGINS_E2E_CLAWHUB_PREFLIGHT_TIMEOUT_MS: timeout,
          },
        );

        expect(result.status).not.toBe(0);
        const label = `ClawHub package preflight${bodyTimeout || bodyLimit ? " response" : ""} for @openclaw/kitchen-sink`;
        expect(result.stderr).toContain(
          `${label} ${bodyLimit ? "response body exceeded 16 bytes" : `timed out after ${timeout}ms`}`,
        );
        if (bodyLimit) {
          expect(result.stderr).not.toContain("xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx");
        }
      }),
  );
});
