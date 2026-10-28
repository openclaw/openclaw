import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import * as processExec from "../process/exec.js";
import { useStateDatabaseTempDirs } from "../test-utils/state-database-temp-dirs.js";
import type { WorkerConnectionEndpoint } from "../worker/worker-connection-endpoint.js";
import { NodeWorkerContainerLifecycle } from "./node-worker-container-lifecycle.js";
import { NodeWorkerJournalWorker } from "./node-worker-journal-worker.js";
import { NodeWorkerLaunchStore, type NodeWorkerLaunchReceipt } from "./node-worker-launch-store.js";
import * as processIdentity from "./node-worker-process-identity.js";
import { requireNodeWorkerProcessIdentity } from "./node-worker-process-identity.js";
import {
  createNodeWorkerContainerFixture,
  gatewayLabel,
  hostLabel,
  launchLabel,
} from "./node-worker-supervisor.container.test-support.js";
import {
  observeNodeWorkerAdapters,
  waitForNodeWorkerTerminal as waitForTerminal,
} from "./node-worker-supervisor.fixture.test-support.js";
import { createNodeWorkerSupervisor } from "./node-worker-supervisor.js";
import {
  testNodeWorkerEnvironmentIdentity,
  testNodeWorkerLaunchIdentity,
  testWorkerLaunchInput,
} from "./node-worker-supervisor.test-support.js";
import { NodeWorkerTurnStore } from "./node-worker-turn-store.js";

const tempDirs = useStateDatabaseTempDirs();
const endpoint: WorkerConnectionEndpoint = {
  kind: "websocket",
  url: "wss://gateway.example/__openclaw__/worker",
};
const DAEMON_TIMER_SCALE = 5;
const fileLockModule = createRequire(import.meta.url).resolve("@openclaw/fs-safe/file-lock");

function containerFixture(options: Parameters<typeof createNodeWorkerContainerFixture>[2] = {}) {
  const capacitySnapshots: Array<{ total: number; available: number }> = [];
  const fixture = createNodeWorkerContainerFixture(
    tempDirs.make("node-worker-container-"),
    fileLockModule,
    { onCapacityChanged: (capacity) => capacitySnapshots.push(capacity), ...options },
  );
  const store = new NodeWorkerLaunchStore(new NodeWorkerJournalWorker({ env: fixture.env }));
  const pending: Promise<unknown>[] = [];
  const markers: string[] = [];
  return {
    ...fixture,
    store,
    input: (id: string, prompt?: string) => testWorkerLaunchInput(fixture.workspaceDir, id, prompt),
    identity: (containerId: string) => ({
      engine: "docker",
      engineTarget: fixture.containerEngine.target,
      containerId,
    }),
    expectCapacity: (available: number) =>
      expect(capacitySnapshots.at(-1)).toEqual({ total: options.capacity, available }),
    hold(name: string) {
      const marker = path.join(fixture.engineRoot, name);
      markers.push(marker);
      fs.writeFileSync(marker, "hold");
      return () => fs.rmSync(marker, { force: true });
    },
    eventsFor(...commands: string[]) {
      return fixture
        .events()
        .filter((event) => commands.some((command) => command === event.argv[0]));
    },
    async waitForCommand(command: string, count?: number) {
      await vi.waitFor(
        () =>
          count === undefined
            ? expect(this.eventsFor(command)).not.toHaveLength(0)
            : expect(this.eventsFor(command)).toHaveLength(count),
        { timeout: 5_000 },
      );
    },
    ownOperation<T>(operation: Promise<T>): Promise<T> {
      // Keep the original result assertable while disposal owns early failures.
      void operation.catch(() => undefined);
      pending.push(operation);
      return operation;
    },
    async [Symbol.asyncDispose]() {
      for (const marker of markers) {
        fs.rmSync(marker, { force: true });
      }
      try {
        await fixture.supervisor.close();
      } finally {
        await Promise.allSettled(pending);
      }
    },
  };
}

