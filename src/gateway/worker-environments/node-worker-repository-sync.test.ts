import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { redactLogRecordForTransport } from "../../logging/redact.js";
import { NodeWorkerWorkspaceRuntime } from "../../node-host/node-worker-workspace.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import { parseNodeWorkerWorkspaceExecResult } from "../../worker/node-workspace-protocol.js";
import { environment } from "./node-worker-tunnel.test-support.js";
import { createNodeWorkerWorkspaceActions } from "./node-worker-workspace-actions.js";
import { createNodeWorkspaceTransferService } from "./node-workspace-transfer-service.js";
import { startNodeWorkspaceTransferTestServer } from "./node-workspace-transfer.test-support.js";
import type { WorkerWorkspaceReconcileRequest } from "./tunnel-contract.js";
import { verifyReconciledWorkspaceFinal } from "./workspace-finalize.js";
import {
  parseRemoteWorkspaceManifestEnvelope,
  type RemoteWorkspaceManifestEnvelope,
} from "./workspace-hash-memo.js";
import { createWorkerWorkspaceActions } from "./workspace-sync.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const setupDiagnostics = vi.hoisted(() => vi.fn());
const placementDiagnostics = vi.hoisted(() => vi.fn());
vi.mock("../../logging/subsystem.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../logging/subsystem.js")>();
  return {
    ...actual,
    createSubsystemLogger: (name: string) => {
      const logger = actual.createSubsystemLogger(name);
      return name === "gateway/worker-workspace"
        ? { ...logger, warn: setupDiagnostics, info: setupDiagnostics }
        : name === "gateway/worker-placement"
          ? { ...logger, info: placementDiagnostics }
          : logger;
    },
  };
});

it.each(["errno", "nested", "rpc", "unknown", "abort", "sink", "hostile"] as const)(
  "reports the failed repository preparation without exposing private error data: %s",
  async (kind) => {
    placementDiagnostics.mockReset();
    if (kind === "sink") {
      placementDiagnostics.mockImplementationOnce(() => {
        throw new Error("private sink failure");
      });
    }
    const secret = "private-repository-error-body";
    const code = kind === "rpc" ? "UNAVAILABLE" : kind === "unknown" ? secret : "EIO";
    const cause = Object.assign(new Error(secret), { code });
    const failure = kind === "nested" ? new Error(secret, { cause }) : cause;
    if (kind === "abort") {
      failure.name = "AbortError";
      cause.code = secret;
    }
    if (kind === "hostile") {
      Object.defineProperty(failure, "code", {
        get: () => {
          throw new Error(secret);
        },
      });
    }
    const record = environment();
    const service = createNodeWorkspaceTransferService({
      temporaryRoot: tempDirs.make("node-preparation-diagnostics-"),
      getOwner: () => ({
        environment: record,
        credential: { ownerEpoch: record.ownerEpoch, sessionId: "session-1" },
      }),
    });
    const actions = createNodeWorkerWorkspaceActions({
      environmentId: record.environmentId,
      ownerEpoch: record.ownerEpoch,
      sessionId: "session-1",
      ownerSignal: new AbortController().signal,
      isOwnerCurrent: () => true,
      workspaceTransfer: service,
      runWorkspaceCommand: async (command) => {
        command.assertCurrent?.();
        throw failure;
      },
    });
    try {
      await expect(
        actions.syncWorkspace({
          sessionId: "session-1",
          sessionKey: "agent:main:diagnostics",
          generation: 17,
          source: {
            kind: "repository",
            url: "https://example.invalid/private-source.git",
            branch: "accepted",
            baseCommit: "a".repeat(40),
            gitToken: secret,
          },
        }),
      ).rejects.toBe(failure);
      const events = placementDiagnostics.mock.calls.map(([, facts]) => facts);
      expect(events).toContainEqual(
        expect.objectContaining({
          stage: "repository_prepare_failed",
          sessionId: "session-1",
          environmentId: record.environmentId,
          ownerEpoch: record.ownerEpoch,
          generation: 17,
          diagnosticCode: "operation_failed",
          elapsedMs: expect.any(Number),
          innerDiagnosticCode:
            kind === "unknown" || kind === "hostile"
              ? undefined
              : kind === "abort"
                ? "ABORT_ERR"
                : kind === "rpc"
                  ? "UNAVAILABLE"
                  : "EIO",
        }),
      );
      const logged = JSON.stringify(events);
      expect(logged).not.toContain(secret);
      expect(logged).not.toContain("private-source.git");
      expect(logged).not.toContain("stack");
    } finally {
      await service.closeAll();
    }
  },
);

