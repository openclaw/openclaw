import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { NODE_WORKER_ENVIRONMENT_STOP_COMMAND } from "../../infra/node-commands.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import {
  NODE_WORKER_WORKSPACE_STDIN_MAX_BYTES,
  NODE_WORKER_WORKSPACE_STDOUT_MAX_BYTES,
  parseNodeWorkerWorkspaceExecInput,
  type NodeWorkerWorkspaceExecInput,
} from "../../worker/node-workspace-protocol.js";
import {
  NODE_WORKSPACE_TRANSFER_ERROR_CODE,
  NodeWorkerWorkspaceTransferError,
} from "../../worker/node-workspace-transfer-protocol.js";
import type { NodeWorkerSupervisorTransport } from "../node-registry-private.js";
import { createNodeWorkerTunnelManager } from "./node-worker-tunnel.js";
import {
  createManager,
  environment,
  manifestCaptureOutput,
  seedNodeWorkspaceRepositories,
  startRequest,
  transport,
  unchangedWorkspaceUpload,
  withWorkspaceDrain,
  workspaceCommandPayload,
  workspaceTransfer,
  workspaceSnapshot,
} from "./node-worker-tunnel.test-support.js";
import { WorkerEnvironmentInventoryClosedError } from "./store-errors.js";
import { verifyReconciledWorkspaceFinal } from "./workspace-finalize.js";
import { workerProjectSeedKey } from "./workspace-git-base.js";
import type { WorkspaceReconcileMetrics } from "./workspace-hash-memo.js";
import { captureWorkspaceManifest } from "./workspace-manifest-worker.js";
import { serializeWorkerWorkspaceManifest } from "./workspace-manifest.js";
import { workerWorkspaceResultRef } from "./workspace-result-staging.js";