function observeWrites(onWrite: (data: string) => void) {
  return observeNodeWorkerAdapters((adapter) => {
    const stdin = adapter.stdin;
    if (!stdin) {
      throw new Error("missing container worker stdin");
    }
    const write = stdin.write.bind(stdin);
    vi.spyOn(stdin, "write").mockImplementation((data, callback) => {
      onWrite(data.toString());
      write(data, callback);
    });
  });
}

function delayDaemonRevalidation(fixture: ReturnType<typeof containerFixture>, delayMs: number) {
  fs.writeFileSync(
    path.join(fixture.engineRoot, "info-delay-ms"),
    String(delayMs / DAEMON_TIMER_SCALE),
  );
  const requestedTimeouts: number[] = [];
  const runExec = processExec.runExec;
  vi.spyOn(processExec, "runExec").mockImplementation((command, args, options) => {
    if (
      command === fixture.containerEngine.command &&
      args.length === 3 &&
      args[0] === "info" &&
      args[1] === "--format" &&
      args[2] === "{{.ID}}" &&
      typeof options === "object" &&
      typeof options.timeoutMs === "number"
    ) {
      // Scale both sides so the old five-second deadline still loses to the
      // six-second response. Execa, process signals, and other commands stay real.
      requestedTimeouts.push(options.timeoutMs);
      return runExec(command, args, {
        ...options,
        timeoutMs: options.timeoutMs / DAEMON_TIMER_SCALE,
      });
    }
    return runExec(command, args, options);
  });
  return requestedTimeouts;
}

async function claimFixtureLaunch(
  fixture: ReturnType<typeof containerFixture>,
  launchId: string,
  containerId?: string,
) {
  const input = fixture.input(launchId, "wait");
  const identity = testNodeWorkerLaunchIdentity(input);
  const supervisor = { pid: 2_147_483_647, startTime: 1 };
  const worker = { pid: 2_147_483_646, startTime: 1 };
  const journal = new NodeWorkerJournalWorker({ env: fixture.env });
  const store = new NodeWorkerLaunchStore(journal);
  const claim = { ...identity, gatewayNamespace: input.gatewayNamespace };
  await store.claim(claim, supervisor, 8);
  await new NodeWorkerTurnStore(journal).claim({
    claim,
    ownerLaunchId: launchId,
    supervisor,
  });
  if (containerId) {
    await store.markRunning({
      launchId,
      planHash: identity.planHash,
      supervisor,
      worker,
      cleanupMode: null,
      container: { engine: "docker", engineTarget: fixture.containerEngine.target, containerId },
    });
  }
  return { input, journal, store };
}

