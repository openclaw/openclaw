import { once } from "node:events";
import fs from "node:fs";
import { createRequire } from "node:module";
import { createConnection } from "node:net";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WORKER_PROTOCOL_MAX_INFERENCE_PAYLOAD_BYTES } from "../../packages/gateway-protocol/src/schema/worker-inference.js";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import { resetSecretRedactionRegistryForTest } from "../logging/secret-redaction-registry.test-support.js";
import { useStateDatabaseTempDirs } from "../test-utils/state-database-temp-dirs.js";
import { completeWorkerLaunchDescriptor } from "../worker/launch-descriptor.js";
import type { NodeWorkerWorkspaceExecInput } from "../worker/node-workspace-protocol.js";
import {
  buildWorkerProcessTurn,
  serializeWorkerProcessInput,
} from "../worker/worker-process-protocol.js";
import { NodeWorkerJournalWorker } from "./node-worker-journal-worker.js";
import { NodeWorkerLaunchStore, type NodeWorkerLaunchReceipt } from "./node-worker-launch-store.js";
import {
  inspectNodeWorkerProcessIdentity,
  requireNodeWorkerProcessIdentity,
  type NodeWorkerProcessIdentity,
} from "./node-worker-process-identity.js";
import { createNodeWorkerContainerFixture } from "./node-worker-supervisor.container.test-support.js";
import {
  createNodeWorkerSupervisorFixture,
  waitForChildExit,
  waitForChildLine,
  waitForIdentityDeath,
  waitForNodeWorkerTerminal as waitForTerminal,
  spawnSupervisorOwner,
} from "./node-worker-supervisor.fixture.test-support.js";
import { createNodeWorkerSupervisor } from "./node-worker-supervisor.js";
import {
  TEST_WORKER_ENDPOINT,
  TEST_WORKER_SOURCE,
  testNodeWorkerEnvironmentIdentity,
  testNodeWorkerLaunchIdentity,
  testWorkerLaunchInput,
  writeNodeWorkerFixture,
} from "./node-worker-supervisor.test-support.js";
import { inspectOwnedNodeWorkerTree } from "./node-worker-tree-control.js";
import { NodeWorkerTurnStore } from "./node-worker-turn-store.js";
import { NodeWorkerWorkspaceRuntime } from "./node-worker-workspace.js";

type NodeWorkerSupervisor = ReturnType<typeof createNodeWorkerSupervisor>;

const tempDirs = useStateDatabaseTempDirs();
const fileLockModule = createRequire(import.meta.url).resolve("@openclaw/fs-safe/file-lock");

afterEach(() => {
  vi.restoreAllMocks();
  resetSecretRedactionRegistryForTest();
});

function supervisorFixture(options: Parameters<typeof createNodeWorkerSupervisor>[0] = {}) {
  return createNodeWorkerSupervisorFixture(tempDirs.make("node-worker-supervisor-"), options);
}

function launchInput(workspaceDir: string, launchId: string, prompt = "success") {
  const input = testWorkerLaunchInput(workspaceDir, launchId, prompt);
  input.descriptor.admission.environmentId = `environment-${launchId}`;
  input.descriptor.admission.sessionId = `session-${launchId}`;
  return input;
}

async function observeBackgroundConnection(url: string) {
  const address = new URL(url);
  const socket = createConnection({ host: address.hostname, port: Number(address.port) });
  let error: NodeJS.ErrnoException | undefined;
  let didClose = false;
  socket.on("error", (value) => {
    error = value;
  });
  const closed = new Promise<void>((resolve) => {
    socket.once("close", () => {
      didClose = true;
      resolve();
    });
  });
  const dispose = async () => {
    socket.destroy();
    await closed;
  };
  try {
    await once(socket, "connect");
    socket.resume();
  } catch (cause) {
    await dispose();
    throw cause;
  }
  return {
    dispose,
    get didClose() {
      return didClose;
    },
    get error() {
      return error;
    },
  };
}

type BackgroundConnection = Awaited<ReturnType<typeof observeBackgroundConnection>>;

function expectBackgroundRetired(
  connection: BackgroundConnection,
  ...owners: NodeWorkerProcessIdentity[]
) {
  // A freed listening port may belong to a replacement. This connection remains
  // bound to the original server, and unknown process identity is not death.
  expect(connection.didClose).toBe(true);
  if (connection.error && connection.error.code !== "ECONNRESET") {
    throw connection.error;
  }
  for (const owner of owners) {
    expect(inspectNodeWorkerProcessIdentity(owner)).toMatch(/^(dead|reused)$/u);
  }
}