const workspaceInfo = vi.hoisted(() => vi.fn());
const workspaceDebug = vi.hoisted(() => vi.fn());
const tunnelWarn = vi.hoisted(() => vi.fn());
vi.mock("../../logging/subsystem.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../logging/subsystem.js")>();
  return {
    ...actual,
    createSubsystemLogger: (subsystem: string) => {
      const logger = actual.createSubsystemLogger(subsystem);
      if (subsystem === "gateway/worker-workspace") {
        return { ...logger, debug: workspaceDebug, info: workspaceInfo };
      }
      return subsystem === "gateway/worker-tunnel" ? { ...logger, warn: tunnelWarn } : logger;
    },
  };
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("node worker tunnel manager", () => {
  it.each([
    ["gateway-push", true],
    ["published-origin", false],
    ["prepared-project", false],
  ])("preserves the Gateway Git author through %s workspaces", async (syncPath, dirty) => {
    const localPath = tempDirs.make("node-worker-git-author-gateway-");
    const remoteWorkspaceDir = path.join(tempDirs.make("node-worker-git-author-remote-"), "worker");
    const gitEnv: NodeJS.ProcessEnv = {
      ...process.env,
      GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    };
    delete gitEnv.GIT_AUTHOR_NAME;
    delete gitEnv.GIT_AUTHOR_EMAIL;
    delete gitEnv.GIT_COMMITTER_NAME;
    delete gitEnv.GIT_COMMITTER_EMAIL;
    const localGit = (args: string[]) =>
      execFileSync("git", ["-C", localPath, ...args], { encoding: "utf8", env: gitEnv }).trim();
    localGit(["init", "--quiet"]);
    localGit(["config", "user.name", "Gateway Repository Author"]);
    localGit(["config", "user.email", "gateway-author@example.invalid"]);
    await fs.writeFile(path.join(localPath, "tracked.txt"), "base\n");
    localGit(["add", "tracked.txt"]);
    localGit(["commit", "--quiet", "-m", "base"]);
    localGit(["remote", "add", "origin", "https://example.invalid/repository.git"]);
    if (dirty) {
      await fs.writeFile(path.join(localPath, "tracked.txt"), "gateway change\n");
    }
    const baseCommit = localGit(["rev-parse", "HEAD"]);
    const snapshot = workspaceSnapshot(localPath, { version: 1, baseCommit, entries: [] });
    const { manifestRef } = snapshot;
    const nodeTransport = transport();
    const invoke = vi.fn<NodeWorkerSupervisorTransport["invoke"]>(async ({ command, params }) => {
      if (command === NODE_WORKER_ENVIRONMENT_STOP_COMMAND) {
        return { ok: true, payloadJSON: "null" };
      }
      const input = params as NodeWorkerWorkspaceExecInput;
      let stdout = "";
      let stderr = "";
      let code = 0;
      if (input.transfer || input.argv.includes("clone")) {
        const clone = ["clone", "--quiet", "--no-checkout", localPath, remoteWorkspaceDir];
        execFileSync("git", clone, { env: gitEnv });
        if (input.transfer) {
          execFileSync("git", ["-C", remoteWorkspaceDir, "checkout", "--quiet", baseCommit], {
            env: gitEnv,
          });
          stdout = `${manifestRef}\n`;
        }
      } else if (input.argv[0] === "git" || input.argv.includes("--")) {
        const result = spawnSync(input.argv[0]!, input.argv.slice(1), {
          encoding: "utf8",
          env: gitEnv,
          cwd: remoteWorkspaceDir,
          input: input.input,
        });
        stdout = result.stdout;
        stderr = result.stderr;
        code = result.status ?? 1;
      } else {
        stdout = `${manifestRef}\n`;
      }
      return {
        ok: true,
        payloadJSON: workspaceCommandPayload(remoteWorkspaceDir, { stdout, stderr, code }),
      };
    });
    nodeTransport.invoke = withWorkspaceDrain(invoke);
    const transfer = workspaceTransfer({
      prepareSync: vi.fn(async () => ({ snapshot, token: "download-token" })),
    });
    const handle = await createNodeWorkerTunnelManager({
      gatewayDeviceId: "gateway-device-1",
      getEnvironment: environment,
      listEnvironments: () => [environment()],
      getTransport: () => nodeTransport,
      launchNodeWorker: vi.fn(),
      validateWorkerTurn: () => true,
      workspaceTransfer: transfer,
    }).start(startRequest());

    await expect(
      handle.syncWorkspace({
        source: {
          kind: "local",
          path: localPath,
          ...(syncPath === "prepared-project" ? { projectKey: "a".repeat(64) } : {}),
        },
        sessionId: "session-1",
        generation: 1,
        gitAuthor: { name: "Configured Gateway Author" },
      }),
    ).resolves.toEqual({ mode: "git", remoteWorkspaceDir, manifestRef });

    if (syncPath === "prepared-project") {
      const commands = invoke.mock.calls.map(
        ([call]) => call.params as NodeWorkerWorkspaceExecInput,
      );
      expect(
        commands.some(
          (command) => command.argv.includes("clone") || command.argv.includes("fetch"),
        ),
      ).toBe(false);
      expect(commands.find((command) => command.transfer)?.transfer).toMatchObject({
        seedKey: workerProjectSeedKey({ key: "a".repeat(64), baseCommit }),
      });
    }

    const commitArgs = [
      "-c",
      "user.useConfigOnly=true",
      "commit",
      "--allow-empty",
      "-m",
      "worker result",
    ];
    const commit = spawnSync("git", ["-C", remoteWorkspaceDir, ...commitArgs], {
      encoding: "utf8",
      env: gitEnv,
    });
    expect(commit.stderr).not.toContain("Author identity unknown");
    expect(commit.status).toBe(0);
    expect(
      execFileSync("git", ["-C", remoteWorkspaceDir, "show", "-s", "--format=%an <%ae>"], {
        encoding: "utf8",
        env: gitEnv,
      }).trim(),
    ).toBe("Configured Gateway Author <gateway-author@example.invalid>");

    await handle.stop();
  });

  it.each(["stop", "stopAll"] as const)(
    "%s fences a pending workspace resolver without waiting for it",
    async (operation) => {
      const record = environment();
      const workspaceBinding = createDeferred<undefined>();
      const resolverSettled = vi.fn();
      void workspaceBinding.promise.then(resolverSettled);
      const transfer = {
        ...workspaceTransfer(),
        closeAll: vi.fn(async () => {}),
      };
      const resolveWorkspaceBinding = vi.fn(async () => await workspaceBinding.promise);
      const manager = createManager(record, {
        workspaceTransfer: transfer,
      });
      manager.bindWorkspaceBindingResolver(resolveWorkspaceBinding);

      const starting = manager.start(startRequest());
      await vi.waitFor(() => expect(resolveWorkspaceBinding).toHaveBeenCalledOnce());
      await (operation === "stop"
        ? manager.stop("environment-1", record.ownerEpoch)
        : manager.stopAll());

      expect(resolverSettled).not.toHaveBeenCalled();
      await expect(starting).rejects.toThrow("stopped before connecting");
      expect(manager.status("environment-1")).toBe("stopped");
      workspaceBinding.resolve(undefined);
    },
  );

  it("drains sibling node tunnels before reporting a workspace cleanup failure", async () => {
    const cleanupError = new Error("first workspace cleanup failed");
    const siblingCleanup = createDeferred();
    const close = vi.fn(async (environmentId: string) => {
      if (environmentId === "environment-1") {
        throw cleanupError;
      }
      await siblingCleanup.promise;
    });
    const closeAll = vi.fn(async () => {});
    const manager = createNodeWorkerTunnelManager({
      gatewayDeviceId: "gateway-device-1",
      listEnvironments: () => [],
      getEnvironment: (environmentId) => ({
        ...environment(),
        environmentId,
        attachedSessionIds: [environmentId === "environment-1" ? "session-1" : "session-2"],
      }),
      getTransport: transport,
      launchNodeWorker: vi.fn(),
      validateWorkerTurn: () => true,
      workspaceTransfer: {
        ...workspaceTransfer(),
        close,
        closeAll,
      },
    });
    await manager.start(startRequest());
    await manager.start({
      ...startRequest(),
      environmentId: "environment-2",
      sessionId: "session-2",
    });

    const stopping = manager.stopAll();
    const settled = vi.fn();
    void stopping.then(settled, settled);

    try {
      await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(2));
      await Promise.resolve();
      await Promise.resolve();

      expect(settled).not.toHaveBeenCalled();
      expect(closeAll).not.toHaveBeenCalled();

      siblingCleanup.resolve();
      await expect(stopping).rejects.toBe(cleanupError);
      expect(closeAll).toHaveBeenCalledOnce();
    } finally {
      siblingCleanup.resolve();
      await stopping.catch(() => undefined);
    }
  });

  it.each([false, true])(
    "releases live tunnels when shutdown cannot read the inventory (closed=%s)",
    async (closed) => {
      const inventoryClosed = closed
        ? new WorkerEnvironmentInventoryClosedError()
        : new Error("Worker environment inventory read failed");
      let inventoryOpen = true;
      const readInventory = <T>(value: T) => {
        if (!inventoryOpen) {
          throw inventoryClosed;
        }
        return value;
      };
      const record = environment();
      const close = vi.fn(async () => {});
      const closeAll = vi.fn(async () => {});
      const manager = createManager(record, {
        getEnvironment: () => readInventory(record),
        listEnvironments: () => readInventory([record]),
        workspaceTransfer: { ...workspaceTransfer(), close, closeAll },
      });
      await manager.start(startRequest());
      // A terminal state-database failure revokes the inventory before Gateway shutdown.
      inventoryOpen = false;

      if (closed) {
        await expect(manager.stopAll()).resolves.toBeUndefined();
      } else {
        await expect(manager.stopAll()).rejects.toBe(inventoryClosed);
      }
      expect(manager.status(record.environmentId)).toBe("stopped");
      expect(close).toHaveBeenCalledWith(record.environmentId);
      expect(closeAll).toHaveBeenCalledOnce();
    },
  );

  it("keeps sibling cleanup failures visible beside a disconnected node", async () => {
    const nodeTransport = transport();
    nodeTransport.getCurrentNode = async () => undefined;
    const cleanupError = new Error("transfer cleanup failed");
    const manager = createManager(environment(), {
      getTransport: () => nodeTransport,
      workspaceTransfer: {
        ...workspaceTransfer(),
        close: vi.fn(async () => {}),
        closeAll: vi.fn(async () => {
          throw cleanupError;
        }),
      },
    });

    const failure = await manager.stopAll().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toContain(cleanupError);
  });

  it.each(["current", "retiring"] as const)(
    "rejects an owner epoch older than the %s owner",
    async (owner) => {
      const cleanup = createDeferred();
      const manager = createManager(environment(), {
        workspaceTransfer: { ...workspaceTransfer(), close: vi.fn(() => cleanup.promise) },
      });
      await manager.start(startRequest());
      const stopping = owner === "retiring" ? manager.stop("environment-1", 2) : undefined;

      const stale = manager.start({ ...startRequest(), ownerEpoch: 1 });
      cleanup.resolve();
      await expect(stale).rejects.toThrow("node worker tunnel owner epoch is stale");
      await stopping;
    },
  );

  it("reports a cleanup failure after workspace binding initialization fails", async () => {
    tunnelWarn.mockClear();
    const record = environment();
    const transfer = workspaceTransfer();
    transfer.close = vi.fn(async () => {
      throw new Error("workspace cleanup failed");
    });
    const manager = createManager(record, {
      workspaceTransfer: transfer,
    });
    manager.bindWorkspaceBindingResolver(async () => {
      throw new Error("workspace binding failed");
    });

    await expect(manager.start(startRequest())).rejects.toThrow("workspace binding failed");
    await vi.waitFor(() =>
      expect(tunnelWarn).toHaveBeenCalledWith(
        "node worker tunnel cleanup failed after initialization error",
        {
          environmentId: "environment-1",
          ownerEpoch: record.ownerEpoch,
          error: "workspace cleanup failed",
        },
      ),
    );
  });

  it.each(["success", "failure"] as const)(
    "keeps same-owner starts behind restored workspace validation on %s",
    async (outcome) => {
      const record = environment();
      const validation = createDeferred();
      const snapshot = workspaceSnapshot("/gateway/workspace");
      const { manifestRef } = snapshot;
      const nodeTransport = transport();
      const invoke = vi.fn(async () => ({
        ok: true,
        payloadJSON: workspaceCommandPayload("/node/workspace"),
      }));
      nodeTransport.invoke = withWorkspaceDrain(invoke);
      const prepareSync = vi.fn(async () => {
        await validation.promise;
        if (outcome === "failure") {
          throw new Error("restored workspace validation failed");
        }
        return {
          snapshot,
          token: "restore-token",
        };
      });
      const transfer = workspaceTransfer();
      transfer.prepareSync = prepareSync;
      const manager = createManager(record, {
        getTransport: () => nodeTransport,
        workspaceTransfer: transfer,
      });
      manager.bindWorkspaceBindingResolver(async () => ({
        source: { kind: "local" as const, path: "/gateway/workspace" },
        manifestRef,
        remoteWorkspaceDir: "/node/workspace",
      }));
      const first = manager.start(startRequest());
      await vi.waitFor(() => expect(prepareSync).toHaveBeenCalledOnce());
      expect(manager.status("environment-1")).toBe("connecting");
      const second = manager.start(startRequest());
      const secondSettled = vi.fn();
      void second.then(secondSettled, secondSettled);
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(secondSettled).not.toHaveBeenCalled();
      validation.resolve();
      const results = await Promise.allSettled([first, second]);
      const expectedStatus = outcome === "success" ? "fulfilled" : "rejected";
      expect(results.map((result) => result.status)).toEqual([expectedStatus, expectedStatus]);
      expect(manager.status("environment-1")).toBe(outcome === "success" ? "connected" : "stopped");
      expect(invoke).not.toHaveBeenCalled();
    },
  );

  it("keeps concurrent workspace commands on the admitted build while launch capacity is full", async () => {
    const record = environment();
    const snapshot = workspaceSnapshot("/gateway/workspace");
    const { manifestRef } = snapshot;
    let launchEligible = true;
    const invoke = vi.fn(
      async (request: Parameters<NodeWorkerSupervisorTransport["invoke"]>[0]) => {
        expect(request.params).toMatchObject({
          environmentId: "environment-1",
          sessionId: "session-1",
          generation: record.ownerEpoch,
        });
        return {
          ok: true,
          payloadJSON: workspaceCommandPayload("/node/workspace"),
        };
      },
    );
    const prepareSync = vi.fn(async () => ({ snapshot, token: "restore-token" }));
    const transfer = workspaceTransfer({ prepareSync });
    const manager = createManager(record, {
      getTransport: () => {
        const nodeTransport = transport();
        return {
          ...nodeTransport,
          listCurrentNodes: async () => {
            const [proof] = await nodeTransport.listCurrentNodes();
            if (!proof) {
              return [];
            }
            return [
              {
                ...proof,
                workerHost: {
                  enabled: true,
                  capacity: { total: 2, available: launchEligible ? 2 : 0 },
                },
              },
            ];
          },
          invoke: withWorkspaceDrain(invoke),
        };
      },
      workspaceTransfer: transfer,
    });
    const resolveWorkspaceBinding = vi.fn(async () => ({
      source: { kind: "local" as const, path: "/gateway/workspace" },
      manifestRef,
      remoteWorkspaceDir: "/node/workspace",
    }));
    manager.bindWorkspaceBindingResolver(resolveWorkspaceBinding);

    const handle = await manager.start(startRequest());
    launchEligible = false;
    const reconciled = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        handle.runWorkspaceCommand({
          argv: ["printf", `reconciled-${index}`],
          transportRetry: "never",
        }),
      ),
    );
    expect(reconciled).toHaveLength(12);
    expect(reconciled).toEqual(
      expect.arrayContaining(
        Array.from({ length: 12 }, () =>
          expect.objectContaining({ stdout: "", workspaceDir: "/node/workspace" }),
        ),
      ),
    );
    expect(resolveWorkspaceBinding).toHaveBeenCalledWith({
      environmentId: "environment-1",
      ownerEpoch: record.ownerEpoch,
      sessionId: "session-1",
    });
    expect(prepareSync).toHaveBeenCalledWith(
      expect.objectContaining({
        environmentId: "environment-1",
        ownerEpoch: record.ownerEpoch,
        localPath: "/gateway/workspace",
      }),
    );
  });

  it("keeps node command deadlines and rechecks turn authority after discovery", async () => {
    const record = environment();
    const snapshot = workspaceSnapshot("/gateway/workspace");
    const { manifestRef } = snapshot;
    let commandTimeoutMs: number | undefined;
    let transportTimeoutMs: number | undefined;
    const nodeTransport = transport();
    nodeTransport.invoke = withWorkspaceDrain(
      vi.fn(async (request) => {
        const input = request.params as NodeWorkerWorkspaceExecInput;
        if (input.argv[0] === "slow-command") {
          commandTimeoutMs = input.timeoutMs;
          transportTimeoutMs = request.timeoutMs;
          return {
            ok: true,
            payloadJSON: workspaceCommandPayload("/node/workspace", {
              code: null,
              signal: "SIGTERM",
              killed: true,
              termination: "timeout",
            }),
          };
        }
        return {
          ok: true,
          payloadJSON: workspaceCommandPayload("/node/workspace"),
        };
      }),
    );
    const transfer = workspaceTransfer({
      prepareSync: vi.fn(async () => ({ snapshot, token: "restore-token" })),
    });
    const manager = createManager(record, {
      getTransport: () => nodeTransport,
      workspaceTransfer: transfer,
    });
    manager.bindWorkspaceBindingResolver(async () => ({
      source: { kind: "local" as const, path: "/gateway/workspace" },
      manifestRef,
      remoteWorkspaceDir: "/node/workspace",
    }));
    const handle = await manager.start(startRequest());

    await expect(
      handle.runWorkspaceCommand({
        argv: ["slow-command"],
        timeoutMs: 60_000,
        transportRetry: "never",
      }),
    ).resolves.toMatchObject({ killed: true, termination: "timeout" });
    expect(commandTimeoutMs).toBe(60_000);
    expect(transportTimeoutMs).toBeGreaterThan(60_000);
    expect(transportTimeoutMs).toBeLessThanOrEqual(65_000);

    const listCurrentNodes = nodeTransport.listCurrentNodes.bind(nodeTransport);
    let current = true;
    nodeTransport.listCurrentNodes = async () => {
      const nodes = await listCurrentNodes();
      current = false;
      return nodes;
    };
    const invoke = vi.spyOn(nodeTransport, "invoke");
    const sentCommands = invoke.mock.calls.length;
    await expect(
      handle.runWorkspaceCommand({
        argv: ["slow-command"],
        transportRetry: "never",
        assertCurrent: () => {
          if (!current) {
            throw new Error("turn claim closed");
          }
        },
      }),
    ).rejects.toThrow("turn claim closed");
    expect(invoke).toHaveBeenCalledTimes(sentCommands);
  });

  it.each(["UNAVAILABLE", "TIMEOUT", "INVALID_REQUEST", NODE_WORKSPACE_TRANSFER_ERROR_CODE])(
    "bounds and redacts node workspace diagnostics for %s",
    async (code) => {
      const secret = "sk-abcdefghijklmnopqrstuv";
      const nodeTransport = transport();
      nodeTransport.invoke = withWorkspaceDrain(async () => ({
        ok: false,
        error: {
          code,
          message: `workspace quiescence failed: Authorization: Bearer ${secret}\n${"detail ".repeat(300)}terminal diagnosis`,
        },
      }));
      const snapshot = workspaceSnapshot("/gateway/workspace");
      const manager = createManager(environment(), {
        getTransport: () => nodeTransport,
        workspaceTransfer: workspaceTransfer({
          prepareSync: vi.fn(async () => ({ snapshot, token: "restore-token" })),
        }),
      });
      manager.bindWorkspaceBindingResolver(async () => ({
        source: { kind: "local", path: snapshot.root },
        manifestRef: snapshot.manifestRef,
        remoteWorkspaceDir: "/node/workspace",
      }));
      const handle = await manager.start(startRequest());

      const error = await handle
        .runWorkspaceCommand({ argv: ["node", "-e", "void 0"], transportRetry: "never" })
        .then(
          () => {
            throw new Error("expected command failure");
          },
          (failure: unknown) => failure,
        );
      expect(error).toBeInstanceOf(Error);
      if (!(error instanceof Error)) {
        throw new Error("expected an Error result");
      }
      const message = error.message;
      expect(message).toContain("workspace quiescence failed");
      expect(message).toContain("terminal diagnosis");
      expect(message).not.toContain(secret);
      expect(message).not.toContain("\n");
      if (code === NODE_WORKSPACE_TRANSFER_ERROR_CODE) {
        expect(error).toBeInstanceOf(NodeWorkerWorkspaceTransferError);
        expect(message.length).toBeLessThanOrEqual(500);
      } else {
        const prefix = `node workspace command failed (${code}): `;
        expect(message).toContain(prefix);
        expect(message.length).toBeLessThanOrEqual(prefix.length + 500);
      }
    },
  );

  it("keeps the workspace error code when the node provides no message", async () => {
    const snapshot = workspaceSnapshot("/gateway/workspace");
    const manager = createManager(environment(), {
      workspaceTransfer: workspaceTransfer({
        prepareSync: vi.fn(async () => ({ snapshot, token: "restore-token" })),
      }),
    });
    manager.bindWorkspaceBindingResolver(async () => ({
      source: { kind: "local", path: snapshot.root },
      manifestRef: snapshot.manifestRef,
      remoteWorkspaceDir: "/node/workspace",
    }));
    const handle = await manager.start(startRequest());
    await expect(
      handle.runWorkspaceCommand({ argv: ["node", "-e", "void 0"], transportRetry: "never" }),
    ).rejects.toThrow("node workspace command failed (UNAVAILABLE)");
  });

  it("preserves a typed workspace transfer cause from the node", async () => {
    workspaceInfo.mockClear();
    const record = environment();
    const localPath = tempDirs.make("node-worker-transfer-error-");
    const snapshot = workspaceSnapshot(localPath);
    const nodeTransport = transport();
    nodeTransport.invoke = vi.fn(async () => ({
      ok: false,
      error: {
        code: NODE_WORKSPACE_TRANSFER_ERROR_CODE,
        message:
          "workspace-transfer-failed: operation=upload stage=reconcile: socket hang up | ECONNRESET",
      },
    }));
    const transfer = workspaceTransfer({
      prepareSync: vi.fn(async () => ({ snapshot, token: "download-token" })),
    });
    const manager = createManager(record, {
      getTransport: () => nodeTransport,
      workspaceTransfer: transfer,
    });
    const handle = await manager.start(startRequest());

    await expect(
      handle.syncWorkspace({
        source: { kind: "local", path: localPath },
        sessionId: "session-1",
        generation: 1,
      }),
    ).rejects.toMatchObject({
      name: NodeWorkerWorkspaceTransferError.name,
      code: NODE_WORKSPACE_TRANSFER_ERROR_CODE,
      message:
        "workspace-transfer-failed: operation=upload stage=reconcile: socket hang up | ECONNRESET",
    });
    expect(workspaceInfo).toHaveBeenCalledWith("worker workspace sync path selected", {
      environmentId: "environment-1",
      sessionId: "session-1",
      path: "gateway-push",
      reason: "not-git-workspace",
      originAttemptMs: expect.any(Number),
    });
  });

  it.each([
    {
      name: "divergence",
      result: { stdout: manifestCaptureOutput(`sha256:${"f".repeat(64)}`) },
      error: "changed during final reconciliation",
    },
    {
      name: "missing manifest",
      result: {
        code: 1,
        stderr: "ENOENT: no such file or directory, open '/worker/manifests/result.json'\n",
      },
      error: "Worker workspace manifest capture failed: ENOENT: no such file or directory",
    },
    {
      name: "timeout without stderr",
      result: { code: null, signal: "SIGTERM", killed: true, termination: "timeout" },
      error: "Worker workspace manifest capture failed: timeout (exit code null, signal SIGTERM)",
    },
    {
      name: "invalid reference",
      result: { stdout: "invalid\n" },
      error: "Worker workspace manifest returned an invalid memo response",
    },
  ] as const)("reports $name during final manifest verification", async ({ result, error }) => {
    const record = environment();
    const localPath = tempDirs.make("node-worker-verify-stable-");
    const remoteWorkspaceDir = path.join(localPath, "remote");
    await fs.mkdir(remoteWorkspaceDir);
    const snapshot = workspaceSnapshot(localPath);
    const { manifestRef: baseManifestRef } = snapshot;
    const nodeTransport = transport();
    nodeTransport.invoke = vi.fn(async ({ params }) => {
      const input = params as { transfer?: { direction?: string } };
      return {
        ok: true,
        payloadJSON: workspaceCommandPayload(remoteWorkspaceDir, {
          stdout: `${baseManifestRef}\n`,
          ...(!input.transfer ? result : {}),
        }),
      };
    });
    const transfer = workspaceTransfer({
      prepareSync: vi.fn(async () => ({ snapshot, token: "download-token" })),
      prepareUpload: vi.fn(() => "upload-token"),
      takeUpload: vi.fn(() =>
        unchangedWorkspaceUpload(snapshot, tempDirs.make("node-worker-reconcile-error-staging-")),
      ),
    });
    const manager = createManager(record, {
      getTransport: () => nodeTransport,
      workspaceTransfer: transfer,
    });
    const handle = await manager.start(startRequest());
    await handle.syncWorkspace({
      source: { kind: "local", path: localPath },
      sessionId: "session-1",
      generation: 1,
    });

    await expect(
      handle.reconcileWorkspace({
        source: {
          kind: "local",
          path: localPath,
          journal: {
            load: async () => undefined,
            begin: vi.fn(async () => {}),
            commit: vi.fn(async () => {}),
            abort: vi.fn(async () => {}),
          },
          stagedResult: { ref: workerWorkspaceResultRef("node-error"), record: () => {} },
        },
        remoteWorkspaceDir,
        baseManifestRef,
      }),
    ).rejects.toThrow(error);
  });

  it.each([640])(
    "reuses the placement hash memo across node reconciliations (%s files)",
    async (fileCount) => {
      const record = environment();
      const localPath = tempDirs.make("node-worker-memo-persist-");
      const remoteWorkspaceDir = path.join(
        tempDirs.make("node-worker-memo-persist-remote-"),
        "資料-😀",
      );
      const remoteHome = tempDirs.make("node-worker-memo-persist-home-");
      const stagingRoot = tempDirs.make("node-worker-memo-persist-staging-");
      const files = Array.from({ length: fileCount }, (_, index) => `測試-${index}-é.txt`);
      await Promise.all(
        files.map((file) => fs.writeFile(path.join(localPath, file), "cross turn\n")),
      );
      const baseCommit = seedNodeWorkspaceRepositories(localPath, remoteWorkspaceDir);
      const actual = await captureWorkspaceManifest({ root: localPath, baseCommit });
      const raw = serializeWorkerWorkspaceManifest(actual.manifest);
      const manifestRef = actual.manifestRef;
      const snapshot = {
        manifest: actual.manifest,
        manifestRef,
        rawManifest: raw,
        root: localPath,
      };
      const remoteManifests = path.join(remoteHome, ".openclaw-worker", "manifests");
      await fs.mkdir(remoteManifests, { recursive: true });
      await fs.writeFile(path.join(remoteManifests, `${manifestRef.slice(7)}.json`), raw);
      const nodeTransport = transport();
      const memoInputs: Array<Array<[string, string]>> = [];
      const captureBytes: Array<{ input: number; output: number }> = [];
      nodeTransport.invoke = withWorkspaceDrain(async ({ command, params }) => {
        if (command === NODE_WORKER_ENVIRONMENT_STOP_COMMAND) {
          return { ok: true, payloadJSON: "null" };
        }
        const encoded = JSON.stringify(params);
        const input = parseNodeWorkerWorkspaceExecInput(encoded);
        if (input.transfer) {
          return {
            ok: true,
            payloadJSON: workspaceCommandPayload(remoteWorkspaceDir, {
              stdout: `${manifestRef}\n`,
            }),
          };
        }
        if (input.argv.at(-1) === "memo-v1") {
          memoInputs.push(JSON.parse(input.input!));
        }
        const result = await runCommandWithTimeout([process.execPath, ...input.argv.slice(1)], {
          input: input.input,
          cwd: remoteWorkspaceDir,
          timeoutMs: 10_000,
          baseEnv: { PATH: process.env.PATH, HOME: remoteHome },
        });
        const { stdout, stderr, code, signal, killed, termination } = result;
        if (input.argv.at(-1) === "memo-v1") {
          captureBytes.push({
            input: Buffer.byteLength(input.input!),
            output: Buffer.byteLength(stdout),
          });
        }
        return {
          ok: true,
          payloadJSON: workspaceCommandPayload(remoteWorkspaceDir, {
            stdout,
            stderr,
            code,
            signal,
            killed,
            termination,
          }),
        };
      });
      const transfer = workspaceTransfer({
        prepareSync: vi.fn(async () => ({ snapshot, token: "download-token" })),
        prepareUpload: vi.fn(() => "upload-token"),
        takeUpload: vi.fn(() => unchangedWorkspaceUpload(snapshot, stagingRoot)),
      });
      const manager = createManager(record, {
        getTransport: () => nodeTransport,
        workspaceTransfer: transfer,
      });
      const handle = await manager.start(startRequest());
      await handle.syncWorkspace({
        source: { kind: "local", path: localPath },
        sessionId: "session-1",
        generation: 1,
      });
      const quiescence = { assertActive: async () => {}, resume: async () => {} };
      const journal = {
        load: async () => undefined,
        begin: vi.fn(async () => {}),
        commit: vi.fn(async () => {}),
        abort: vi.fn(async () => {}),
      };
      workspaceDebug.mockClear();

      for (let turn = 0; turn < 2; turn += 1) {
        const reconciliation = await handle.reconcileWorkspace({
          source: {
            kind: "local",
            path: localPath,
            journal,
            stagedResult: { ref: workerWorkspaceResultRef(`node-memo-${turn}`), record: () => {} },
          },
          remoteWorkspaceDir,
          baseManifestRef: manifestRef,
        });
        await verifyReconciledWorkspaceFinal(reconciliation, quiescence);
      }

      const reports = workspaceDebug.mock.calls
        .filter(([message]) => message === "worker workspace reconcile completed")
        .map(([, data]) => data as WorkspaceReconcileMetrics);
      expect(reports).toHaveLength(2);
      // Turn one hashes the managed worktree; turn two must reuse the
      // placement-owned memo instead of re-hashing every file.
      expect(reports[0]!.gateway.contentHashCount).toBeGreaterThan(0);
      expect(reports[1]!.gateway.contentHashCount).toBe(0);
      expect(reports[1]!.gateway.memoHitCount).toBeGreaterThan(0);
      const retained = memoInputs[1]!.length;
      const uncached = fileCount - retained;
      expect(retained).toBeGreaterThan(0);
      expect(reports[0]).toMatchObject({
        remoteManifestCalls: 1,
        remoteContentHashCount: fileCount,
      });
      expect(reports[1]).toMatchObject({
        remoteManifestCalls: 1,
        remoteContentHashCount: uncached,
        remoteMemoHitCount: retained,
      });
      expect(memoInputs).toHaveLength(2);
      expect(memoInputs[0]).toEqual([]);
      expect(memoInputs.slice(1).every((entries) => entries.length === retained)).toBe(true);
      expect(memoInputs.flat().every(([identity]) => identity.startsWith("worker:"))).toBe(true);
      expect(reports[1]!.remoteManifestWallDurationMs).toBeGreaterThan(0);
      expect(
        captureBytes.every((bytes) => bytes.input <= NODE_WORKER_WORKSPACE_STDIN_MAX_BYTES),
      ).toBe(true);
      expect(
        captureBytes.every((bytes) => bytes.output <= NODE_WORKER_WORKSPACE_STDOUT_MAX_BYTES),
      ).toBe(true);
      if (fileCount > 1) {
        expect(retained).toBeLessThan(fileCount);
        expect(reports[1]!.remoteMemoTruncatedCount).toBeGreaterThan(0);
      }

      await fs.writeFile(path.join(remoteWorkspaceDir, files[0]!), "next  turn\n");
      await fs.utimes(
        path.join(remoteWorkspaceDir, files[0]!),
        new Date(),
        new Date(Date.now() + 1_000),
      );
      await expect(
        handle
          .reconcileWorkspace({
            source: {
              kind: "local",
              path: localPath,
              journal,
              stagedResult: { ref: workerWorkspaceResultRef("node-memo-late"), record: () => {} },
            },
            remoteWorkspaceDir,
            baseManifestRef: manifestRef,
          })
          .then((reconciliation) => verifyReconciledWorkspaceFinal(reconciliation, quiescence)),
      ).rejects.toThrow("changed during final reconciliation");
      await handle.stop();
    },
  );
});
