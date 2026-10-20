import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import * as tar from "tar";
import { describe, expect, it, vi } from "vitest";
import { PROCESS_NODE_VERSION_CHECK } from "../../../node-version.mjs";
import type { WorkerSshEndpoint } from "../../plugins/types.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import { WORKER_BUNDLE_ARTIFACT_PATHS } from "../../shared/worker-bundle-hash.js";
import { withTestDir } from "../../test-helpers/temp-dir.js";
import { bootstrapWorker as bootstrapWorkerCore } from "./bootstrap.js";
import { registerBootstrapRuntimeProbeTests } from "./bootstrap.runtime-probe.test-support.js";
import { fakeRunner, result } from "./bootstrap.test-support.js";
import { createWorkerBundleProducer, type WorkerInstallationArtifact } from "./bundle.js";

type WorkerBootstrapRequest = Parameters<typeof bootstrapWorkerCore>[0];
type WorkerBootstrapDependencies = Parameters<typeof bootstrapWorkerCore>[1];
type WorkerBootstrapCommandRunner = NonNullable<WorkerBootstrapDependencies["runCommand"]>;

const BUNDLE_HASH = "a".repeat(64);
const TARBALL_SHA256 = "b".repeat(64);
const VERSION = "2026.7.11";
const NPM_INTEGRITY = `sha512-${Buffer.alloc(64).toString("base64")}`;
const OUTPUT_TAG = "OPENCLAW_WORKER_BOOTSTRAP_V1";
const OPERATION_ID = "provision-operation-1";
const OPERATION_TOKEN = createHash("sha256").update(OPERATION_ID).digest("hex");
const UPLOAD_FILENAME = `openclaw-upload-${BUNDLE_HASH}.tgz.${OPERATION_TOKEN}`;
const REMOTE_TARBALL = `/home/worker/.openclaw-worker/.incoming/${UPLOAD_FILENAME}`;
const HOST_KEY = ["ssh-ed25519", "AAAA"].join(" ");
const RECEIPT = {
  bundleHash: BUNDLE_HASH,
  openclawVersion: VERSION,
  protocolFeatures: ["admission-v1"],
};
const RECEIPT_JSON = JSON.stringify(RECEIPT);
const WORKER_CHUNK = "worker-chunk-lazy-A_1.mjs";
const WORKER_ARTIFACT_FIXTURE: Record<string, string> = {
  ...Object.fromEntries(
    WORKER_BUNDLE_ARTIFACT_PATHS.map((name) => [
      name,
      `export const artifact = ${JSON.stringify(name)};\n`,
    ]),
  ),
  "worker.mjs": `const { value } = await import("./${WORKER_CHUNK}"); console.log(value);\n`,
  [WORKER_CHUNK]: 'export { value } from "./worker-chunk-shared-B_2.mjs";\n',
  "worker-chunk-shared-B_2.mjs": 'export const value = "worker chunks loaded";\n',
};

const SSH: WorkerSshEndpoint = {
  host: "worker.example.com",
  port: 2222,
  user: "worker",
  hostKey: HOST_KEY,
  keyRef: { source: "file", provider: "worker-keys", id: "/development-key" },
};

const BUNDLE: WorkerInstallationArtifact = {
  install: "bundle",
  ...RECEIPT,
  tarballBytes: 1,
  tarballSha256: TARBALL_SHA256,
  tarballPath: "/gateway/cache/worker.tgz",
};

function tagged(action: "current" | "install" | "receipt", payload: string): string {
  return `${OUTPUT_TAG}\t${action}\t${payload}\n`;
}

function commandPort(argv: string[]): number {
  const portFlag = argv[0] === "scp" ? "-P" : "-p";
  return Number(argv[argv.indexOf(portFlag) + 1]);
}

const resolveIdentity = async () => ({ kind: "path", path: "/keys/worker" }) as const;
const bootstrapWorker = (
  request: Omit<WorkerBootstrapRequest, "operationId"> & { operationId?: string },
  dependencies: WorkerBootstrapDependencies,
) =>
  bootstrapWorkerCore(
    { operationId: OPERATION_ID, pinnedHostKey: request.ssh.hostKey, ...request },
    dependencies,
  );