describe("node worker supervisor container isolation", () => {
  it("mounts only the admitted bundle and workspace and round-trips the stdio result", async () => {
    await using fixture = containerFixture({
      image: "node:24-slim@sha256:" + "f".repeat(64),
      env: {
        HOME: "/private/operator-home",
        LANG: "en_US.UTF-8",
        PATH: "/private/operator-bin",
        TMPDIR: "/private/operator-temp",
        NODE_OPTIONS: "--title=forbidden-worker-title",
        SUPPLIED_SECRET: "must-not-enter-container",
      },
    });
    const input = fixture.input("container-success");
    const dispatches: Array<{ data: string; admission: NodeWorkerLaunchReceipt | undefined }> = [];
    const recordAdmission = vi.spyOn(NodeWorkerLaunchStore.prototype, "markRunning");
    const captureAdapter = observeWrites((data) => {
      // Observe dispatch before the fake engine waits for journal readiness.
      const result = recordAdmission.mock.settledResults.at(-1);
      dispatches.push({
        data,
        admission: result?.type === "fulfilled" ? result.value : undefined,
      });
    });

    try {
      const running = await fixture.supervisor.launch(input, endpoint);
      expect(running).toMatchObject({
        state: "running",
        container: fixture.identity(expect.stringMatching(/^[a-f0-9]{64}$/u)),
      });
      const completed = await waitForTerminal(fixture.supervisor, input.launchId);
      expect(completed).toMatchObject({ state: "completed" });
      expect(JSON.parse(completed.resultJson ?? "null")).toEqual({
        status: "completed",
        transcriptLeafId: "leaf-1",
        transcriptNextSeq: 2,
      });
      const workerPath = path.join(fixture.workspaceDir, `${input.launchId}.fixture.json`);
      expect(JSON.parse(fs.readFileSync(workerPath, "utf8"))).toEqual({
        pid: expect.any(Number),
        argv: ["--internal-worker-session"],
        endpoint,
      });

      const create = fixture.eventsFor("create")[0];
      const bundleDir = path.dirname(fixture.bundleEntry);
      expect(create?.argv).toEqual(
        expect.arrayContaining(["--interactive", "--workdir", fixture.workspaceDir]),
      );
      expect(create?.container).toEqual(
        expect.objectContaining({
          labels: {
            [hostLabel]: fixture.owner,
            [gatewayLabel]: "gateway-1",
            [launchLabel]: Buffer.from(input.launchId).toString("base64url"),
          },
          mounts: [
            `type=bind,source=${bundleDir},target=${bundleDir},readonly`,
            `type=bind,source=${fixture.workspaceDir},target=${fixture.workspaceDir}`,
          ],
          image: "node:24-slim@sha256:" + "f".repeat(64),
          env: expect.objectContaining({
            HOME: fixture.workspaceDir,
            LANG: "en_US.UTF-8",
            PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
            TMPDIR: "/tmp",
            NODE_COMPILE_CACHE: "/tmp/openclaw-node-worker-compile-cache",
            OPENCLAW_NO_RESPAWN: "1",
          }),
        }),
      );
      expect(create?.container?.env).not.toHaveProperty("NODE_OPTIONS");
      expect(create?.container?.env).not.toHaveProperty("SUPPLIED_SECRET");
      expect(create?.container?.env).not.toHaveProperty("OPENCLAW_STATE_DIR");
      expect(fixture.eventsFor("start")[0]?.argv).toEqual([
        "start",
        "--attach",
        "--interactive",
        running.container!.containerId,
      ]);
      expect(dispatches).toEqual([
        {
          data: expect.any(String),
          admission: expect.objectContaining({
            ...testNodeWorkerLaunchIdentity(input),
            state: "running",
            container: running.container,
          }),
        },
      ]);
      expect(JSON.parse(dispatches[0]!.data)).toMatchObject({
        type: "turn",
        turnId: input.launchId,
      });
    } finally {
      captureAdapter.mockRestore();
      recordAdmission.mockRestore();
    }
  });

  it("keeps a launch running while its container is still starting", async () => {
    await using fixture = containerFixture();
    const input = fixture.input("container-startup-poll");
    fixture.hold("hold-start");
    const running = await fixture.supervisor.launch(input, endpoint);

    // The fake engine keeps the container created until this poll inspects it,
    // so the supervisor must not read startup as an exited worker.
    expect(await fixture.supervisor.status(input.launchId)).toMatchObject({
      state: "running",
      container: running.container,
    });
    expect(await waitForTerminal(fixture.supervisor, input.launchId)).toMatchObject({
      state: "completed",
    });
  });

  it("rejects a daemon switch before launch so the replacement receives zero create or start requests", async () => {
    await using fixture = containerFixture();
    const input = fixture.input("container-replacement-daemon");
    const replacementDaemonId = "fake-replacement-daemon";
    const replacementTarget = createHash("sha256")
      .update(`docker\0${replacementDaemonId}`)
      .digest("hex");

    await fixture.supervisor.initialize();
    const startupEventCount = fixture.events().length;
    fs.writeFileSync(path.join(fixture.engineRoot, "daemon-id"), replacementDaemonId);

    const failed = await fixture.supervisor.launch(input, endpoint);

    expect(failed).toMatchObject({ state: "failed" });
    expect(failed.errorText).toContain(fixture.containerEngine.target);
    expect(failed.errorText).toContain(replacementTarget);
    const replacementEvents = fixture.events().slice(startupEventCount);
    expect(replacementEvents.filter((event) => event.argv[0] === "info")).toHaveLength(1);
    expect(
      replacementEvents.filter((event) => event.argv[0] === "create" || event.argv[0] === "start"),
    ).toEqual([]);
  });

  it(
    "records the revalidation command when the daemon exceeds its deadline",
    { timeout: 45_000 },
    async () => {
      await using fixture = containerFixture();
      const input = fixture.input("container-unresponsive-daemon");
      const requestedTimeouts = delayDaemonRevalidation(fixture, 35_000);

      const failed = await fixture.supervisor.launch(input, endpoint);

      expect(failed.state).toBe("failed");
      expect(requestedTimeouts).toEqual([30_000]);
      expect(failed.errorText).toContain(
        "Container command timed out after 30000 milliseconds: docker info",
      );
      expect(failed.errorText).not.toContain(fixture.containerEngine.command);
      expect(await fixture.supervisor.status(input.launchId)).toMatchObject({
        state: "failed",
        errorText: failed.errorText,
      });
      expect(fixture.eventsFor("create", "start")).toEqual([]);
    },
  );

  it("keeps a pending cancelled container slot occupied until the fake engine confirms removal", async () => {
    await using fixture = containerFixture({ capacity: 1 });
    const input = fixture.input("container-pending-cancel", "wait");
    const { store } = fixture;
    await fixture.supervisor.initialize();
    const releaseCreate = fixture.hold("hold-create");
    const releaseRemoval = fixture.hold("hold-removal");
    const launch = fixture.ownOperation(fixture.supervisor.launch(input, endpoint));
    await fixture.waitForCommand("create");
    expect((await store.get(input.launchId))?.state).toBe("pending");

    const cancellation = fixture.ownOperation(
      fixture.supervisor.cancel(testNodeWorkerLaunchIdentity(input)),
    );
    await vi.waitFor(() => fixture.expectCapacity(0));
    expect((await store.get(input.launchId))?.state).toBe("pending");

    releaseCreate();
    await fixture.waitForCommand("rm");
    expect((await store.get(input.launchId))?.state).toMatch(/^(?:pending|running)$/u);
    fixture.expectCapacity(0);

    releaseRemoval();
    await expect(cancellation).resolves.toMatchObject({ state: "cancelled" });
    await launch;
    fixture.expectCapacity(1);
    expect(fixture.eventsFor("rm")[0]?.journal?.state).toMatch(/^(?:pending|running)$/u);
  });

  it("cancels a claimed container launch when its invocation aborts during creation", async () => {
    await using fixture = containerFixture({ capacity: 1 });
    const input = fixture.input("container-creation-abort", "wait");
    const { store } = fixture;
    const controller = new AbortController();
    await fixture.supervisor.initialize();
    const releaseCreate = fixture.hold("hold-create");
    const launch = fixture.ownOperation(
      fixture.supervisor.launch(input, endpoint, controller.signal),
    );
    await fixture.waitForCommand("create");
    const container = fixture.eventsFor("create")[0]?.container;
    if (!container) {
      throw new Error("expected a claimed container under creation");
    }
    expect((await store.get(input.launchId))?.state).toBe("pending");
    fixture.expectCapacity(0);

    controller.abort(new Error("invoke cancelled"));
    releaseCreate();
    await launch.catch(() => undefined);

    expect(await store.get(input.launchId)).toMatchObject({ state: "cancelled" });
    expect(fixture.exists(container.id)).toBe(false);
    expect(fs.existsSync(path.join(fixture.workspaceDir, "worker-started"))).toBe(false);
    fixture.expectCapacity(1);
  });

  it("sweeps owned orphan containers before finalizing stale pending launches", async () => {
    await using fixture = containerFixture();
    const launchId = "container-pending\torphan\nline";
    const orphan = fixture.seed({ id: "a".repeat(64), launchId });
    const foreign = fixture.seed({
      id: "b".repeat(64),
      launchId: "other-node-host",
      owner: "f".repeat(32),
    });
    await claimFixtureLaunch(fixture, launchId);

    await fixture.supervisor.initialize();

    expect(fixture.exists(orphan.id)).toBe(false);
    expect(fixture.exists(foreign.id)).toBe(true);
    expect(await fixture.supervisor.status(launchId)).toMatchObject({ state: "interrupted" });
    const orphanKill = fixture.eventsFor("kill").find((event) => event.argv[1] === orphan.id);
    expect(orphanKill?.journal?.state).toBe("pending");
    expect(fixture.events().some((event) => event.argv.includes(foreign.id))).toBe(false);
  });

  it.each([false, true])(
    "reconciles a pending container with live PIDs and reboot=%s",
    async (rebooted) => {
      await using fixture = containerFixture();
      const launchId = "container-live-pending";
      const container = fixture.seed({ id: "e".repeat(64), launchId });
      const input = fixture.input(launchId, "wait");
      const identity = testNodeWorkerLaunchIdentity(input);
      const { store } = fixture;
      const boot = vi.spyOn(processIdentity, "getNodeWorkerBootIdentity").mockReturnValue("boot-a");
      try {
        await store.claim(
          { ...identity, gatewayNamespace: input.gatewayNamespace },
          requireNodeWorkerProcessIdentity(process.pid),
          8,
        );

        boot.mockReturnValue(rebooted ? "boot-b" : "boot-a");
        await fixture.supervisor.initialize();

        expect(await store.get(launchId)).toMatchObject({
          state: rebooted ? "interrupted" : "pending",
        });
        expect(fixture.exists(container.id)).toBe(!rebooted);
        expect(fixture.events().some((event) => event.argv[0] === "kill")).toBe(rebooted);
      } finally {
        boot.mockRestore();
      }
    },
  );

  it("interrupts a stale running journal after verifying its dead container identity", async () => {
    await using fixture = containerFixture();
    const launchId = "container-dead-recovery";
    const container = fixture.seed({ id: "c".repeat(64), launchId, status: "exited" });
    await claimFixtureLaunch(fixture, launchId, container.id);

    await fixture.supervisor.initialize();

    expect(await fixture.supervisor.status(launchId)).toMatchObject({
      state: "interrupted",
      container: fixture.identity(container.id),
    });
    expect(fixture.exists(container.id)).toBe(false);
    expect(fixture.eventsFor("inspect").some((event) => event.argv.at(-1) === container.id)).toBe(
      true,
    );
    expect(fixture.eventsFor("rm")[0]?.journal?.state).toBe("running");
  });

  it.each([
    { mismatch: "engine", error: /engine|docker|podman/iu },
    { mismatch: "daemon target", error: /target|daemon|context/iu },
  ])(
    "refuses recovery with a different $mismatch without touching its container",
    async ({ mismatch, error }) => {
      await using fixture = containerFixture();
      const launchId = "container-wrong-context";
      const container = fixture.seed({ id: "d".repeat(64), launchId });
      const { store } = await claimFixtureLaunch(fixture, launchId, container.id);
      const replacement = createNodeWorkerSupervisor({
        bundleRoot: fixture.bundleRoot,
        env: fixture.env,
        containerEngine: {
          id: mismatch === "engine" ? "podman" : "docker",
          command: fixture.containerEngine.command,
          target: mismatch === "engine" ? fixture.containerEngine.target : "d".repeat(64),
        },
      });
      try {
        await expect(replacement.initialize()).rejects.toThrow(error);
        expect(await store.get(launchId)).toMatchObject({
          state: "running",
          container: {
            engine: "docker",
            engineTarget: fixture.containerEngine.target,
            containerId: container.id,
          },
        });
        expect(fixture.exists(container.id)).toBe(true);
        expect(fixture.events()).toEqual([]);
      } finally {
        await replacement.close().catch(() => undefined);
      }
    },
  );

  it("keeps the launch and capacity occupied when removal fails until environment teardown can retry", async () => {
    await using fixture = containerFixture({ capacity: 1 });
    const input = fixture.input("container-removal-failure", "wait");
    const { store } = fixture;
    const running = await fixture.supervisor.launch(input, endpoint);
    await vi.waitFor(() =>
      expect(fs.existsSync(path.join(fixture.workspaceDir, "worker-started"))).toBe(true),
    );
    const releaseFailure = fixture.hold("fail-removal");

    await expect(
      fixture.supervisor.stopEnvironment(testNodeWorkerEnvironmentIdentity(input)),
    ).rejects.toThrow(/removal|failed|injected/iu);
    expect(await store.get(input.launchId)).toMatchObject({
      state: "running",
      container: running.container,
    });
    expect(fixture.exists(running.container!.containerId)).toBe(true);
    fixture.expectCapacity(0);

    releaseFailure();
    await fixture.supervisor.stopEnvironment(testNodeWorkerEnvironmentIdentity(input));
    expect(await fixture.supervisor.status(input.launchId)).toMatchObject({
      state: "interrupted",
    });
    expect(fixture.exists(running.container!.containerId)).toBe(false);
    fixture.expectCapacity(1);
  });

  it("waits for healthy container shutdown before reporting a sibling removal failure", async () => {
    await using fixture = containerFixture({ capacity: 2 });
    const first = fixture.input("container-close-failed", "wait");
    const sibling = fixture.input("container-close-sibling", "wait");
    sibling.descriptor.admission.environmentId = "sibling-environment";
    sibling.descriptor.admission.sessionId = "sibling-session";
    const { store } = fixture;
    const removalFailure = new Error("injected first container removal failure");
    const originalRemove = Reflect.get(
      NodeWorkerContainerLifecycle.prototype,
      "remove",
    ) as NodeWorkerContainerLifecycle["remove"];
    const remove = vi
      .spyOn(NodeWorkerContainerLifecycle.prototype, "remove")
      .mockImplementation(async function (this: NodeWorkerContainerLifecycle, container, owner) {
        if (owner.launchId === first.launchId) {
          throw removalFailure;
        }
        await originalRemove.call(this, container, owner);
      });

    try {
      const failedWorker = await fixture.supervisor.launch(first, endpoint);
      const siblingWorker = await fixture.supervisor.launch(sibling, endpoint);
      await fixture.waitForCommand("start", 2);
      const releaseRemoval = fixture.hold("hold-removal");

      const closing = fixture.supervisor.close();
      const settled = vi.fn();
      void closing.then(settled, settled);
      await vi.waitFor(
        () =>
          expect(
            fixture
              .eventsFor("rm")
              .some((event) => event.argv.at(-1) === siblingWorker.container!.containerId),
          ).toBe(true),
        { timeout: 5_000 },
      );

      expect(settled).not.toHaveBeenCalled();
      expect(fixture.exists(siblingWorker.container!.containerId)).toBe(true);

      releaseRemoval();
      await expect(closing).rejects.toBe(removalFailure);
      expect(fixture.exists(siblingWorker.container!.containerId)).toBe(false);
      expect(await store.get(sibling.launchId)).toMatchObject({ state: "interrupted" });
      expect(fixture.exists(failedWorker.container!.containerId)).toBe(true);
      expect(await store.get(first.launchId)).toMatchObject({
        state: "running",
        container: failedWorker.container,
      });
    } finally {
      remove.mockRestore();
    }
  });

  it("never dispatches a turn when its durable container identity cannot be recorded", async () => {
    await using fixture = containerFixture();
    const input = fixture.input("container-journal-failure", "wait");
    vi.spyOn(NodeWorkerLaunchStore.prototype, "markRunning").mockImplementation(async () => {
      throw new Error("injected durable container identity failure");
    });
    const writes: string[] = [];
    observeWrites((data) => writes.push(data));

    try {
      await expect(fixture.supervisor.launch(input, endpoint)).rejects.toThrow(
        "injected durable container identity failure",
      );

      const create = fixture.eventsFor("create")[0];
      expect(create?.container?.id).toMatch(/^[a-f0-9]{64}$/u);
      expect(writes).toEqual([]);
      expect(fixture.eventsFor("rm")).not.toHaveLength(0);
      expect(fixture.exists(create!.container!.id)).toBe(false);
    } finally {
      vi.restoreAllMocks();
    }
  });
});