it.each([
  "exit",
  "timeout",
  "malformed",
  "partial",
  "success",
  "extended-success",
  "extended-failure",
  "sequence-bound",
  "sink-success",
  "sink-failure",
] as const)(
  "preserves safe repository setup result diagnostics through redaction: %s",
  async (outcome) => {
    setupDiagnostics.mockReset();
    const succeeded = ["success", "extended-success", "sequence-bound", "sink-success"].includes(
      outcome,
    );
    if (outcome === "sink-success" || outcome === "sink-failure") {
      setupDiagnostics.mockImplementation(() => {
        throw new Error("synthetic private diagnostic sink");
      });
    }
    const record = environment();
    const baseCommit = "c".repeat(40);
    const baseManifestRef = `sha256:${"d".repeat(64)}`;
    const marker =
      outcome === "extended-success" || outcome === "extended-failure"
        ? "TEAMCLAW_SETUP_V1 stage=env_load outcome=succeeded\nTEAMCLAW_SETUP_V1 stage=credential_acquisition outcome=started elapsedMs=0\nTEAMCLAW_SETUP_V1 stage=credential_transport outcome=succeeded elapsedMs=7\n" +
          (succeeded
            ? "TEAMCLAW_SETUP_V1 stage=credential_acquisition outcome=succeeded elapsedMs=2147483647\n"
            : 'TEAMCLAW_SETUP_V1 stage=credential_acquisition outcome=failed exit=255 elapsedMs=9\n{"event":"worker_feed_managed_identity","code":"http_rejected","httpStatus":400,"imdsErrorCode":"invalid_request","imdsErrorCategory":"identity_not_found","extra":"PRIVATE_CANARY"}\n')
        : outcome === "sequence-bound"
          ? "TEAMCLAW_SETUP_V1 stage=env_load outcome=started elapsedMs=0\n".repeat(30) +
            "TEAMCLAW_SETUP_V1 stage=env_load outcome=succeeded\n"
          : outcome === "exit"
            ? "TEAMCLAW_SETUP_V1 stage=toolchain_install outcome=started\nTEAMCLAW_SETUP_V1 stage=toolchain_install outcome=failed exit=7\n"
            : outcome === "timeout"
              ? "TEAMCLAW_SETUP_V1 stage=compiler_probe outcome=started\n"
              : "TEAMCLAW_SETUP_V1 stage=unknown outcome=failed exit=7\nTEAMCLAW_SETUP_V1 stage=env_load outcome=succeeded exit=0\nTEAMCLAW_SETUP_V1 stage=clippy_probe outcome=failed exit=9999\n" +
                ["01", "-1", "1.5", "1e3", "2147483648", "99999999999", "NaN", "Infinity"]
                  .map(
                    (value) =>
                      `TEAMCLAW_SETUP_V1 stage=credential_transport outcome=succeeded elapsedMs=${value}\n`,
                  )
                  .join("") +
                "TEAMCLAW_SETUP_V1 stage=env_load outcome=failed elapsedMs=1 exit=1\nTEAMCLAW_SETUP_V1 stage=env_load outcome=failed exit=01\nTEAMCLAW_SETUP_V1 stage=env_load outcome=succeeded elapsedMs=1 extra=private\n" +
                '{"event":"worker_feed_managed_identity","code":"PRIVATE_CANARY","httpStatus":400}\n' +
                '{"event":"worker_feed_managed_identity","code":"http_rejected","httpStatus":"PRIVATE_CANARY"}\n' +
                '{"event":"worker_feed_managed_identity","code":"http_rejected","httpStatus":600}\n';
    const service = createNodeWorkspaceTransferService({
      temporaryRoot: tempDirs.make("node-setup-diagnostics-"),
      getOwner: () => ({
        environment: record,
        credential: { ownerEpoch: record.ownerEpoch, sessionId: "session-1" },
      }),
    });
    const run = vi.fn(
      async (
        command: Parameters<
          Parameters<typeof createNodeWorkerWorkspaceActions>[0]["runWorkspaceCommand"]
        >[0],
      ) => {
        command.assertCurrent?.();
        const setup = command.argv[2]?.includes("worktree-setup.sh") === true;
        const result = {
          workspaceDir: "/node/workspace",
          stdout: setup
            ? "private setup stdout"
            : command.argv.at(-1) === "memo-v1"
              ? JSON.stringify({
                  version: 1,
                  manifestRef: baseManifestRef,
                  memo: [],
                  metrics: {
                    contentHashCount: 0,
                    contentHashDurationMs: 0,
                    memoHitCount: 0,
                    memoTruncatedCount: 0,
                    totalDurationMs: 0,
                  },
                })
              : command.argv.includes("rev-parse")
                ? baseCommit
                : baseManifestRef,
          stderr: setup
            ? outcome === "partial"
              ? "private setup stderr\nTEAMCLAW_SETUP_V1 stage=provenance outcome=started"
              : `${marker}private setup stderr\n`
            : "",
          code: setup ? (outcome === "timeout" ? null : succeeded ? 0 : 7) : 0,
          signal:
            setup && outcome === "timeout"
              ? "SIGTERM"
              : setup && outcome === "malformed"
                ? "PRIVATE_CANARY"
                : null,
          killed: setup && outcome === "timeout",
          termination: setup && outcome === "timeout" ? "timeout" : "exit",
          ...(setup
            ? { stderrTruncatedBytes: 9, stdoutTruncatedBytes: 3, outputLimitExceeded: false }
            : {}),
        };
        const parsed = parseNodeWorkerWorkspaceExecResult(result);
        if (!parsed) {
          throw new Error("Invalid synthetic node result");
        }
        return parsed;
      },
    );
    const actions = createNodeWorkerWorkspaceActions({
      environmentId: record.environmentId,
      ownerEpoch: record.ownerEpoch,
      sessionId: "session-1",
      ownerSignal: new AbortController().signal,
      isOwnerCurrent: () => true,
      workspaceTransfer: service,
      runWorkspaceCommand: run,
    });
    try {
      const sync = actions.syncWorkspace({
        sessionId: "session-1",
        sessionKey: "agent:main:setup",
        generation: 17,
        source: {
          kind: "repository",
          url: "https://example.invalid/repository.git",
          branch: "accepted-branch",
          baseCommit,
          runSetupScript: true,
        },
      });
      if (succeeded) {
        await expect(sync).resolves.toMatchObject({ baseCommit, manifestRef: baseManifestRef });
        expect(setupDiagnostics).toHaveBeenCalledOnce();
      } else {
        await expect(sync).rejects.toThrow();
        expect(setupDiagnostics).toHaveBeenCalledOnce();
        const details = redactLogRecordForTransport(setupDiagnostics.mock.calls[0]![1], {
          format: "console",
        });
        expect(details).toMatchObject({
          phase: "repository_setup",
          environmentId: record.environmentId,
          ownerEpoch: record.ownerEpoch,
          sessionId: "session-1",
          sessionKey: "agent:main:setup",
          placementGeneration: 17,
          baseCommit,
          baseManifestRef,
          scriptPath: ".openclaw/worktree-setup.sh",
          configuredTimeoutMs: 120_000,
          exitCode: outcome === "timeout" ? null : 7,
          termination: outcome === "timeout" ? "timeout" : "exit",
          killed: outcome === "timeout",
          timedOut: outcome === "timeout",
          stderrTruncatedBytes: 9,
          stdoutTruncatedBytes: 3,
        });
        expect(details.elapsedMs).toEqual(expect.any(Number));
        if (outcome === "extended-failure") {
          expect(details).toMatchObject({
            helperStage: "credential_acquisition",
            helperOutcome: "failed",
            helperExitCode: 255,
            helperElapsedMs: 9,
            helperMarkerCount: 4,
            workerFeedManagedIdentity: {
              diagnosticCode: "http_rejected",
              httpStatus: 400,
              imdsErrorCode: "invalid_request",
              imdsErrorCategory: "identity_not_found",
            },
          });
          expect(details.helperMarkers).toEqual([
            expect.objectContaining({ helperStage: "env_load", helperOutcome: "succeeded" }),
            expect.objectContaining({ helperStage: "credential_acquisition", helperElapsedMs: 0 }),
            expect.objectContaining({ helperStage: "credential_transport", helperElapsedMs: 7 }),
            expect.objectContaining({ helperStage: "credential_acquisition", helperElapsedMs: 9 }),
          ]);
        } else if (outcome === "exit" || outcome === "timeout") {
          expect(details).toMatchObject({
            helperStage: outcome === "exit" ? "toolchain_install" : "compiler_probe",
            helperOutcome: outcome === "exit" ? "failed" : "started",
          });
          if (outcome === "exit") {
            expect(details.helperExitCode).toBe(7);
          }
        } else {
          expect(details.helperStage).toBeUndefined();
          expect(details.signal).toBeUndefined();
          expect(details.workerFeedManagedIdentity).toBeUndefined();
        }
        const serialized = JSON.stringify(details);
        for (const value of [
          "private setup stdout",
          "private setup stderr",
          "PRIVATE_CANARY",
          "TEAMCLAW_SETUP_V1",
        ]) {
          expect(serialized).not.toContain(value);
        }
      }
      if (succeeded) {
        const [message, raw] = setupDiagnostics.mock.calls[0]!;
        expect(message).toBe("worker repository setup completed");
        const details = redactLogRecordForTransport(raw);
        expect(details).toMatchObject({ exitCode: 0, termination: "exit" });
        if (outcome === "extended-success") {
          expect(details).toMatchObject({
            helperStage: "credential_acquisition",
            helperElapsedMs: 2147483647,
            helperMarkerCount: 4,
          });
          expect(details.helperMarkers).toEqual([
            expect.not.objectContaining({ helperElapsedMs: expect.any(Number) }),
            expect.objectContaining({ helperElapsedMs: 0 }),
            expect.objectContaining({ helperStage: "credential_transport", helperElapsedMs: 7 }),
            expect.objectContaining({ helperElapsedMs: 2147483647 }),
          ]);
        } else if (outcome === "sequence-bound") {
          expect(details.helperMarkerCount).toBe(31);
          expect(details.helperMarkers).toHaveLength(24);
          expect(details.helperElapsedMs).toBeUndefined();
        }
        expect(JSON.stringify(details)).not.toMatch(
          /private setup|PRIVATE_CANARY|TEAMCLAW_SETUP_V1/u,
        );
      }
      const setupCommand = run.mock.calls.find(([command]) =>
        command.argv[2]?.includes("worktree-setup.sh"),
      )?.[0];
      expect(setupCommand).toMatchObject({ timeoutMs: 120_000, transportRetry: "never" });
    } finally {
      await service.closeAll();
      setupDiagnostics.mockReset();
    }
  },
);