function bootstrapWith(
  runner: Pick<ReturnType<typeof fakeRunner>, "runCommand">,
  request: Partial<WorkerBootstrapRequest> = {},
  dependencies: Partial<WorkerBootstrapDependencies> = {},
) {
  return bootstrapWorker(
    { ssh: SSH, artifact: BUNDLE, ...request },
    { resolveIdentity, runCommand: runner.runCommand, ...dependencies },
  );
}

async function rejectBeforeSsh(request: Partial<WorkerBootstrapRequest>, error: string) {
  const runner = fakeRunner([]);
  await expect(bootstrapWith(runner, request)).rejects.toThrow(error);
  expect(runner.calls).toHaveLength(0);
}

async function prepareBundle(root: string, protocolFeatures: string[] = []) {
  const packageRoot = path.join(root, "package");
  await fs.mkdir(path.join(packageRoot, "dist", "worker"), { recursive: true });
  await fs.writeFile(
    path.join(packageRoot, "package.json"),
    `${JSON.stringify({ name: "openclaw", version: VERSION, files: ["dist/"] })}\n`,
  );
  for (const [artifact, contents] of Object.entries(WORKER_ARTIFACT_FIXTURE)) {
    await fs.writeFile(path.join(packageRoot, "dist/worker", artifact), contents, { mode: 0o600 });
  }
  return createWorkerBundleProducer({
    packageRoot,
    cacheDir: path.join(root, "cache"),
    openclawVersion: VERSION,
    protocolFeatures,
  }).prepare();
}

function runBootstrapScript(
  argv: string[],
  remoteHome: string,
  options: Parameters<WorkerBootstrapCommandRunner>[1],
  baseEnv: typeof options.baseEnv = {},
) {
  // Execute the exact shell command sent to SSH, with only the remote environment substituted.
  return runCommandWithTimeout(["sh", "-c", argv.at(-1)!], {
    ...options,
    baseEnv: { ...options.baseEnv, HOME: remoteHome, ...baseEnv },
  });
}

async function expectWorkerRuns(installRoot: string) {
  const worker = await runCommandWithTimeout(
    [process.execPath, path.join(installRoot, "worker.mjs")],
    { timeoutMs: 10_000 },
  );
  expect(worker.code, worker.stderr).toBe(0);
  expect(worker.stdout.trim()).toBe("worker chunks loaded");
}

