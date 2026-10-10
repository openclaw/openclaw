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
  const fixture = createNodeWorkerContainerFixture(
    tempDirs.make("node-worker-container-"),
    fileLockModule,
    options,
  );
  const store = new NodeWorkerLaunchStore(new NodeWorkerJournalWorker({ env: fixture.env }));
  const pending: Promise<unknown>[] = [];
  return {
    ...fixture,
    store,
    ownOperation<T>(operation: Promise<T>): Promise<T> {
      // Keep the original result assertable while disposal owns early failures.
      void operation.catch(() => undefined);
      pending.push(operation);
      return operation;
    },
    async [Symbol.asyncDispose]() {
      try {
        await fixture.supervisor.close();
      } finally {
        await Promise.allSettled(pending);
      }
    },
  };
}

function readWorkerFixture(
  fixture: ReturnType<typeof containerFixture>,
  launchId: string,
): unknown {
  return JSON.parse(
    fs.readFileSync(path.join(fixture.workspaceDir, `${launchId}.fixture.json`), "utf8"),
  );
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
  const input = testWorkerLaunchInput(fixture.workspaceDir, launchId, "wait");
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
    const input = testWorkerLaunchInput(fixture.workspaceDir, "container-success");
    const dispatches: Array<{ data: string; admission: NodeWorkerLaunchReceipt | undefined }> = [];
    const recordAdmission = vi.spyOn(NodeWorkerLaunchStore.prototype, "markRunning");
    const captureAdapter = observeNodeWorkerAdapters((adapter) => {
      const stdin = adapter.stdin;
      if (!stdin) {
        throw new Error("missing container worker stdin");
      }
      const write = stdin.write.bind(stdin);
      vi.spyOn(stdin, "write").mockImplementation((data, callback) => {
        // Observe dispatch before the fake engine can wait for journal readiness.
        const result = recordAdmission.mock.settledResults.at(-1);
        dispatches.push({
          data: data.toString(),
          admission: result?.type === "fulfilled" ? result.value : undefined,
        });
        write(data, callback);
      });
    });

    try {
      const running = await fixture.supervisor.launch(input, endpoint);
      expect(running).toMatchObject({
        state: "running",
        container: {
          engine: "docker",
          engineTarget: fixture.containerEngine.target,
          containerId: expect.stringMatching(/^[a-f0-9]{64}$/u),
        },
      });
      const completed = await waitForTerminal(fixture.supervisor, input.launchId);
      expect(completed).toMatchObject({ state: "completed" });
      expect(JSON.parse(completed.resultJson ?? "null")).toEqual({
        status: "completed",
        transcriptLeafId: "leaf-1",
        transcriptNextSeq: 2,
      });
      expect(readWorkerFixture(fixture, input.launchId)).toEqual({
        pid: expect.any(Number),
        argv: ["--internal-worker-session"],
        endpoint,
      });

      const create = fixture.events().find((event) => event.argv[0] === "create");
      expect(create?.container?.labels).toEqual({
        [hostLabel]: fixture.owner,
        [gatewayLabel]: "gateway-1",
        [launchLabel]: Buffer.from(input.launchId).toString("base64url"),
      });
      const bundleDir = path.dirname(fixture.bundleEntry);
      expect(create?.container?.mounts).toEqual([
        `type=bind,source=${bundleDir},target=${bundleDir},readonly`,
        `type=bind,source=${fixture.workspaceDir},target=${fixture.workspaceDir}`,
      ]);
      expect(create?.argv).toContain("--interactive");
      expect(create?.argv).toContain("--workdir");
      expect(create?.argv).toContain(fixture.workspaceDir);
      expect(create?.container?.image).toBe("node:24-slim@sha256:" + "f".repeat(64));
      expect(create?.container?.env).toMatchObject({
        HOME: fixture.workspaceDir,
        LANG: "en_US.UTF-8",
        PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        TMPDIR: "/tmp",
        NODE_COMPILE_CACHE: "/tmp/openclaw-node-worker-compile-cache",
        OPENCLAW_NO_RESPAWN: "1",
      });
      expect(create?.container?.env).not.toHaveProperty("NODE_OPTIONS");
      expect(create?.container?.env).not.toHaveProperty("SUPPLIED_SECRET");
      expect(create?.container?.env).not.toHaveProperty("OPENCLAW_STATE_DIR");
      const started = fixture.events().find((event) => event.argv[0] === "start");
      expect(started?.argv).toEqual([
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
    const input = testWorkerLaunchInput(fixture.workspaceDir, "container-startup-poll");
    const startMarker = path.join(fixture.engineRoot, "hold-start");
    fs.writeFileSync(startMarker, "hold");

    try {
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
    } finally {
      fs.rmSync(startMarker, { force: true });
    }
  });

  it("rejects a daemon switch before launch so the replacement receives zero create or start requests", async () => {
    await using fixture = containerFixture();
    const input = testWorkerLaunchInput(fixture.workspaceDir, "container-replacement-daemon");
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
      const input = testWorkerLaunchInput(fixture.workspaceDir, "container-unresponsive-daemon");
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
      expect(
        fixture.events().filter((event) => event.argv[0] === "create" || event.argv[0] === "start"),
      ).toEqual([]);
    },
  );

  it("keeps a pending cancelled container slot occupied until the fake engine confirms removal", async () => {
    const capacitySnapshots: Array<{ total: number; available: number }> = [];
    await using fixture = containerFixture({
      capacity: 1,
      onCapacityChanged: (capacity) => capacitySnapshots.push(capacity),
    });
    const input = testWorkerLaunchInput(fixture.workspaceDir, "container-pending-cancel", "wait");
    const createMarker = path.join(fixture.engineRoot, "hold-create");
    const removalMarker = path.join(fixture.engineRoot, "hold-removal");
    const { store } = fixture;
    await fixture.supervisor.initialize();
    fs.writeFileSync(createMarker, "hold");
    fs.writeFileSync(removalMarker, "hold");

    try {
      const launch = fixture.ownOperation(fixture.supervisor.launch(input, endpoint));
      await vi.waitFor(
        () => expect(fixture.events().some((event) => event.argv[0] === "create")).toBe(true),
        { timeout: 5_000 },
      );
      expect((await store.get(input.launchId))?.state).toBe("pending");

      const cancellation = fixture.ownOperation(
        fixture.supervisor.cancel(testNodeWorkerLaunchIdentity(input)),
      );
      await vi.waitFor(() => expect(capacitySnapshots.at(-1)).toEqual({ total: 1, available: 0 }));
      expect((await store.get(input.launchId))?.state).toBe("pending");

      fs.unlinkSync(createMarker);
      await vi.waitFor(
        () => expect(fixture.events().some((event) => event.argv[0] === "rm")).toBe(true),
        { timeout: 5_000 },
      );
      expect((await store.get(input.launchId))?.state).toMatch(/^(?:pending|running)$/u);
      expect(capacitySnapshots.at(-1)).toEqual({ total: 1, available: 0 });

      fs.unlinkSync(removalMarker);
      await expect(cancellation).resolves.toMatchObject({ state: "cancelled" });
      await launch;
      expect(capacitySnapshots.at(-1)).toEqual({ total: 1, available: 1 });
      expect(fixture.events().find((event) => event.argv[0] === "rm")?.journal?.state).toMatch(
        /^(?:pending|running)$/u,
      );
    } finally {
      for (const marker of [createMarker, removalMarker]) {
        fs.rmSync(marker, { force: true });
      }
    }
  });

  it("cancels a claimed container launch when its invocation aborts during creation", async () => {
    const capacitySnapshots: Array<{ total: number; available: number }> = [];
    await using fixture = containerFixture({
      capacity: 1,
      onCapacityChanged: (capacity) => capacitySnapshots.push(capacity),
    });
    const input = testWorkerLaunchInput(fixture.workspaceDir, "container-creation-abort", "wait");
    const createMarker = path.join(fixture.engineRoot, "hold-create");
    const { store } = fixture;
    const controller = new AbortController();
    await fixture.supervisor.initialize();
    fs.writeFileSync(createMarker, "hold");

    try {
      const launch = fixture.ownOperation(
        fixture.supervisor.launch(input, endpoint, controller.signal),
      );
      await vi.waitFor(
        () => expect(fixture.events().some((event) => event.argv[0] === "create")).toBe(true),
        { timeout: 5_000 },
      );
      const container = fixture.events().find((event) => event.argv[0] === "create")?.container;
      if (!container) {
        throw new Error("expected a claimed container under creation");
      }
      expect((await store.get(input.launchId))?.state).toBe("pending");
      expect(capacitySnapshots.at(-1)).toEqual({ total: 1, available: 0 });

      controller.abort(new Error("invoke cancelled"));
      fs.unlinkSync(createMarker);
      await launch.catch(() => undefined);

      expect(await store.get(input.launchId)).toMatchObject({ state: "cancelled" });
      expect(fixture.exists(container.id)).toBe(false);
      expect(fs.existsSync(path.join(fixture.workspaceDir, "worker-started"))).toBe(false);
      expect(capacitySnapshots.at(-1)).toEqual({ total: 1, available: 1 });
    } finally {
      fs.rmSync(createMarker, { force: true });
    }
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
    const orphanKill = fixture
      .events()
      .find((event) => event.argv[0] === "kill" && event.argv[1] === orphan.id);
    expect(orphanKill?.journal?.state).toBe("pending");
    expect(fixture.events().some((event) => event.argv.includes(foreign.id))).toBe(false);
  });

  it("preserves a live foreign supervisor's pending container during reconciliation", async () => {
    await using fixture = containerFixture();
    const launchId = "container-live-pending";
    const container = fixture.seed({ id: "e".repeat(64), launchId });
    const input = testWorkerLaunchInput(fixture.workspaceDir, launchId, "wait");
    const identity = testNodeWorkerLaunchIdentity(input);
    const { store } = fixture;
    await store.claim(
      { ...identity, gatewayNamespace: input.gatewayNamespace },
      requireNodeWorkerProcessIdentity(process.pid),
      8,
    );

    await fixture.supervisor.initialize();

    expect(await store.get(launchId)).toMatchObject({ state: "pending" });
    expect(fixture.exists(container.id)).toBe(true);
    expect(fixture.events().some((event) => event.argv[0] === "kill")).toBe(false);
  });

  it("interrupts a stale running journal after verifying its dead container identity", async () => {
    await using fixture = containerFixture();
    const launchId = "container-dead-recovery";
    const container = fixture.seed({ id: "c".repeat(64), launchId, status: "exited" });
    await claimFixtureLaunch(fixture, launchId, container.id);

    await fixture.supervisor.initialize();

    expect(await fixture.supervisor.status(launchId)).toMatchObject({
      state: "interrupted",
      container: {
        engine: "docker",
        engineTarget: fixture.containerEngine.target,
        containerId: container.id,
      },
    });
    expect(fixture.exists(container.id)).toBe(false);
    expect(
      fixture
        .events()
        .some((event) => event.argv[0] === "inspect" && event.argv.at(-1) === container.id),
    ).toBe(true);
    expect(fixture.events().find((event) => event.argv[0] === "rm")?.journal?.state).toBe(
      "running",
    );
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
    const capacitySnapshots: Array<{ total: number; available: number }> = [];
    await using fixture = containerFixture({
      capacity: 1,
      onCapacityChanged: (capacity) => capacitySnapshots.push(capacity),
    });
    const input = testWorkerLaunchInput(fixture.workspaceDir, "container-removal-failure", "wait");
    const failureMarker = path.join(fixture.engineRoot, "fail-removal");
    const { store } = fixture;

    try {
      const running = await fixture.supervisor.launch(input, endpoint);
      await vi.waitFor(() =>
        expect(fs.existsSync(path.join(fixture.workspaceDir, "worker-started"))).toBe(true),
      );
      fs.writeFileSync(failureMarker, "fail");

      await expect(
        fixture.supervisor.stopEnvironment(testNodeWorkerEnvironmentIdentity(input)),
      ).rejects.toThrow(/removal|failed|injected/iu);
      expect(await store.get(input.launchId)).toMatchObject({
        state: "running",
        container: running.container,
      });
      expect(fixture.exists(running.container!.containerId)).toBe(true);
      expect(capacitySnapshots.at(-1)).toEqual({ total: 1, available: 0 });

      fs.unlinkSync(failureMarker);
      await fixture.supervisor.stopEnvironment(testNodeWorkerEnvironmentIdentity(input));
      expect(await fixture.supervisor.status(input.launchId)).toMatchObject({
        state: "interrupted",
      });
      expect(fixture.exists(running.container!.containerId)).toBe(false);
      expect(capacitySnapshots.at(-1)).toEqual({ total: 1, available: 1 });
    } finally {
      fs.rmSync(failureMarker, { force: true });
    }
  });

  it("waits for healthy container shutdown before reporting a sibling removal failure", async () => {
    await using fixture = containerFixture({ capacity: 2 });
    const first = testWorkerLaunchInput(fixture.workspaceDir, "container-close-failed", "wait");
    const sibling = testWorkerLaunchInput(fixture.workspaceDir, "container-close-sibling", "wait");
    sibling.descriptor.admission.environmentId = "sibling-environment";
    sibling.descriptor.admission.sessionId = "sibling-session";
    const removalMarker = path.join(fixture.engineRoot, "hold-removal");
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
      await vi.waitFor(
        () => expect(fixture.events().filter((event) => event.argv[0] === "start")).toHaveLength(2),
        { timeout: 5_000 },
      );
      fs.writeFileSync(removalMarker, "hold");

      const closing = fixture.supervisor.close();
      const settled = vi.fn();
      void closing.then(settled, settled);
      await vi.waitFor(
        () =>
          expect(
            fixture
              .events()
              .some(
                (event) =>
                  event.argv[0] === "rm" &&
                  event.argv.at(-1) === siblingWorker.container!.containerId,
              ),
          ).toBe(true),
        { timeout: 5_000 },
      );

      expect(settled).not.toHaveBeenCalled();
      expect(fixture.exists(siblingWorker.container!.containerId)).toBe(true);

      fs.unlinkSync(removalMarker);
      await expect(closing).rejects.toBe(removalFailure);
      expect(fixture.exists(siblingWorker.container!.containerId)).toBe(false);
      expect(await store.get(sibling.launchId)).toMatchObject({ state: "interrupted" });
      expect(fixture.exists(failedWorker.container!.containerId)).toBe(true);
      expect(await store.get(first.launchId)).toMatchObject({
        state: "running",
        container: failedWorker.container,
      });
    } finally {
      fs.rmSync(removalMarker, { force: true });
      remove.mockRestore();
    }
  });

  it("never dispatches a turn when its durable container identity cannot be recorded", async () => {
    await using fixture = containerFixture();
    const input = testWorkerLaunchInput(fixture.workspaceDir, "container-journal-failure", "wait");
    vi.spyOn(NodeWorkerLaunchStore.prototype, "markRunning").mockImplementation(async () => {
      throw new Error("injected durable container identity failure");
    });
    const writes: string[] = [];
    observeNodeWorkerAdapters((adapter) => {
      const stdin = adapter.stdin;
      if (!stdin) {
        throw new Error("missing container worker stdin");
      }
      const write = stdin.write.bind(stdin);
      vi.spyOn(stdin, "write").mockImplementation((data, callback) => {
        writes.push(data.toString());
        write(data, callback);
      });
    });

    try {
      await expect(fixture.supervisor.launch(input, endpoint)).rejects.toThrow(
        "injected durable container identity failure",
      );

      const create = fixture.events().find((event) => event.argv[0] === "create");
      expect(create?.container?.id).toMatch(/^[a-f0-9]{64}$/u);
      expect(writes).toEqual([]);
      expect(fixture.events().some((event) => event.argv[0] === "rm")).toBe(true);
      expect(fixture.exists(create!.container!.id)).toBe(false);
    } finally {
      vi.restoreAllMocks();
    }
  });
});