describe("node worker environment lifetime", () => {
  it.skipIf(process.platform === "win32")(
    "reclaims a killed worker's descendants before releasing its slot without disturbing a peer",
    async () => {
      const capacitySnapshots: Array<{ total: number; available: number }> = [];
      const { env, supervisor, workspaceDir } = supervisorFixture({
        capacity: 2,
        onCapacityChanged: (capacity) => capacitySnapshots.push(capacity),
      });
      const victim = launchInput(workspaceDir, "killed-owner", "tree");
      const peer = launchInput(workspaceDir, "surviving-peer", "wait");
      const store = new NodeWorkerLaunchStore(new NodeWorkerJournalWorker({ env }));
      let grandchild: NodeWorkerProcessIdentity | undefined;
      try {
        const running = await supervisor.launch(victim, TEST_WORKER_ENDPOINT);
        const unrelated = await supervisor.launch(peer, TEST_WORKER_ENDPOINT);
        const pidPath = path.join(workspaceDir, "grandchild.pid");
        await vi.waitFor(() => expect(fs.existsSync(pidPath)).toBe(true));
        grandchild = requireNodeWorkerProcessIdentity(Number(fs.readFileSync(pidPath, "utf8")));
        const application = JSON.parse(
          fs.readFileSync(path.join(workspaceDir, `${victim.launchId}.started.json`), "utf8"),
        ) as {
          pid: number;
        };
        expect(capacitySnapshots.at(-1)).toEqual({ total: 2, available: 0 });

        process.kill(application.pid, "SIGKILL");

        // Do not drive status recovery: the physical owner must close its own slot.
        await vi.waitFor(
          () => expect(capacitySnapshots.at(-1)).toEqual({ total: 2, available: 1 }),
          { timeout: 10_000 },
        );
        expect(inspectNodeWorkerProcessIdentity(grandchild)).toMatch(/^(dead|reused)$/u);
        expect(inspectNodeWorkerProcessIdentity(running.worker!)).toMatch(/^(dead|reused)$/u);
        expect((await store.get(victim.launchId))?.state).toBe("failed");
        expect(inspectNodeWorkerProcessIdentity(unrelated.worker!)).toBe("live");
        expect((await supervisor.status(peer.launchId))?.state).toBe("running");

        const replacement = launchInput(workspaceDir, "replacement-owner", "wait");
        expect(await supervisor.launch(replacement, TEST_WORKER_ENDPOINT)).toMatchObject({
          state: "running",
        });
        expect(capacitySnapshots.at(-1)).toEqual({ total: 2, available: 0 });
      } finally {
        try {
          if (grandchild) {
            if (inspectNodeWorkerProcessIdentity(grandchild) === "live") {
              process.kill(grandchild.pid, "SIGKILL");
            }
            await vi.waitFor(() =>
              expect(inspectNodeWorkerProcessIdentity(grandchild!)).toMatch(/^(dead|reused)$/u),
            );
          }
        } finally {
          await supervisor.close();
        }
      }
    },
  );

  it("reuses a retained worker at capacity across turns and cancellation until its environment stops", async () => {
    const capacitySnapshots: Array<{ total: number; available: number }> = [];
    const { env, supervisor, workspaceDir } = supervisorFixture({
      capacity: 1,
      capacityWaitMs: 25,
      onCapacityChanged: (capacity) => capacitySnapshots.push(capacity),
    });
    const first = testWorkerLaunchInput(workspaceDir, "preview-start", "background-start");
    const nextTurn = (turnId: string, prompt: string) => {
      const input = testWorkerLaunchInput(workspaceDir, turnId, prompt);
      input.descriptor.admission.credential = `credential-${turnId}`;
      const assignment = input.descriptor.assignment;
      assignment.runId = `run-${turnId}`;
      assignment.operationalRunInstance = {
        instanceId: `instance-${turnId}`,
        runId: assignment.runId,
      };
      assignment.agentRuntimeIdentityToken = `signed-token-${turnId}`;
      return input;
    };
    const environment = testNodeWorkerEnvironmentIdentity(first);
    const store = new NodeWorkerLaunchStore(new NodeWorkerJournalWorker({ env }));
    let connection: BackgroundConnection | undefined;

    try {
      const running = await supervisor.launch(first, TEST_WORKER_ENDPOINT);
      const completed = await waitForTerminal(supervisor, first.launchId);
      const started = JSON.parse(
        fs.readFileSync(path.join(workspaceDir, `${first.launchId}.started.json`), "utf8"),
      ) as {
        pid: number;
        starts: number;
      };
      const application = requireNodeWorkerProcessIdentity(started.pid);
      const background = JSON.parse(
        fs.readFileSync(path.join(workspaceDir, `${first.launchId}.background.json`), "utf8"),
      ) as {
        pid: number;
        url: string;
      };
      const server = requireNodeWorkerProcessIdentity(background.pid);
      connection = await observeBackgroundConnection(background.url);
      expect(completed.state).toBe("completed");
      expect(await supervisor.hasActiveWork()).toBe(true);
      expect(await store.get(first.launchId)).toMatchObject({
        state: "running",
        worker: running.worker,
      });
      expect(capacitySnapshots.at(-1)).toEqual({ total: 1, available: 0 });
      expect(await (await fetch(background.url)).text()).toBe("preview-ready");

      expect(await supervisor.launch(first, TEST_WORKER_ENDPOINT)).toEqual(completed);
      expect(
        JSON.parse(
          fs.readFileSync(path.join(workspaceDir, `${first.launchId}.started.json`), "utf8"),
        ),
      ).toEqual({
        pid: application.pid,
        starts: 1,
      });

      const poll = nextTurn("preview-poll", "background-poll");
      poll.descriptor.assignment.systemPrompt = '"\\\0\n漢😀';
      const encodePoll = () =>
        serializeWorkerProcessInput(
          buildWorkerProcessTurn(
            completeWorkerLaunchDescriptor(poll.descriptor, TEST_WORKER_ENDPOINT),
          ),
        );
      poll.descriptor.assignment.systemPrompt += "x".repeat(
        WORKER_PROTOCOL_MAX_INFERENCE_PAYLOAD_BYTES - (Buffer.byteLength(encodePoll()) - 1),
      );
      expect(Buffer.byteLength(encodePoll()) - 1).toBe(WORKER_PROTOCOL_MAX_INFERENCE_PAYLOAD_BYTES);
      expect(await supervisor.launch(poll, TEST_WORKER_ENDPOINT)).toMatchObject({
        state: "running",
        worker: running.worker,
      });
      expect((await waitForTerminal(supervisor, poll.launchId)).state).toBe("completed");
      expect(
        JSON.parse(
          fs.readFileSync(path.join(workspaceDir, `${poll.launchId}.started.json`), "utf8"),
        ),
      ).toEqual({
        pid: application.pid,
        starts: 1,
      });
      expect(
        JSON.parse(
          fs.readFileSync(path.join(workspaceDir, `${poll.launchId}.background.json`), "utf8"),
        ),
      ).toEqual({
        ...background,
        response: "preview-ready",
      });

      const waiting = nextTurn("preview-cancel", "background-wait");
      await supervisor.launch(waiting, TEST_WORKER_ENDPOINT);
      await vi.waitFor(() =>
        expect(fs.existsSync(path.join(workspaceDir, `${waiting.launchId}.started.json`))).toBe(
          true,
        ),
      );
      expect(await supervisor.cancel(testNodeWorkerLaunchIdentity(first))).toEqual(completed);
      expect((await supervisor.status(waiting.launchId))?.state).toBe("running");
      await expect(
        supervisor.launch(nextTurn("preview-concurrent", "background-poll"), TEST_WORKER_ENDPOINT),
      ).rejects.toThrow("already has an active turn");
      expect(await supervisor.cancel(testNodeWorkerLaunchIdentity(waiting))).toMatchObject({
        state: "cancelled",
        worker: running.worker,
      });
      expect(inspectNodeWorkerProcessIdentity(server)).toBe("live");
      expect(await (await fetch(background.url)).text()).toBe("preview-ready");

      const afterCancel = nextTurn("preview-after-cancel", "background-poll");
      expect(await supervisor.launch(afterCancel, TEST_WORKER_ENDPOINT)).toMatchObject({
        worker: running.worker,
      });
      expect((await waitForTerminal(supervisor, afterCancel.launchId)).state).toBe("completed");
      expect(await store.listNonterminal()).toHaveLength(1);
      expect(capacitySnapshots.at(-1)).toEqual({ total: 1, available: 0 });

      for (const mismatch of [
        { ...environment, gatewayNamespace: "other-gateway" },
        { ...environment, sessionId: "other-session" },
        { ...environment, ownerEpoch: environment.ownerEpoch + 1 },
      ]) {
        await supervisor.stopEnvironment(mismatch);
        expect(inspectNodeWorkerProcessIdentity(running.worker!)).toBe("live");
      }
      await supervisor.stopEnvironment(environment);
      await vi.waitFor(() => expectBackgroundRetired(connection!, running.worker!, server));
      expect(capacitySnapshots.at(-1)).toEqual({ total: 1, available: 1 });
      expect(await supervisor.hasActiveWork()).toBe(false);
      expect(await supervisor.status(first.launchId)).toEqual({
        ...completed,
        workerLineageSettled: completed.workerCleanupMode === "owned-anchor",
        ...(completed.workerCleanupMode === "linux-subreaper"
          ? { workerDescendantsReaped: true }
          : {}),
      });
      expect((await supervisor.status(waiting.launchId))?.state).toBe("cancelled");
    } finally {
      try {
        await supervisor.close();
      } finally {
        await connection?.dispose();
      }
    }
  });

  it("does not use a pruned first-turn receipt as authority over a later retained turn", async () => {
    const { env, supervisor, workspaceDir } = supervisorFixture({ capacity: 1 });
    const first = testWorkerLaunchInput(workspaceDir, "pruned-first", "background-start");
    const next = testWorkerLaunchInput(workspaceDir, "current-second", "background-wait");
    const journal = new NodeWorkerJournalWorker({ env });
    const turns = new NodeWorkerTurnStore(journal);
    try {
      await supervisor.launch(first, TEST_WORKER_ENDPOINT);
      const completed = await waitForTerminal(supervisor, first.launchId);
      const running = await supervisor.launch(next, TEST_WORKER_ENDPOINT);
      await vi.waitFor(() =>
        expect(fs.existsSync(path.join(workspaceDir, `${next.launchId}.started.json`))).toBe(true),
      );
      await turns.claim({
        claim: { ...testNodeWorkerLaunchIdentity(next), gatewayNamespace: next.gatewayNamespace },
        ownerLaunchId: first.launchId,
        supervisor: running.supervisor,
        worker: running.worker,
        nowMs: completed.completedAtMs! + 24 * 60 * 60 * 1_000 + 1,
      });

      expect(await turns.get(first.launchId)).toBeUndefined();
      expect(await new NodeWorkerLaunchStore(journal).get(first.launchId)).toMatchObject({
        state: "running",
        worker: running.worker,
      });
      expect(await supervisor.status(first.launchId)).toBeUndefined();
      expect(await supervisor.cancel(testNodeWorkerLaunchIdentity(first))).toBeUndefined();
      expect(await supervisor.status(next.launchId)).toMatchObject({ state: "running" });
      expect(inspectNodeWorkerProcessIdentity(running.worker!)).toBe("live");
      const background = JSON.parse(
        fs.readFileSync(path.join(workspaceDir, `${first.launchId}.background.json`), "utf8"),
      ) as {
        url: string;
      };
      expect(await (await fetch(background.url)).text()).toBe("preview-ready");

      await supervisor.cancel(testNodeWorkerLaunchIdentity(next));
      await expect(supervisor.launch(first, TEST_WORKER_ENDPOINT)).rejects.toThrow();
      expect(await turns.get(first.launchId)).toBeUndefined();
      expect(inspectNodeWorkerProcessIdentity(running.worker!)).toBe("live");
    } finally {
      await supervisor.close();
    }
  });

  it("retires a retained worker before replacing its permissions binding", async () => {
    const { supervisor, workspaceDir } = supervisorFixture({ capacity: 1 });
    const first = testWorkerLaunchInput(workspaceDir, "binding-first", "background-start");
    first.descriptor.assignment.permissionMode = "full";
    first.descriptor.assignment.workerContainmentRoot = workspaceDir;
    const next = structuredClone(first);
    next.launchId = next.descriptor.assignment.turnId = "binding-next";
    next.descriptor.assignment.permissionMode = "guarded";
    let connection: BackgroundConnection | undefined;
    try {
      const original = await supervisor.launch(first, TEST_WORKER_ENDPOINT);
      const completed = await waitForTerminal(supervisor, first.launchId);
      const background = JSON.parse(
        fs.readFileSync(path.join(workspaceDir, `${first.launchId}.background.json`), "utf8"),
      ) as {
        pid: number;
        url: string;
      };
      const server = requireNodeWorkerProcessIdentity(background.pid);
      connection = await observeBackgroundConnection(background.url);
      next.descriptor.assignment.prompt = `background-start:${new URL(background.url).port}`;

      const replacement = await supervisor.launch(next, TEST_WORKER_ENDPOINT);
      expect(replacement.worker).not.toEqual(original.worker);
      expect((await waitForTerminal(supervisor, next.launchId)).state).toBe("completed");
      await vi.waitFor(() => expectBackgroundRetired(connection!, original.worker!, server));
      const replacementBackground = JSON.parse(
        fs.readFileSync(
          path.join(next.descriptor.assignment.workspaceDir, `${next.launchId}.background.json`),
          "utf8",
        ),
      ) as { pid: number; url: string };
      expect(replacementBackground.url).toBe(background.url);
      expect(inspectNodeWorkerProcessIdentity(replacement.worker!)).toBe("live");
      expect(
        inspectNodeWorkerProcessIdentity(
          requireNodeWorkerProcessIdentity(replacementBackground.pid),
        ),
      ).toBe("live");
      expect(await (await fetch(background.url)).text()).toBe("preview-ready");
      expect(await supervisor.status(first.launchId)).toEqual({
        ...completed,
        workerLineageSettled: completed.workerCleanupMode === "owned-anchor",
        ...(completed.workerCleanupMode === "linux-subreaper"
          ? { workerDescendantsReaped: true }
          : {}),
      });
    } finally {
      try {
        await supervisor.close();
      } finally {
        await connection?.dispose();
      }
    }
  });

  it.each(["owner epoch", "placement generation"] as const)(
    "rejects an older %s without disturbing the retained worker",
    async (binding) => {
      const { supervisor, workspaceDir } = supervisorFixture({ capacity: 1 });
      const first = testWorkerLaunchInput(workspaceDir, "current-owner", "background-start");
      const stale = testWorkerLaunchInput(workspaceDir, "stale-owner", "background-poll");
      if (binding === "owner epoch") {
        stale.descriptor.admission.ownerEpoch -= 1;
      } else {
        stale.placementGeneration -= 1;
      }
      try {
        const running = await supervisor.launch(first, TEST_WORKER_ENDPOINT);
        await waitForTerminal(supervisor, first.launchId);
        await expect(supervisor.launch(stale, TEST_WORKER_ENDPOINT)).rejects.toThrow(
          "belongs to a replaced environment",
        );
        expect(inspectNodeWorkerProcessIdentity(running.worker!)).toBe("live");
        const background = JSON.parse(
          fs.readFileSync(path.join(workspaceDir, `${first.launchId}.background.json`), "utf8"),
        ) as {
          url: string;
        };
        expect(await (await fetch(background.url)).text()).toBe("preview-ready");
      } finally {
        await supervisor.close();
      }
    },
  );

  it.each(["environment stop", "supervisor close"] as const)(
    "%s aborts stalled admission and retires workers despite workspace cleanup failure",
    async (operation) => {
      const capacitySnapshots: Array<{ total: number; available: number }> = [];
      const { bundleRoot, env, workspaceDir } = writeNodeWorkerFixture(
        tempDirs.make("node-worker-supervisor-"),
      );
      const workspace = new NodeWorkerWorkspaceRuntime({ root: bundleRoot, env });
      const supervisor = createNodeWorkerSupervisor({
        bundleRoot,
        env,
        workspace,
        capacity: 2,
        onCapacityChanged: (capacity) => capacitySnapshots.push(capacity),
      });
      const first = testWorkerLaunchInput(workspaceDir, "retiring-owner", "retire-stall");
      const next = testWorkerLaunchInput(workspaceDir, "waiting-for-retirement", "wait");
      const sibling = launchInput(workspaceDir, "outside-retiring-environment", "wait");
      const store = new NodeWorkerLaunchStore(new NodeWorkerJournalWorker({ env }));
      let owner: Awaited<ReturnType<NodeWorkerSupervisor["launch"]>> | undefined;
      let admission: Promise<unknown> | undefined;
      let shutdown: Promise<unknown> | undefined;
      let admissionError: unknown;
      let shutdownError: unknown;
      let stopped = false;
      const cleanupError = new Error("workspace process cleanup failed");
      try {
        owner = await supervisor.launch(first, TEST_WORKER_ENDPOINT);
        const completed = await waitForTerminal(supervisor, first.launchId);
        const unrelated = await supervisor.launch(sibling, TEST_WORKER_ENDPOINT);
        expect((await store.get(first.launchId))?.state).toBe("running");
        expect(inspectNodeWorkerProcessIdentity(owner.worker!)).toBe("live");

        const readOwner = vi.spyOn(NodeWorkerJournalWorker.prototype, "execute");
        admission = supervisor.launch(next, TEST_WORKER_ENDPOINT).catch((error: unknown) => {
          admissionError = error;
        });
        await vi.waitFor(() =>
          expect(readOwner).toHaveBeenCalledWith({
            type: "nodeWorker.launch.get",
            input: [first.launchId],
          }),
        );
        readOwner.mockRestore();
        if (operation === "environment stop") {
          const stop = workspace.processes.stopEnvironment.bind(workspace.processes);
          vi.spyOn(workspace.processes, "stopEnvironment").mockImplementationOnce(
            (environment, stopExecution) =>
              stop(environment, async () => {
                await stopExecution?.();
                throw cleanupError;
              }),
          );
        } else {
          vi.spyOn(workspace.processes, "close").mockRejectedValueOnce(cleanupError);
        }
        const stopping =
          operation === "environment stop"
            ? supervisor.stopEnvironment(testNodeWorkerEnvironmentIdentity(first))
            : supervisor.close();
        shutdown = stopping.then(
          () => {
            stopped = true;
          },
          (error: unknown) => {
            shutdownError = error;
            stopped = true;
          },
        );

        await vi.waitFor(
          () => {
            expect(admissionError).toMatchObject({
              message:
                operation === "environment stop"
                  ? "node worker environment stopped"
                  : "node worker supervisor is closed",
            });
            expect(shutdownError).toBe(cleanupError);
            expect(stopped).toBe(true);
            expect(inspectNodeWorkerProcessIdentity(owner!.worker!)).toMatch(/^(dead|reused)$/u);
          },
          { timeout: 3_000 },
        );
        expect((await store.get(first.launchId))?.state).toBe("interrupted");
        expect(await supervisor.status(first.launchId)).toEqual({
          ...completed,
          workerLineageSettled: completed.workerCleanupMode === "owned-anchor",
          ...(completed.workerCleanupMode === "linux-subreaper"
            ? { workerDescendantsReaped: true }
            : {}),
        });
        expect(await supervisor.status(next.launchId)).toBeUndefined();
        expect(fs.existsSync(path.join(workspaceDir, `${next.launchId}.started.json`))).toBe(false);
        if (operation === "environment stop") {
          expect(capacitySnapshots.at(-1)).toEqual({ total: 2, available: 1 });
          expect(inspectNodeWorkerProcessIdentity(unrelated.worker!)).toBe("live");
          expect(await supervisor.status(sibling.launchId)).toMatchObject({ state: "running" });
          await expect(supervisor.launch(next, TEST_WORKER_ENDPOINT)).rejects.toThrow("retired");
          await supervisor.stopEnvironment(testNodeWorkerEnvironmentIdentity(first));
          await expect(supervisor.launch(next, TEST_WORKER_ENDPOINT)).resolves.toMatchObject({
            state: "running",
          });
        } else {
          expect(capacitySnapshots.at(-1)).toEqual({ total: 2, available: 2 });
          expect(inspectNodeWorkerProcessIdentity(unrelated.worker!)).not.toBe("live");
          expect(await store.listNonterminal()).toEqual([]);
        }
      } finally {
        try {
          await supervisor.close();
        } finally {
          await Promise.allSettled([admission, shutdown]);
        }
      }
    },
  );
});