describe("bootstrapWorker", () => {
  it("does not dispatch SSH after bootstrap cancellation during identity resolution", async () => {
    const controller = new AbortController();
    const closed = new Error("bootstrap canceled");
    const runner = fakeRunner([result({ stdout: tagged("current", RECEIPT_JSON) })]);
    await expect(
      bootstrapWith(
        runner,
        {},
        {
          signal: controller.signal,
          resolveIdentity: async () => {
            controller.abort(closed);
            return { kind: "material", contents: "synthetic-bootstrap-key" };
          },
        },
      ),
    ).rejects.toBe(closed);
    expect(runner.calls).toEqual([]);
  });

  it("skips a matching installed bundle and uses the pinned host key", async () => {
    let knownHosts = "";
    const runner = fakeRunner(
      [result({ stdout: `shell banner\n${tagged("current", RECEIPT_JSON)}login footer\n` })],
      async (argv) => {
        const option = argv.find((value) => value.startsWith("UserKnownHostsFile="));
        if (!option) {
          throw new Error("missing known-hosts option");
        }
        knownHosts = await fs.readFile(option.slice("UserKnownHostsFile=".length), "utf8");
      },
    );

    await expect(
      bootstrapWorker(
        {
          ssh: SSH,
          artifact: BUNDLE,
        },
        { resolveIdentity, runCommand: runner.runCommand },
      ),
    ).resolves.toEqual({
      bundleHash: BUNDLE_HASH,
      openclawVersion: VERSION,
      protocolFeatures: ["admission-v1"],
    });

    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]?.argv[0]).toBe("ssh");
    expect(runner.calls[0]?.argv).toContain("StrictHostKeyChecking=yes");
    expect(runner.calls[0]?.options.input).toContain("actual.openclawVersion");
    expect(runner.calls[0]?.options.input).toContain("openclaw-worker-bundle-v1");
    expect(runner.calls[0]?.options.input).not.toContain("$root/current");
    expect(knownHosts).toBe(`[worker.example.com]:2222 ${HOST_KEY}\n`);
  });

  it("fails before resolving identity or opening SSH when the host-key pin is missing", async () => {
    const runner = fakeRunner([]);
    const resolve = vi.fn(resolveIdentity);
    await expect(
      bootstrapWorkerCore(
        { ssh: SSH, artifact: BUNDLE, operationId: OPERATION_ID },
        {
          resolveIdentity: resolve,
          runCommand: runner.runCommand,
        },
      ),
    ).rejects.toThrow("WorkerProvider.provision() must return ssh.hostKey");
    expect(resolve).not.toHaveBeenCalled();
    expect(runner.calls).toHaveLength(0);
  });

  it.each(["identity", "preflight", "transfer"] as const)(
    "stops bootstrap after ownership changes during %s and cleans only its own upload",
    async (boundary) => {
      let current = true;
      let commands = 0;
      const runner = fakeRunner(
        boundary === "identity"
          ? []
          : [result({ stdout: tagged("install", REMOTE_TARBALL) }), result(), result()],
        () => {
          commands += 1;
          if (
            (boundary === "preflight" && commands === 1) ||
            (boundary === "transfer" && commands === 2)
          ) {
            current = false;
          }
        },
      );
      await expect(
        bootstrapWith(
          runner,
          {},
          {
            resolveIdentity: async () => {
              if (boundary === "identity") {
                current = false;
              }
              return resolveIdentity();
            },
            assertCurrent: () => {
              if (!current) {
                throw new Error("worker owner changed");
              }
            },
          },
        ),
      ).rejects.toThrow("worker owner changed");
      expect(runner.calls.map((call) => call.argv[0])).toEqual(
        boundary === "identity"
          ? []
          : boundary === "preflight"
            ? ["ssh", "ssh"]
            : ["ssh", "scp", "ssh"],
      );
      if (boundary !== "identity") {
        expect(runner.calls.at(-1)?.argv.at(-1)).toContain(OPERATION_TOKEN);
        expect(runner.calls.at(-1)?.argv.at(-1)).toContain(BUNDLE_HASH);
      }
    },
  );

  it("transfers and installs a fresh bundle despite terminal cleanup failure", async () => {
    const runner = fakeRunner([
      result({ stdout: tagged("install", REMOTE_TARBALL) }),
      result(),
      result({ stdout: tagged("receipt", RECEIPT_JSON) }),
      result({ code: 1, stderr: "synthetic cleanup failure" }),
    ]);

    await expect(bootstrapWith(runner)).resolves.toEqual(RECEIPT);
    const [preflight, transfer, install] = runner.calls;
    expect(runner.calls.map((call) => call.argv[0])).toEqual(["ssh", "scp", "ssh", "ssh"]);
    expect(preflight?.argv).toContain("StrictHostKeyChecking=yes");
    expect(runner.calls.flatMap((call) => call.argv)).not.toContain("StrictHostKeyChecking=no");
    expect(transfer?.argv).toEqual(
      expect.arrayContaining([BUNDLE.tarballPath, `worker@worker.example.com:${REMOTE_TARBALL}`]),
    );
    expect(runner.calls.flatMap((call) => call.argv).join(" ")).not.toContain(OPERATION_ID);
    expect(preflight?.argv.at(-1)).toContain(OPERATION_TOKEN);
    expect(install?.options.input).toContain("lock=$lock_root/$hash");
    expect(install?.options.input).toContain('ln -s "$lock_identity" "$lock"');
    expect(install?.options.input).toContain("worker bundle archive digest mismatch");
    expect(install?.options.input).not.toContain('npm install --prefix "$staging"');
    for (const value of [BUNDLE_HASH, TARBALL_SHA256, VERSION]) {
      expect(install?.argv.at(-1)).toContain(value);
    }
  });

  it.each([
    ["floor", 1, 600_000],
    ["scaled", 243_000_000, 1_944_000],
    ["capped", Number.MAX_SAFE_INTEGER, 3_600_000],
  ] as const)(
    "%s transfer timeout while other phases keep the base timeout",
    async (_name, tarballBytes, transferTimeoutMs) => {
      const baseTimeoutMs = 600_000;
      const runner = fakeRunner([
        result({ stdout: tagged("install", REMOTE_TARBALL) }),
        result(),
        result({ stdout: tagged("receipt", RECEIPT_JSON) }),
        result(),
      ]);

      await expect(
        bootstrapWith(
          runner,
          { artifact: { ...BUNDLE, tarballBytes } },
          { timeoutMs: baseTimeoutMs },
        ),
      ).resolves.toEqual(RECEIPT);

      const [preflight, transfer, install] = runner.calls;
      expect(transfer?.argv[0]).toBe("scp");
      for (const [call, limit] of [
        [preflight, baseTimeoutMs],
        [transfer, transferTimeoutMs],
        [install, baseTimeoutMs],
      ] as const) {
        expect(call?.options.timeoutMs).toBeLessThanOrEqual(limit);
        expect(call?.options.timeoutMs).toBeGreaterThanOrEqual(limit - 100);
      }
    },
  );

  it.each([
    { tarballBytes: Number.NaN },
    { tarballBytes: -1 },
    { tarballSha256: "invalid" },
  ] as const)("rejects invalid bundle metadata %j before any remote work", (overrides) =>
    rejectBeforeSsh(
      { artifact: { ...BUNDLE, ...overrides } },
      "tarballBytes" in overrides
        ? "Worker bundle artifact has an invalid tarball size"
        : "archive digest",
    ),
  );

  it.each([
    `/home/worker/other/.incoming/${UPLOAD_FILENAME}`,
    `/home/worker/.openclaw-worker/.incoming/../.incoming/${UPLOAD_FILENAME}`,
    `/home/worker/.openclaw-worker/.incoming/${UPLOAD_FILENAME}.other`,
  ])("rejects a noncanonical or non-owned upload path: %s", async (remotePath) => {
    const runner = fakeRunner([result({ stdout: tagged("install", remotePath) }), result()]);

    await expect(bootstrapWith(runner)).rejects.toThrow(
      "preflight returned an invalid upload path",
    );
    expect(runner.calls).toHaveLength(2);
  });

  it("selects an authenticated fallback before transfer and install", async () => {
    const runner = fakeRunner([
      result({ code: 255, stderr: "primary transport unavailable" }),
      result({ stdout: tagged("install", REMOTE_TARBALL) }),
      result(),
      result({ stdout: tagged("receipt", RECEIPT_JSON) }),
      result(),
    ]);

    await expect(
      bootstrapWorker(
        { ssh: { ...SSH, fallbackPorts: [22] }, artifact: BUNDLE },
        { resolveIdentity, runCommand: runner.runCommand },
      ),
    ).resolves.toEqual(JSON.parse(RECEIPT_JSON));

    expect(runner.calls.map((call) => call.argv[0])).toEqual(["ssh", "ssh", "scp", "ssh", "ssh"]);
    expect(runner.calls.map((call) => commandPort(call.argv))).toEqual([2222, 22, 22, 22, 22]);
    expect(new Set(runner.calls.map((call) => call.argv[call.argv.indexOf("-i") + 1]))).toEqual(
      new Set(["/keys/worker"]),
    );
    expect(
      new Set(
        runner.calls.map((call) =>
          call.argv.find((value) => value.startsWith("UserKnownHostsFile=")),
        ),
      ).size,
    ).toBe(1);
  });

  it.each([
    {
      phase: "transfer",
      commands: ["ssh", "scp", "scp", "ssh", "ssh"],
      ports: [2222, 2222, 22, 22, 22],
    },
    {
      phase: "install",
      commands: ["ssh", "scp", "ssh", "ssh", "ssh"],
      ports: [2222, 2222, 2222, 22, 22],
    },
  ])("retries $phase when the selected port changes", async ({ phase, commands, ports }) => {
    const responses = [
      result({ stdout: tagged("install", REMOTE_TARBALL) }),
      result(),
      result({ stdout: tagged("receipt", RECEIPT_JSON) }),
      result(),
    ];
    responses.splice(
      phase === "transfer" ? 1 : 2,
      0,
      result({ code: 255, stderr: "primary transport unavailable" }),
    );
    const runner = fakeRunner(responses);

    await expect(
      bootstrapWorker(
        { ssh: { ...SSH, fallbackPorts: [22] }, artifact: BUNDLE },
        { resolveIdentity, runCommand: runner.runCommand },
      ),
    ).resolves.toEqual(JSON.parse(RECEIPT_JSON));

    expect(runner.calls.map((call) => call.argv[0])).toEqual(commands);
    expect(runner.calls.map((call) => commandPort(call.argv))).toEqual(ports);
  });

  it.each([
    [42, "OPENCLAW_WORKER_NODE_MISSING\n", "install Node in the provider setup phase"],
    [
      45,
      "OPENCLAW_WORKER_NODE_UNSUPPORTED: v24.14.1\n",
      "Node 24.16.0+ or 26.1.0+ with WAL-reset-safe SQLite",
    ],
  ] as const)(
    "reports provider setup guidance for Node.js failure %s",
    async (code, stderr, error) => {
      const runner = fakeRunner([result({ code, stderr }), result()]);
      await expect(bootstrapWith(runner)).rejects.toThrow(error);
      expect(runner.calls).toHaveLength(2);
      if (code === 45) {
        expect(runner.calls[0]?.options.input).toContain(
          `const nodeSafe = ${PROCESS_NODE_VERSION_CHECK};`,
        );
        expect(runner.calls[0]?.options.input).toContain("SELECT sqlite_version() AS version");
      }
    },
  );

  registerBootstrapRuntimeProbeTests({
    bootstrapWorker,
    resolveIdentity,
    ssh: SSH,
    artifact: BUNDLE,
    currentReceipt: tagged("current", RECEIPT_JSON),
  });

  it.each([
    { version: VERSION, error: `exact package openclaw@${VERSION}` },
    { version: "latest", error: "must use exact package" },
  ])(
    "rejects the latest npm tag even with version $version before opening SSH",
    ({ version, error }) => {
      const artifact: WorkerInstallationArtifact = {
        install: "npm",
        bundleHash: BUNDLE_HASH,
        openclawVersion: version,
        protocolFeatures: [],
        packageIntegrity: NPM_INTEGRITY,
        packageSpec: "openclaw@latest",
      };

      return rejectBeforeSsh({ artifact }, error);
    },
  );

  it("rejects an explicitly supplied empty host key instead of falling back", () =>
    rejectBeforeSsh({ pinnedHostKey: "" }, "OpenSSH public-key format"));

  it("materializes inline identity data privately and removes it after use", async () => {
    let identityPath = "";
    let identityContents = "";
    let identityMode = 0;
    const runCommand: WorkerBootstrapCommandRunner = async (argv) => {
      const identityIndex = argv.indexOf("-i");
      identityPath = argv[identityIndex + 1] ?? "";
      identityContents = await fs.readFile(identityPath, "utf8");
      identityMode = (await fs.stat(identityPath)).mode & 0o777;
      return result({ stdout: tagged("current", RECEIPT_JSON) });
    };

    await bootstrapWorker(
      { ssh: SSH, artifact: BUNDLE },
      {
        resolveIdentity: async () => ({
          kind: "material",
          contents: "fake-key-start\\nkey-data\\r\\nfake-key-end",
        }),
        runCommand,
      },
    );

    expect(identityContents).toBe("fake-key-start\nkey-data\nfake-key-end\n");
    if (process.platform !== "win32") {
      expect(identityMode).toBe(0o600);
    }
    await expect(fs.stat(identityPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a stale remote receipt instead of synthesizing the expected fields", async () => {
    const staleReceipt = JSON.stringify({ ...RECEIPT, openclawVersion: "2026.7.10" });
    const runner = fakeRunner([result({ stdout: tagged("current", staleReceipt) }), result()]);

    await expect(bootstrapWith(runner)).rejects.toThrow("receipt does not match");
    expect(runner.calls).toHaveLength(2);
  });

  it.each(["bundle transfer", "install"] as const)(
    "does not retry fallback after a non-255 %s failure and cleans up the upload",
    async (phase) => {
      const transferFailure = phase === "bundle transfer";
      const runner = fakeRunner([
        result({ stdout: tagged("install", REMOTE_TARBALL) }),
        transferFailure ? result({ code: 1, stderr: "transfer rejected" }) : result(),
        transferFailure
          ? result({ code: 255, stderr: "selected port changed" })
          : result({ code: 1, stderr: "install rejected" }),
        result(),
      ]);

      await expect(bootstrapWith(runner, { ssh: { ...SSH, fallbackPorts: [22] } })).rejects.toThrow(
        `Worker bootstrap ${phase} failed`,
      );

      expect(runner.calls.map((call) => call.argv[0])).toEqual(["ssh", "scp", "ssh", "ssh"]);
      const phaseCalls = runner.calls.filter((call) =>
        transferFailure
          ? call.argv[0] === "scp"
          : typeof call.options.input === "string" &&
            call.options.input.includes("receipt_json=$5"),
      );
      expect(phaseCalls).toHaveLength(1);
      expect(commandPort(phaseCalls[0]!.argv)).toBe(2222);

      const cleanupCalls = runner.calls.filter(
        (call) =>
          typeof call.options.input === "string" &&
          call.options.input.includes("operation_token=$2"),
      );
      expect(cleanupCalls.map((call) => commandPort(call.argv))).toEqual(
        transferFailure ? [2222, 22] : [2222],
      );
      expect(cleanupCalls.every((call) => call.argv.at(-1)?.includes(BUNDLE_HASH))).toBe(true);
      expect(cleanupCalls.every((call) => call.argv.at(-1)?.includes(OPERATION_TOKEN))).toBe(true);
      expect(cleanupCalls.every((call) => call.options.signal === undefined)).toBe(true);
    },
  );

  it("keeps bootstrap failure details on a valid UTF-16 boundary", async () => {
    const prefix = "e".repeat(511);
    const runner = fakeRunner([result({ code: 1, stderr: `${prefix}😀 tail` }), result()]);

    await expect(
      bootstrapWorker(
        { ssh: SSH, artifact: BUNDLE },
        { resolveIdentity, runCommand: runner.runCommand },
      ),
    ).rejects.toThrow(`Worker bootstrap preflight failed (exit 1): ${prefix}`);
  });
  it.skipIf(process.platform === "win32")(
    "reuses and finally cleans the operation upload across ambiguous candidate attempts",
    () =>
      withTestDir({ prefix: "openclaw-worker-bootstrap-script-" }, async (root) => {
        const remoteHome = path.join(root, "remote-home");
        const artifact = await prepareBundle(root, ["admission-v1"]);
        const bootstrapRoot = path.join(remoteHome, ".openclaw-worker");
        const installRoot = path.join(bootstrapRoot, artifact.bundleHash);
        const fakeBin = path.join(root, "fake-bin");
        await fs.mkdir(fakeBin);
        await fs.writeFile(path.join(fakeBin, "tar"), "#!/bin/sh\nexit 255\n", { mode: 0o755 });
        const receiptJson = JSON.stringify({ ...RECEIPT, bundleHash: artifact.bundleHash });
        const staleStaging = path.join(bootstrapRoot, `.staging-${artifact.bundleHash}-99999`);
        await fs.mkdir(staleStaging, { recursive: true });
        await fs.writeFile(path.join(staleStaging, "partial"), "abandoned install");
        const staleLock = path.join(bootstrapRoot, ".locks", artifact.bundleHash);
        await fs.mkdir(path.dirname(staleLock), { recursive: true });
        // A reused live PID must not keep a crashed install locked forever.
        await fs.symlink(`${process.pid}:1`, staleLock);
        let remoteTarball = "";
        let transfers = 0;
        let syntheticPreflightFailures = 2;
        let installAttempts = 0;
        let uploadSurvivedAmbiguousInstall = false;
        let cleanupAttempts = 0;
        const preflightPaths: string[] = [];
        const runCommand: WorkerBootstrapCommandRunner = async (argv, options) => {
          if (argv[0] === "scp") {
            transfers += 1;
            const destination = argv.at(-1) ?? "";
            remoteTarball = destination.slice(destination.indexOf(":") + 1);
            await fs.copyFile(artifact.tarballPath, remoteTarball);
            return result();
          }
          const isPreflight =
            typeof options.input === "string" && options.input.includes("expected_receipt=$2");
          const isInstall =
            typeof options.input === "string" && options.input.includes("receipt_json=$5");
          if (typeof options.input === "string" && options.input.includes("operation_token=$2")) {
            cleanupAttempts += 1;
          }
          if (isInstall && installAttempts === 1) {
            uploadSurvivedAmbiguousInstall = await fs
              .stat(remoteTarball)
              .then((stats) => stats.isFile())
              .catch(() => false);
          }
          const useFailingTar = isInstall && installAttempts === 0;
          if (isInstall) {
            installAttempts += 1;
          }
          const shellResult = await runBootstrapScript(argv, remoteHome, options, {
            PATH: useFailingTar
              ? `${fakeBin}:${options.baseEnv?.PATH ?? ""}`
              : options.baseEnv?.PATH,
          });
          if (isPreflight) {
            const taggedRecord = shellResult.stdout
              .split(/\r?\n/u)
              .find((line) => line.startsWith(`${OUTPUT_TAG}\tinstall\t`));
            if (taggedRecord) {
              preflightPaths.push(taggedRecord.slice(taggedRecord.lastIndexOf("\t") + 1));
            }
            if (syntheticPreflightFailures > 0) {
              syntheticPreflightFailures -= 1;
              return result({ code: 255, stderr: "synthetic ambiguous preflight" });
            }
          }
          return shellResult;
        };

        const bootstrapRequest = { ssh: { ...SSH, fallbackPorts: [22] }, artifact };
        const run = (request: Partial<WorkerBootstrapRequest> = bootstrapRequest) =>
          bootstrapWith({ runCommand }, request);
        await expect(run()).rejects.toThrow("Worker bootstrap preflight failed (exit 255)");
        expect(preflightPaths).toHaveLength(2);
        await expect(fs.stat(preflightPaths[0]!)).rejects.toMatchObject({ code: "ENOENT" });

        syntheticPreflightFailures = 1;
        await expect(run()).resolves.toEqual(JSON.parse(receiptJson));

        await expectWorkerRuns(installRoot);

        const tamperedDependency = path.join(installRoot, "node_modules", "tampered.js");
        await fs.mkdir(path.dirname(tamperedDependency), { recursive: true });
        await fs.writeFile(tamperedDependency, "export const trusted = false;\n");
        await expect(run()).resolves.toEqual(JSON.parse(receiptJson));
        await expect(fs.stat(tamperedDependency)).rejects.toMatchObject({ code: "ENOENT" });

        const operationUpload = preflightPaths[0]!;
        const staleUpload = path.join(
          path.dirname(operationUpload),
          `openclaw-upload-${"c".repeat(64)}.tgz.${"d".repeat(64)}`,
        );
        await fs.writeFile(operationUpload, "ambiguous prior upload");
        await fs.writeFile(staleUpload, "stale upload");
        const staleTime = new Date(Date.now() - 61 * 60_000);
        await fs.utimes(staleUpload, staleTime, staleTime);
        const cleanupAttemptsBeforeCurrent = cleanupAttempts;
        await expect(run({ ssh: SSH, artifact })).resolves.toEqual(JSON.parse(receiptJson));
        expect(cleanupAttempts).toBe(cleanupAttemptsBeforeCurrent);

        expect(transfers).toBe(2);
        expect(preflightPaths).toHaveLength(5);
        expect(new Set(preflightPaths).size).toBe(1);
        expect(path.basename(preflightPaths[0]!)).toBe(
          `openclaw-upload-${artifact.bundleHash}.tgz.${OPERATION_TOKEN}`,
        );
        expect(installAttempts).toBe(3);
        expect(uploadSurvivedAmbiguousInstall).toBe(true);
        await expect(fs.stat(remoteTarball)).rejects.toMatchObject({ code: "ENOENT" });
        await expect(fs.stat(operationUpload)).rejects.toMatchObject({ code: "ENOENT" });
        await expect(fs.stat(staleUpload)).rejects.toMatchObject({ code: "ENOENT" });
        await expect(fs.stat(staleStaging)).rejects.toMatchObject({ code: "ENOENT" });
        await expect(fs.lstat(staleLock)).rejects.toMatchObject({ code: "ENOENT" });
        await expect(
          fs.readFile(path.join(installRoot, "bootstrap-receipt.json"), "utf8"),
        ).resolves.toBe(`${receiptJson}\n`);
      }),
  );

  it.skipIf(process.platform === "win32").each(["incoming", "root"] as const)(
    "refuses a poisoned bootstrap %s without modifying its target",
    (poisoned) =>
      withTestDir({ prefix: "openclaw-worker-bootstrap-path-" }, async (root) => {
        const remoteHome = path.join(root, "remote-home");
        const unrelated = path.join(root, "unrelated");
        const bootstrapRoot = path.join(remoteHome, ".openclaw-worker");
        const link =
          poisoned === "incoming" ? path.join(bootstrapRoot, ".incoming") : bootstrapRoot;
        const sentinel =
          poisoned === "incoming"
            ? path.join(unrelated, "sentinel")
            : path.join(unrelated, ".incoming", UPLOAD_FILENAME);
        await fs.mkdir(path.dirname(link), { recursive: true });
        await fs.mkdir(path.dirname(sentinel), { recursive: true });
        await fs.writeFile(sentinel, "keep");
        await fs.symlink(unrelated, link);
        const runCommand: WorkerBootstrapCommandRunner = (argv, options) =>
          runBootstrapScript(argv, remoteHome, options);
        await expect(bootstrapWith({ runCommand })).rejects.toThrow(
          "unsafe worker bootstrap directory",
        );
        await expect(fs.readFile(sentinel, "utf8")).resolves.toBe("keep");
      }),
  );

  it.skipIf(process.platform === "win32")(
    "installs, reuses, and repairs split worker artifacts from an integrity-pinned npm archive",
    () =>
      withTestDir({ prefix: "openclaw-worker-bootstrap-npm-artifact-" }, async (root) => {
        const packageRoot = path.join(root, "package");
        const remoteHome = path.join(root, "remote-home");
        await fs.mkdir(remoteHome);
        const bundle = await prepareBundle(root);
        const packagedWorkerRoot = path.join(packageRoot, "dist/worker-artifacts");
        await fs.mkdir(packagedWorkerRoot);
        await fs.copyFile(
          bundle.tarballPath,
          path.join(packagedWorkerRoot, `${bundle.bundleHash}.tar.gz`),
        );
        await fs.rm(path.join(packageRoot, "dist/worker"), { recursive: true });
        const packageArchive = path.join(root, "package.tgz");
        await tar.create({ cwd: root, file: packageArchive, gzip: true }, ["package"]);
        const packageIntegrity = `sha512-${createHash("sha512")
          .update(await fs.readFile(packageArchive))
          .digest("base64")}`;
        const fakeBin = path.join(root, "fake-bin");
        await fs.mkdir(fakeBin);
        await fs.writeFile(
          path.join(fakeBin, "npm"),
          `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const destination = process.argv[process.argv.indexOf("--pack-destination") + 1];
fs.copyFileSync(${JSON.stringify(packageArchive)}, path.join(destination, "package.tgz"));
console.log(JSON.stringify([{ filename: "package.tgz" }]));`,
          { mode: 0o755 },
        );
        const receipt = {
          bundleHash: bundle.bundleHash,
          openclawVersion: VERSION,
          protocolFeatures: [],
        };
        const artifact: WorkerInstallationArtifact = {
          install: "npm",
          ...receipt,
          packageIntegrity,
          packageSpec: `openclaw@${VERSION}`,
        };
        const receiptJson = JSON.stringify(receipt);
        const installRoot = path.join(remoteHome, ".openclaw-worker", bundle.bundleHash);
        let installAttempts = 0;
        const runCommand: WorkerBootstrapCommandRunner = async (argv, options) => {
          const isInstall =
            typeof options.input === "string" && options.input.includes("receipt_json=$5");
          if (isInstall) {
            installAttempts += 1;
          }
          return runBootstrapScript(argv, remoteHome, options, {
            PATH: `${fakeBin}:${options.baseEnv?.PATH ?? ""}`,
          });
        };
        const run = () => bootstrapWith({ runCommand }, { artifact });
        await expect(run()).resolves.toEqual(receipt);
        expect(installAttempts).toBe(1);
        expect((await fs.readdir(installRoot)).toSorted()).toEqual(
          ["bootstrap-receipt.json", ...Object.keys(WORKER_ARTIFACT_FIXTURE)].toSorted(),
        );
        for (const [artifactName, contents] of Object.entries(WORKER_ARTIFACT_FIXTURE)) {
          await expect(fs.readFile(path.join(installRoot, artifactName), "utf8")).resolves.toBe(
            contents,
          );
          expect((await fs.stat(path.join(installRoot, artifactName))).mode & 0o777).toBe(0o700);
        }
        await expect(
          fs.readFile(path.join(installRoot, "bootstrap-receipt.json"), "utf8"),
        ).resolves.toBe(`${receiptJson}\n`);

        await expect(run()).resolves.toEqual(receipt);
        expect(installAttempts).toBe(1);

        await fs.writeFile(path.join(installRoot, WORKER_CHUNK), "export {};\n");
        await expect(run()).resolves.toEqual(receipt);
        expect(installAttempts).toBe(2);
        await expectWorkerRuns(installRoot);
      }),
  );
});