it.each([
  { operation: "clone", reason: "clone-failed", stage: "git clone" },
  { operation: "checkout", reason: "checkout-failed", stage: "git checkout --detach" },
])("surfaces $reason diagnostics to cloud placement", async ({ operation, reason, stage }) => {
  const service = createNodeWorkspaceTransferService({
    temporaryRoot: tempDirs.make("node-repository-failure-"),
    getOwner: () => undefined,
  });
  const actions = createNodeWorkerWorkspaceActions({
    environmentId: "environment-1",
    ownerEpoch: 1,
    sessionId: "session-1",
    ownerSignal: new AbortController().signal,
    isOwnerCurrent: () => true,
    workspaceTransfer: service,
    runWorkspaceCommand: async ({ argv }) => ({
      stdout: argv.includes("rev-parse") ? "a".repeat(40) : "",
      stderr: argv.includes(operation) ? "fatal: Permission denied\n" : "",
      code: argv.includes(operation) ? 128 : 0,
      signal: null,
      killed: false,
      termination: "exit",
      workspaceDir: "/node/workspace",
    }),
  });
  try {
    await expect(
      actions.syncWorkspace({
        sessionId: "session-1",
        generation: 1,
        source: {
          kind: "repository",
          url: "https://example.invalid/repository.git",
          branch: "openclaw/session",
        },
      }),
    ).rejects.toThrow(
      `Cloud repository preparation failed: ${reason}: ${stage}: exit (exit code 128, signal null): fatal: Permission denied`,
    );
  } finally {
    await service.closeAll();
  }
});