describe("node worker environment stop after failed initialization", () => {
  it("holds workspace admission through failed supervisor settlement until cleanup succeeds", async () => {
    const root = tempDirs.make("node-worker-stop-settlement-");
    const workspace = new NodeWorkerWorkspaceRuntime({
      root,
      env: {
        PATH: path.dirname(process.execPath),
        HOME: root,
        NODE_DISABLE_COMPILE_CACHE: "1",
      },
    });
    const { supervisor } = createNodeWorkerSupervisorFixture(root, { workspace });
    const entered = createDeferred();
    const finish = createDeferred();
    const failure = new Error("worker journal cleanup is uncertain");
    vi.spyOn(supervisor, "initialize").mockImplementationOnce(async () => {
      entered.resolve();
      await finish.promise;
      throw failure;
    });
    const identity = {
      gatewayNamespace: "gateway-preview",
      environmentId: "worker:preview",
      sessionId: "conversation-preview",
      generation: 1,
    };
    const command: NodeWorkerWorkspaceExecInput = {
      ...identity,
      nativeProcessOwner: true,
      argv: [path.basename(process.execPath), "-e", "process.stdout.write('fresh')"],
    };
    const stopping = supervisor.stopEnvironment({ ...identity, ownerEpoch: 1 });
    void stopping.catch(() => undefined);
    try {
      await awaitGateBeforeSettlement(
        entered.promise,
        stopping,
        "supervisor cleanup did not begin",
      );
      await expect(workspace.exec(command)).rejects.toThrow("retired");
      expect(() =>
        supervisor.observeProcesses({
          ...identity,
          ownerEpoch: 1,
          placementGeneration: 1,
          expectedBundleHash: "a".repeat(64),
          operation: { action: "list" },
        }),
      ).toThrow("retired");
      finish.resolve();
      await expect(stopping).rejects.toBe(failure);
      await expect(workspace.exec(command)).rejects.toThrow("retired");
      await supervisor.stopEnvironment({ ...identity, ownerEpoch: 1 });
      expect((await workspace.exec(command)).stdout).toBe("fresh");
    } finally {
      finish.resolve();
      await stopping.catch(() => undefined);
      await supervisor.close();
    }
  });

  it.runIf(process.platform === "linux" || process.platform === "darwin")(
    "settles native recovery without publishing capacity until the unrelated container recovers",
    async () => {
      const cleanupMode =
        process.platform === "linux" && !process.versions.bun ? "linux-subreaper" : "owned-anchor";
      const capacities: Array<{ total: number; available: number }> = [];
      const root = tempDirs.make("node-worker-stop-initialization-");
      const fixture = createNodeWorkerContainerFixture(root, fileLockModule, {
        capacity: 3,
        onCapacityChanged: (capacity) => capacities.push(capacity),
      });
      fs.writeFileSync(fixture.bundleEntry, TEST_WORKER_SOURCE);
      const native = testWorkerLaunchInput(fixture.workspaceDir, "a-native-owner", "wait");
      native.descriptor.admission.environmentId = "native-environment";
      native.descriptor.admission.sessionId = "native-session";
      const owner = spawnSupervisorOwner({
        bundleRoot: fixture.bundleRoot,
        env: fixture.env,
        input: native,
        root,
      });
      let anchor: NodeWorkerProcessIdentity | undefined;
      let stopping: Promise<unknown> | undefined;
      let bodyFailure: { error: unknown } | undefined;
      await (async () => {
        const receipt = JSON.parse(await waitForChildLine(owner)) as NodeWorkerLaunchReceipt;
        anchor = receipt.worker!;
        expect(receipt.workerCleanupMode).toBe(cleanupMode);
        process.kill(anchor.pid, "SIGSTOP");
        owner.kill("SIGKILL");
        await waitForChildExit(owner);

        const store = new NodeWorkerLaunchStore(new NodeWorkerJournalWorker({ env: fixture.env }));
        const live = testWorkerLaunchInput(fixture.workspaceDir, "m-live-pending");
        await store.claim(
          { ...testNodeWorkerLaunchIdentity(live), gatewayNamespace: live.gatewayNamespace },
          requireNodeWorkerProcessIdentity(process.pid),
          3,
        );
        const blocked = testWorkerLaunchInput(fixture.workspaceDir, "z-blocked-container");
        const container = fixture.seed({ id: "d".repeat(64), launchId: blocked.launchId });
        const staleSupervisor = { pid: 2_147_483_647, startTime: 1 };
        const claim = {
          ...testNodeWorkerLaunchIdentity(blocked),
          gatewayNamespace: blocked.gatewayNamespace,
        };
        await store.claim(claim, staleSupervisor, 3);
        await store.markRunning({
          ...claim,
          supervisor: staleSupervisor,
          worker: { pid: 2_147_483_646, startTime: 1 },
          cleanupMode: null,
          container: {
            engine: "docker",
            engineTarget: fixture.containerEngine.target,
            containerId: container.id,
          },
        });
        const preserved = [await store.get(live.launchId), await store.get(blocked.launchId)];
        expect((await store.listNonterminal()).map((entry) => entry.launchId)).toEqual([
          native.launchId,
          live.launchId,
          blocked.launchId,
        ]);
        const failureMarker = path.join(fixture.engineRoot, "fail-removal");
        fs.writeFileSync(failureMarker, "fail");
        const failedInitialization = /injected container removal failure/u;
        await expect(fixture.supervisor.initialize()).rejects.toThrow(failedInitialization);
        expect(inspectNodeWorkerProcessIdentity(anchor)).toBe("live");
        expect(await store.get(native.launchId)).toMatchObject({
          state: "running",
          workerLineageSettled: false,
          ...(cleanupMode === "linux-subreaper" ? { workerDescendantsReaped: false } : {}),
        });
        expect(capacities).toEqual([{ total: 3, available: 0 }]);

        const settled = vi.fn();
        stopping = fixture.supervisor
          .stopEnvironment(testNodeWorkerEnvironmentIdentity(native))
          .then(settled, (error: unknown) => {
            settled();
            return error;
          });
        await expect(fixture.supervisor.initialize()).rejects.toThrow(failedInitialization);
        await expect(fixture.supervisor.initialize()).rejects.toThrow(failedInitialization);
        await setImmediate();
        expect(settled).not.toHaveBeenCalled();
        process.kill(anchor.pid, "SIGCONT");
        expect(await stopping).toMatchObject({
          message: expect.stringMatching(failedInitialization),
        });
        expect(inspectOwnedNodeWorkerTree(anchor)).toBe("dead");
        const cancelled = await store.get(native.launchId);
        expect(cancelled).toMatchObject({
          state: "cancelled",
          workerLineageSettled: cleanupMode === "owned-anchor",
          ...(cleanupMode === "linux-subreaper" ? { workerDescendantsReaped: true } : {}),
        });
        expect([await store.get(live.launchId), await store.get(blocked.launchId)]).toEqual(
          preserved,
        );
        expect(fixture.exists(container.id)).toBe(true);
        await expect(fixture.supervisor.status(native.launchId)).rejects.toThrow(
          failedInitialization,
        );
        await expect(
          fixture.supervisor.launch(
            testWorkerLaunchInput(fixture.workspaceDir, "still-unavailable"),
            TEST_WORKER_ENDPOINT,
          ),
        ).rejects.toThrow(failedInitialization);
        for (const capacity of capacities) {
          expect(capacity).toEqual({ total: 3, available: 0 });
        }
        expect(await fixture.supervisor.hasActiveWork()).toBe(true);

        fs.unlinkSync(failureMarker);
        await fixture.supervisor.initialize();
        expect(capacities.at(-1)).toEqual({ total: 3, available: 2 });
        expect(await store.get(native.launchId)).toEqual(cancelled);
        expect(await store.get(live.launchId)).toEqual(preserved[0]);
        expect((await store.get(blocked.launchId))?.state).toBe("interrupted");
        expect(fixture.exists(container.id)).toBe(false);
        expect(await store.nonterminalCount()).toBe(1);
        expect(await fixture.supervisor.status(native.launchId)).toMatchObject({
          state: "cancelled",
        });
      })().catch((error: unknown) => {
        bodyFailure = { error };
      });
      const resumed = Promise.resolve().then(() => {
        if (anchor && inspectNodeWorkerProcessIdentity(anchor) === "live") {
          process.kill(anchor.pid, "SIGCONT");
        }
      });
      const ownerExit = resumed
        .catch(() => undefined)
        .then(async () => {
          if (owner.exitCode === null && owner.signalCode === null) {
            owner.kill("SIGTERM");
          }
          await waitForChildExit(owner);
        });
      const cleanupErrors = (
        await Promise.allSettled([
          resumed,
          ownerExit,
          stopping,
          Promise.resolve().then(() => fixture.supervisor.close()),
          resumed.catch(() => undefined).then(() => anchor && waitForIdentityDeath(anchor)),
        ])
      ).flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          bodyFailure ? [bodyFailure.error, ...cleanupErrors] : cleanupErrors,
          "mixed worker recovery fixture cleanup failed",
          { cause: bodyFailure ? bodyFailure.error : cleanupErrors[0] },
        );
      }
      if (bodyFailure) {
        throw bodyFailure.error;
      }
    },
  );
});