it("rejects repository sources on SSH before invoking any remote command", async () => {
  const run = vi.fn();
  const waitForPrepared = vi.fn();
  const actions = createWorkerWorkspaceActions({
    environmentId: "environment-ssh",
    ownerSignal: new AbortController().signal,
    runner: { run },
    waitForPrepared,
    tasks: new Set(),
    bundleHash: "a".repeat(64),
  });
  await expect(
    actions.syncWorkspace({
      sessionId: "session-ssh",
      generation: 1,
      source: {
        kind: "repository",
        url: "https://github.com/example/repository.git",
        branch: "openclaw/session",
      },
    }),
  ).rejects.toThrow("managed node");
  await expect(
    actions.reconcileWorkspace({
      remoteWorkspaceDir: "/worker/workspace",
      baseManifestRef: `sha256:${"b".repeat(64)}`,
      source: {
        kind: "repository",
        referenceManifestRef: `sha256:${"b".repeat(64)}`,
        prepareCheckpoint: vi.fn(),
      },
    }),
  ).rejects.toThrow("managed node");
  expect(waitForPrepared).not.toHaveBeenCalled();
  expect(run).not.toHaveBeenCalled();
});

it.each([
  { publication: "available", filters: false, closeOwner: false },
  { publication: "blocked by filters", filters: true, closeOwner: false },
  { publication: "blocked when the owner closes", filters: true, closeOwner: true },
])(
  "preserves repository checkpoints with publication $publication",
  async ({ filters, closeOwner }) => {
    const root = await fs.realpath(tempDirs.make("node-repository-roundtrip-"));
    const origin = path.join(root, "origin");
    const home = path.join(root, "node-home");
    await fs.mkdir(path.join(origin, ".openclaw"), { recursive: true });
    await fs.writeFile(path.join(origin, ".gitignore"), "*.ignored\n");
    await fs.writeFile(path.join(origin, ".worktreeinclude"), "retained.ignored\n");
    await fs.writeFile(path.join(origin, "retained-removal.ignored"), "keep recovered bytes\n");
    await fs.writeFile(path.join(origin, "tracked.txt"), "base\n");
    await fs.writeFile(path.join(origin, "a-original.txt"), "turn one\n");
    if (filters) {
      await fs.writeFile(path.join(origin, ".gitattributes"), "*.dat filter=example\n");
    }
    await fs.writeFile(
      path.join(origin, ".openclaw", "worktree-setup.sh"),
      "#!/bin/sh\nprintf 'prepared\\n' > setup.txt\n",
      { mode: 0o755 },
    );
    const gitAt = async (cwd: string, ...args: string[]) => {
      const result = await runCommandWithTimeout(["git", "-C", cwd, ...args], {
        timeoutMs: 10_000,
        baseEnv: {
          PATH: process.env.PATH,
          HOME: root,
          GIT_CONFIG_GLOBAL: os.devNull,
          GIT_CONFIG_NOSYSTEM: "1",
        },
      });
      expect(result.code, result.stderr).toBe(0);
      return result.stdout.trim();
    };
    const git = (...args: string[]) => gitAt(origin, ...args);
    await git("init", "--quiet");
    await git("add", ".");
    await git("add", "-f", "retained-removal.ignored");
    await git(
      "-c",
      "user.name=Repository Test",
      "-c",
      "user.email=repository@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "base",
    );
    const baseCommit = await git("rev-parse", "HEAD");
    let epoch = 1;
    const service = createNodeWorkspaceTransferService({
      temporaryRoot: path.join(root, "transfers"),
      getOwner: () => ({
        credential: { ownerEpoch: epoch, sessionId: "session-1" },
        environment: {
          ownerEpoch: epoch,
          attachedSessionIds: ["session-1"],
          destroyRequestedAtMs: null,
          state: "attached",
        },
      }),
    });
    const server = await startNodeWorkspaceTransferTestServer(service);
    let runtime = new NodeWorkerWorkspaceRuntime({
      root: path.join(home, "node-host"),
      env: { PATH: process.env.PATH, HOME: home },
    });
    const manifestCaptures: RemoteWorkspaceManifestEnvelope[] = [];
    const createActions = () => {
      const ownerEpoch = epoch;
      const ownerSignal = new AbortController().signal;
      return createNodeWorkerWorkspaceActions({
        environmentId: "environment-1",
        ownerEpoch,
        sessionId: "session-1",
        ownerSignal,
        isOwnerCurrent: () => epoch === ownerEpoch,
        workspaceTransfer: service,
        runWorkspaceCommand: async (command) => {
          if (epoch !== ownerEpoch) {
            throw new Error("node workspace authority closed");
          }
          try {
            const result = await runtime.exec(
              {
                gatewayNamespace: "gateway-1",
                environmentId: "environment-1",
                sessionId: "session-1",
                generation: ownerEpoch,
                ...command,
                argv: [...command.argv],
              },
              ownerSignal,
              { url: server.gatewayUrl },
            );
            if (command.argv.at(-1) === "memo-v1") {
              manifestCaptures.push(parseRemoteWorkspaceManifestEnvelope(result.stdout));
            }
            return result;
          } catch (error) {
            if (
              closeOwner &&
              command.transfer?.direction === "upload" &&
              command.transfer.publicationBaseCommit
            ) {
              epoch += 1;
            }
            throw error;
          }
        },
      });
    };
    const source = {
      kind: "repository" as const,
      url: pathToFileURL(origin).href,
      ref: "HEAD",
      branch: "openclaw/session",
      gitToken: "synthetic-repository-token",
      runSetupScript: true,
    };
    try {
      const actions = createActions();
      const first = await actions.syncWorkspace({
        sessionId: "session-1",
        generation: epoch,
        source,
      });
      expect(first.mode).toBe("repository");
      if (first.mode !== "repository") {
        throw new Error("Repository source was not prepared");
      }
      expect(first.baseCommit).toBe(baseCommit);
      expect(first.manifestRef).not.toBe(first.baseManifestRef);
      expect(await fs.readFile(path.join(first.remoteWorkspaceDir, "setup.txt"), "utf8")).toBe(
        "prepared\n",
      );
      let checkpoint:
        | Parameters<
            Extract<
              WorkerWorkspaceReconcileRequest["source"],
              { kind: "repository" }
            >["prepareCheckpoint"]
          >[0]
        | undefined;
      let revision = 0;
      const capture = async (
        active = actions,
        directory = first.remoteWorkspaceDir,
        beforeVerify?: () => Promise<void>,
      ) => {
        const firstCapture = manifestCaptures.length;
        const result = await active.reconcileWorkspace({
          remoteWorkspaceDir: directory,
          baseManifestRef: first.baseManifestRef,
          source: {
            kind: "repository",
            referenceManifestRef: checkpoint?.currentManifestRef ?? first.manifestRef,
            prepareCheckpoint: async (payload) => {
              const stagingRoot = path.join(root, `checkpoint-${++revision}`);
              await fs.cp(payload.stagingRoot, stagingRoot, { recursive: true });
              if (filters) {
                expect(payload.publicationDigest).toBeUndefined();
                expect(payload.publicationStagingRoot).toBeUndefined();
              } else {
                expect(payload.publicationDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
                expect(
                  JSON.parse(
                    await fs.readFile(
                      path.join(payload.publicationStagingRoot!, "snapshot.json"),
                      "utf8",
                    ),
                  ),
                ).toMatchObject({ baseCommit });
              }
              const publicationStagingRoot = payload.publicationStagingRoot
                ? path.join(root, `publication-${revision}`)
                : undefined;
              if (publicationStagingRoot) {
                await fs.cp(payload.publicationStagingRoot!, publicationStagingRoot, {
                  recursive: true,
                });
              }
              const captured = { ...payload, stagingRoot, publicationStagingRoot };
              return {
                verify: async () => {
                  expect(await fs.stat(stagingRoot)).toBeDefined();
                },
                publish: async () => {
                  checkpoint = captured;
                },
                discard: async () => {
                  await fs.rm(stagingRoot, { recursive: true, force: true });
                },
              };
            },
          },
        });
        await beforeVerify?.();
        await verifyReconciledWorkspaceFinal(result, {
          assertActive: async () => {},
          resume: async () => {},
        });
        const captures = manifestCaptures.slice(firstCapture);
        expect(captures).toHaveLength(4);
        expect(captures.slice(1).every(({ metrics }) => metrics.contentHashCount === 0)).toBe(true);
        expect(captures.slice(1).every(({ metrics }) => metrics.memoHitCount > 0)).toBe(true);
        return captures;
      };
      if (closeOwner) {
        await expect(capture()).rejects.toThrow();
        expect(revision).toBe(0);
        expect(checkpoint).toBeUndefined();
        return;
      }
      // Startup must accept setup output even when GitHub normalization is unavailable.
      const initialCaptures = await capture();
      expect(initialCaptures[0]!.metrics.contentHashCount).toBe(0);
      expect(initialCaptures[0]!.metrics.memoHitCount).toBeGreaterThan(0);
      expect(revision).toBe(1);
      expect(checkpoint).toBeDefined();
      const initialCheckpoint = checkpoint;
      await expect(
        capture(actions, first.remoteWorkspaceDir, () =>
          fs.writeFile(path.join(first.remoteWorkspaceDir, "tracked.txt"), "late mutation\n"),
        ),
      ).rejects.toThrow("Repository workspace changed during checkpoint capture");
      expect(checkpoint).toBe(initialCheckpoint);
      await fs.writeFile(path.join(first.remoteWorkspaceDir, "tracked.txt"), "base\n");
      await gitAt(first.remoteWorkspaceDir, "rm", "--cached", "retained-removal.ignored");
      await fs.writeFile(
        path.join(first.remoteWorkspaceDir, "published[1].ignored"),
        "publishable\n",
      );
      await fs.writeFile(
        path.join(first.remoteWorkspaceDir, "retained.ignored"),
        "recovery only\n",
      );
      await gitAt(
        first.remoteWorkspaceDir,
        "--literal-pathspecs",
        "add",
        "-f",
        "--",
        "published[1].ignored",
      );
      await fs.writeFile(path.join(first.remoteWorkspaceDir, "first.txt"), "turn one\n");
      const changedCaptures = await capture();
      expect(changedCaptures[0]!.metrics.contentHashCount).toBeGreaterThan(0);
      expect(changedCaptures[0]!.metrics.memoHitCount).toBeGreaterThan(0);
      await fs.writeFile(path.join(first.remoteWorkspaceDir, "second.txt"), "turn two\n");
      await fs.rm(path.join(first.remoteWorkspaceDir, "tracked.txt"));
      await capture();
      expect(checkpoint).toBeDefined();

      epoch += 1;
      const replacement = createActions();
      const restored = await replacement.syncWorkspace({
        sessionId: "session-1",
        generation: epoch,
        source: { ...source, baseCommit, checkpoint },
      });
      expect(restored.remoteWorkspaceDir).not.toBe(first.remoteWorkspaceDir);
      expect(restored.manifestRef).toBe(checkpoint!.currentManifestRef);
      expect(await fs.readFile(path.join(restored.remoteWorkspaceDir, "first.txt"), "utf8")).toBe(
        "turn one\n",
      );
      expect(await fs.readFile(path.join(restored.remoteWorkspaceDir, "second.txt"), "utf8")).toBe(
        "turn two\n",
      );
      expect(await fs.readFile(path.join(restored.remoteWorkspaceDir, "setup.txt"), "utf8")).toBe(
        "prepared\n",
      );
      await expect(
        fs.stat(path.join(restored.remoteWorkspaceDir, "tracked.txt")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      expect((await fs.readdir(checkpoint!.stagingRoot)).toSorted()).toEqual([
        "first.txt",
        "published[1].ignored",
        "retained.ignored",
        "second.txt",
        "setup.txt",
      ]);
      expect(
        await fs.readFile(path.join(restored.remoteWorkspaceDir, "published[1].ignored"), "utf8"),
      ).toBe("publishable\n");
      expect(
        await gitAt(restored.remoteWorkspaceDir, "ls-files", "--", "published[1].ignored"),
      ).toBe(filters ? "" : "published[1].ignored");
      expect(await gitAt(restored.remoteWorkspaceDir, "ls-files", "--", "retained.ignored")).toBe(
        "",
      );
      expect(
        await fs.readFile(
          path.join(restored.remoteWorkspaceDir, "retained-removal.ignored"),
          "utf8",
        ),
      ).toBe("keep recovered bytes\n");
      expect(
        await gitAt(restored.remoteWorkspaceDir, "ls-files", "--", "retained-removal.ignored"),
      ).toBe(filters ? "retained-removal.ignored" : "");
      expect(await gitAt(restored.remoteWorkspaceDir, "diff", "--cached", "--name-only")).toBe(
        filters ? "" : "retained-removal.ignored\ntracked.txt",
      );
      // A node process restart loses in-memory transfer refs; the Gateway owns the accepted ref.
      runtime = new NodeWorkerWorkspaceRuntime({
        root: path.join(home, "node-host"),
        env: { PATH: process.env.PATH, HOME: home },
      });
      await capture(replacement, restored.remoteWorkspaceDir);
      expect(
        JSON.parse(checkpoint!.currentManifestRaw).entries.map(
          (entry: { path: string }) => entry.path,
        ),
      ).toContain("published[1].ignored");
      if (!filters) {
        const snapshot = JSON.parse(
          await fs.readFile(
            path.join(checkpoint!.publicationStagingRoot!, "snapshot.json"),
            "utf8",
          ),
        );
        expect(snapshot.entries.map((entry: { path: string }) => entry.path)).toContain(
          "published[1].ignored",
        );
        expect(snapshot.entries.map((entry: { path: string }) => entry.path)).not.toContain(
          "retained.ignored",
        );
        expect(snapshot.entries).toContainEqual({
          path: "retained-removal.ignored",
          mode: "100644",
          sha: null,
        });
      }
    } finally {
      await server.close();
      await service.closeAll();
    }
  },
);
