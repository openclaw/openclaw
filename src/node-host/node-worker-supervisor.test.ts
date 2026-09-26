import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { NODE_WORKER_CAPACITY_EXHAUSTED_ERROR_CODE } from "../infra/node-commands.js";
import * as secretRegistry from "../logging/secret-redaction-registry.js";
import { resetSecretRedactionRegistryForTest } from "../logging/secret-redaction-registry.test-support.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { NodeWorkerJournalWorker } from "./node-worker-journal-worker.js";
import { NodeWorkerLaunchStore } from "./node-worker-launch-store.js";
import type * as workerLaunchTransport from "./node-worker-launch-transport.js";
import {
  inspectNodeWorkerProcessIdentity,
  requireNodeWorkerProcessIdentity,
} from "./node-worker-process-identity.js";
import {
  createNodeWorkerSupervisorFixture,
  observeNodeWorkerAdapters,
  waitForNodeWorkerTerminal as waitForTerminal,
} from "./node-worker-supervisor.fixture.test-support.js";
import { createNodeWorkerSupervisor } from "./node-worker-supervisor.js";
import {
  TEST_WORKER_CREDENTIAL,
  TEST_WORKER_ENDPOINT,
  TEST_WORKER_SOURCE,
  testNodeWorkerLaunchIdentity,
  testWorkerDescriptor,
  testWorkerLaunchInput,
  writeNodeWorkerFixture,
} from "./node-worker-supervisor.test-support.js";
import { NodeWorkerTurnStore } from "./node-worker-turn-store.js";

type NodeWorkerSupervisor = ReturnType<typeof createNodeWorkerSupervisor>;

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    cleanup();
  }),
);

afterEach(() => {
  vi.restoreAllMocks();
  resetSecretRedactionRegistryForTest();
});

function fixture(options: Parameters<typeof createNodeWorkerSupervisor>[0] = {}) {
  return createNodeWorkerSupervisorFixture(tempDirs.make("node-worker-supervisor-"), options);
}

function launchInput(workspaceDir: string, launchId: string, prompt = "success") {
  const input = testWorkerLaunchInput(workspaceDir, launchId, prompt);
  input.descriptor.admission.environmentId = `environment-${launchId}`;
  input.descriptor.admission.sessionId = `session-${launchId}`;
  return input;
}

function evictWorkerCredentialsOnRegistration() {
  const { registerSecretValueForRedaction } = secretRegistry;
  // Both launch paths register before sending a turn. Evict every registration so a
  // later launch cannot restore the global secret and hide a missing worker scrubber.
  return vi.spyOn(secretRegistry, "registerSecretValueForRedaction").mockImplementation((value) => {
    registerSecretValueForRedaction(value);
    for (let index = 0; index < 600; index += 1) {
      registerSecretValueForRedaction(`eviction-secret-${index}`);
    }
    expect(secretRegistry.isSecretValueRegisteredForRedaction(value)).toBe(false);
  });
}

describe("node worker supervisor", () => {
  it("rejects a mismatched launch and turn identity before durable admission", async () => {
    const { env, supervisor, workspaceDir } = fixture();
    const input = launchInput(workspaceDir, "launch-id");
    input.descriptor.assignment.turnId = "other-turn-id";

    try {
      await expect(supervisor.launch(input, TEST_WORKER_ENDPOINT)).rejects.toThrow(
        "launchId must match descriptor assignment turnId",
      );
      expect(
        await new NodeWorkerLaunchStore(new NodeWorkerJournalWorker({ env })).get(input.launchId),
      ).toBeUndefined();
    } finally {
      await supervisor.close();
    }
  });

  it("releases the physical capacity claim when the first turn cannot be journaled", async () => {
    const capacities: Array<{ total: number; available: number }> = [];
    const { env, supervisor, workspaceDir } = fixture({
      capacity: 1,
      capacityWaitMs: 25,
      onCapacityChanged: (capacity) => capacities.push(capacity),
    });
    const input = launchInput(workspaceDir, "turn-claim-failure");
    const claim = vi
      .spyOn(NodeWorkerTurnStore.prototype, "claim")
      .mockImplementationOnce(async () => {
        throw new Error("injected turn claim failure");
      });
    try {
      await expect(supervisor.launch(input, TEST_WORKER_ENDPOINT)).rejects.toThrow(
        "injected turn claim failure",
      );
      expect(
        await new NodeWorkerLaunchStore(new NodeWorkerJournalWorker({ env })).get(input.launchId),
      ).toMatchObject({
        state: "failed",
        worker: null,
      });
      expect(capacities.at(-1)).toEqual({ total: 1, available: 1 });
      expect(fs.existsSync(path.join(workspaceDir, `${input.launchId}.started.json`))).toBe(false);

      const next = launchInput(workspaceDir, "turn-claim-recovered");
      await supervisor.launch(next, TEST_WORKER_ENDPOINT);
      expect((await waitForTerminal(supervisor, next.launchId)).state).toBe("completed");
    } finally {
      claim.mockRestore();
      await supervisor.close();
    }
  });

  it("launches idempotently and persists only bounded non-secret facts", async () => {
    const { env, supervisor, workspaceDir } = fixture();
    const input = launchInput(workspaceDir, "success-launch");
    let adapter: workerLaunchTransport.NodeWorkerChildAdapter | undefined;
    const captureAdapter = observeNodeWorkerAdapters((child) => {
      adapter = child;
    });
    try {
      expect(await supervisor.launch(input, TEST_WORKER_ENDPOINT)).toMatchObject({
        launchId: "success-launch",
        state: "running",
        environmentId: input.descriptor.admission.environmentId,
        sessionId: input.descriptor.admission.sessionId,
        ownerEpoch: 3,
        placementGeneration: 4,
        runId: "run-1",
      });
      captureAdapter.mockRestore();
      if (!adapter) {
        throw new Error("missing worker adapter");
      }
      // Turn completion precedes the anchor's durable lineage-settled fact.
      await (adapter.waitForExtinction?.() ?? adapter.wait());
      const completed = await waitForTerminal(supervisor, input.launchId);
      expect(completed).toMatchObject({ state: "completed", errorText: null });
      expect(JSON.parse(completed.resultJson ?? "null")).toEqual({
        status: "completed",
        transcriptLeafId: "leaf-1",
        transcriptNextSeq: 2,
      });
      expect(
        JSON.parse(fs.readFileSync(path.join(workspaceDir, `${input.launchId}.argv.json`), "utf8")),
      ).toEqual(["--internal-worker-ipc", "--internal-worker-session"]);
      expect(await supervisor.launch(input, TEST_WORKER_ENDPOINT)).toEqual(completed);
      await expect(
        supervisor.launch(
          {
            ...input,
            descriptor: testWorkerDescriptor(workspaceDir, "different-plan", input.launchId),
          },
          TEST_WORKER_ENDPOINT,
        ),
      ).rejects.toThrow("replayed with a different plan");

      const row = openOpenClawStateDatabase({ env })
        .db.prepare("SELECT * FROM node_worker_launches WHERE launch_id = ?")
        .get(input.launchId);
      expect(JSON.stringify(row)).not.toContain(TEST_WORKER_CREDENTIAL);
    } finally {
      captureAdapter.mockRestore();
      await supervisor.close();
    }
  });

  it("admits two durable launches and releases one physical slot at a time", async () => {
    const capacitySnapshots: Array<{ total: number; available: number }> = [];
    const { env, supervisor, workspaceDir } = fixture({
      capacity: 2,
      capacityWaitMs: 5_000,
      onCapacityChanged: (capacity) => capacitySnapshots.push(capacity),
    });
    const first = launchInput(workspaceDir, "capacity-a", "wait");
    const second = launchInput(workspaceDir, "capacity-b", "wait");
    const third = launchInput(workspaceDir, "capacity-c", "wait");
    const fourth = launchInput(workspaceDir, "capacity-d", "wait");
    const journal = new NodeWorkerJournalWorker({ env });
    const store = new NodeWorkerLaunchStore(journal);
    let admissionsSettled: Promise<unknown> | undefined;

    try {
      await supervisor.launch(first, TEST_WORKER_ENDPOINT);
      await supervisor.launch(second, TEST_WORKER_ENDPOINT);
      await expect(supervisor.launch(first, TEST_WORKER_ENDPOINT)).resolves.toMatchObject({
        launchId: first.launchId,
        state: "running",
      });
      expect(capacitySnapshots).toEqual([
        { total: 2, available: 0 },
        { total: 2, available: 2 },
        { total: 2, available: 1 },
        { total: 2, available: 0 },
      ]);

      const thirdAdmission = supervisor.launch(third, TEST_WORKER_ENDPOINT);
      const fourthAdmission = supervisor.launch(fourth, TEST_WORKER_ENDPOINT);
      admissionsSettled = Promise.allSettled([thirdAdmission, fourthAdmission]);
      await vi.waitFor(async () => {
        expect(await store.get(third.launchId)).toBeUndefined();
        expect(await store.get(fourth.launchId)).toBeUndefined();
      });

      await supervisor.cancel(testNodeWorkerLaunchIdentity(first));
      // Turn cancellation can settle before physical cleanup releases the next slot.
      await Promise.race([thirdAdmission, fourthAdmission]);
      await vi.waitFor(async () => {
        const receipts = await Promise.all(
          [third, fourth].map((input) => store.get(input.launchId)),
        );
        expect(receipts.filter(Boolean)).toHaveLength(1);
      });
      const thirdAdmittedFirst = Boolean(await store.get(third.launchId));
      await expect(thirdAdmittedFirst ? thirdAdmission : fourthAdmission).resolves.toMatchObject({
        state: "running",
      });
      expect(
        await store.get(thirdAdmittedFirst ? fourth.launchId : third.launchId),
      ).toBeUndefined();

      await supervisor.cancel(testNodeWorkerLaunchIdentity(second));
      await expect(thirdAdmittedFirst ? fourthAdmission : thirdAdmission).resolves.toMatchObject({
        state: "running",
      });
      expect(capacitySnapshots).toEqual([
        { total: 2, available: 0 },
        { total: 2, available: 2 },
        { total: 2, available: 1 },
        { total: 2, available: 0 },
        { total: 2, available: 1 },
        { total: 2, available: 0 },
        { total: 2, available: 1 },
        { total: 2, available: 0 },
      ]);
    } finally {
      try {
        await supervisor.close();
      } finally {
        await admissionsSettled;
        await journal.drain();
      }
    }
  });

  it("times out saturated admission without creating a launch row", async () => {
    const { env, supervisor, workspaceDir } = fixture({ capacity: 1, capacityWaitMs: 25 });
    const running = launchInput(workspaceDir, "capacity-running", "wait");
    const rejected = launchInput(workspaceDir, "capacity-rejected", "wait");
    await supervisor.launch(running, TEST_WORKER_ENDPOINT);

    await expect(supervisor.launch(rejected, TEST_WORKER_ENDPOINT)).rejects.toMatchObject({
      name: "NodeWorkerCapacityExhaustedError",
      code: NODE_WORKER_CAPACITY_EXHAUSTED_ERROR_CODE,
      message: "node worker capacity remained full for 25 ms",
    });
    expect(
      await new NodeWorkerLaunchStore(new NodeWorkerJournalWorker({ env })).get(rejected.launchId),
    ).toBeUndefined();
    await supervisor.close();
  });

  it("abandons saturated admission when its invocation is cancelled", async () => {
    const { env, supervisor, workspaceDir } = fixture({ capacity: 1, capacityWaitMs: 5_000 });
    const running = launchInput(workspaceDir, "capacity-abort-running", "wait");
    const waiting = launchInput(workspaceDir, "capacity-abort-waiting", "wait");
    const controller = new AbortController();
    await supervisor.launch(running, TEST_WORKER_ENDPOINT);
    const admission = supervisor.launch(waiting, TEST_WORKER_ENDPOINT, controller.signal);
    const rejected = expect(admission).rejects.toThrow("invoke cancelled");

    controller.abort(new Error("invoke cancelled"));
    await rejected;
    expect(
      await new NodeWorkerLaunchStore(new NodeWorkerJournalWorker({ env })).get(waiting.launchId),
    ).toBeUndefined();
    await supervisor.close();
  });

  it("aborts saturated admission when the supervisor closes", async () => {
    const { env, supervisor, workspaceDir } = fixture({ capacity: 1, capacityWaitMs: 5_000 });
    const running = launchInput(workspaceDir, "capacity-close-running", "wait");
    const waiting = launchInput(workspaceDir, "capacity-close-waiting", "wait");
    await supervisor.launch(running, TEST_WORKER_ENDPOINT);
    const admission = supervisor.launch(waiting, TEST_WORKER_ENDPOINT);
    const rejected = expect(admission).rejects.toThrow("node worker supervisor is closed");
    await vi.waitFor(async () => {
      expect(
        await new NodeWorkerLaunchStore(new NodeWorkerJournalWorker({ env })).get(waiting.launchId),
      ).toBeUndefined();
    });

    await supervisor.close();
    await rejected;
    expect(
      await new NodeWorkerLaunchStore(new NodeWorkerJournalWorker({ env })).get(waiting.launchId),
    ).toBeUndefined();
  });

  it.each(["status", "launch", "cancel", "close"] as const)(
    "retains an observed terminal outcome when %s reconciliation keeps failing",
    async (operation) => {
      const capacitySnapshots: Array<{ total: number; available: number }> = [];
      const { env, supervisor, workspaceDir } = fixture({
        capacity: 1,
        onCapacityChanged: (capacity) => capacitySnapshots.push(capacity),
      });
      const input = launchInput(workspaceDir, `finish-failure-${operation}`);
      const store = (supervisor as unknown as { store: NodeWorkerLaunchStore }).store;
      const originalFinish = store.finish.bind(store);
      let persistenceUnavailable = true;
      const finish = vi.spyOn(store, "finish").mockImplementation(async (params) => {
        if (persistenceUnavailable) {
          throw new Error("injected finish failure");
        }
        return originalFinish(params);
      });
      const invoke = async () => {
        switch (operation) {
          case "status":
            return await supervisor.status(input.launchId);
          case "launch":
            return await supervisor.launch(input, TEST_WORKER_ENDPOINT);
          case "cancel":
            return await supervisor.cancel(testNodeWorkerLaunchIdentity(input));
          case "close":
            await supervisor.close();
            return await new NodeWorkerLaunchStore(new NodeWorkerJournalWorker({ env })).get(
              input.launchId,
            );
          default:
            throw new Error("unsupported reconciliation operation");
        }
      };

      expect(await supervisor.launch(input, TEST_WORKER_ENDPOINT)).toMatchObject({
        state: "running",
      });
      await vi.waitFor(() => expect(finish).toHaveBeenCalled(), { timeout: 5_000 });
      expect(
        (await new NodeWorkerLaunchStore(new NodeWorkerJournalWorker({ env })).get(input.launchId))
          ?.state,
      ).toBe("running");
      expect(capacitySnapshots.at(-1)).toEqual({ total: 1, available: 0 });

      await expect(invoke()).rejects.toThrow("injected finish failure");
      expect(
        (await new NodeWorkerLaunchStore(new NodeWorkerJournalWorker({ env })).get(input.launchId))
          ?.state,
      ).toBe("running");
      expect(capacitySnapshots.at(-1)).toEqual({ total: 1, available: 0 });

      persistenceUnavailable = false;
      const completed = await invoke();
      expect(completed).toMatchObject({
        state: "completed",
        resultJson: expect.stringContaining('"status":"completed"'),
      });
      expect(
        (await new NodeWorkerLaunchStore(new NodeWorkerJournalWorker({ env })).get(input.launchId))
          ?.state,
      ).toBe("completed");
      expect(capacitySnapshots.at(-1)).toEqual({ total: 1, available: 1 });
      await supervisor.close();
    },
  );

  it("spawns workers with only supplied runtime essentials", async () => {
    const root = tempDirs.make("node-worker-env-");
    const { bundleRoot, env, workspaceDir } = writeNodeWorkerFixture(root);
    const suppliedPathKey = process.platform === "win32" ? "Path" : "PATH";
    const suppliedEnv: NodeJS.ProcessEnv = {
      ...env,
      [suppliedPathKey]: process.env.PATH,
      HOME: path.join(root, "worker-home"),
      LANG: "en_US.UTF-8",
      LC_TIME: "de_DE.UTF-8",
      DISPLAY: ":99",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/fixture/bus",
      XDG_RUNTIME_DIR: path.join(root, "desktop-runtime"),
      NODE_COMPILE_CACHE: path.join(root, "host-compile-cache"),
      NODE_DISABLE_COMPILE_CACHE: "1",
      NODE_EXTRA_CA_CERTS: path.join(root, "private-ca.pem"),
      NODE_USE_SYSTEM_CA: "1",
      OPENCLAW_ALLOW_INSECURE_PRIVATE_WS: "1",
      OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.node",
      OPENCLAW_SERVICE_KIND: "node",
      OPENCLAW_SUPPLIED_SECRET: "supplied-openclaw-secret",
      NODE_OPTIONS: "--title=forbidden-worker-title",
      BASH_ENV: path.join(root, "forbidden-shell-init"),
      DYLD_INSERT_LIBRARIES: path.join(root, "forbidden-runtime-injection"),
      HTTPS_PROXY: "http://supplied-proxy.invalid",
      SUPPLIED_SECRET: "supplied-secret",
    };

    await withEnvAsync(
      {
        AMBIENT_SECRET: "ambient-secret",
        OPENCLAW_AMBIENT_SECRET: "ambient-openclaw-secret",
        HTTP_PROXY: "http://ambient-proxy.invalid",
        NODE_OPTIONS: undefined,
      },
      async () => {
        const expectedWorkerEnv: NodeJS.ProcessEnv = {
          HOME: suppliedEnv.HOME,
          LANG: suppliedEnv.LANG,
          LC_TIME: suppliedEnv.LC_TIME,
          DISPLAY: suppliedEnv.DISPLAY,
          DBUS_SESSION_BUS_ADDRESS: suppliedEnv.DBUS_SESSION_BUS_ADDRESS,
          XDG_RUNTIME_DIR: suppliedEnv.XDG_RUNTIME_DIR,
          NODE_EXTRA_CA_CERTS: suppliedEnv.NODE_EXTRA_CA_CERTS,
          NODE_USE_SYSTEM_CA: suppliedEnv.NODE_USE_SYSTEM_CA,
          NODE_COMPILE_CACHE: expect.stringContaining("node-worker-compile-cache"),
          OPENCLAW_ALLOW_INSECURE_PRIVATE_WS: suppliedEnv.OPENCLAW_ALLOW_INSECURE_PRIVATE_WS,
          OPENCLAW_NO_RESPAWN: "1",
          [suppliedPathKey]: suppliedEnv[suppliedPathKey],
        };
        const supervisor = createNodeWorkerSupervisor({ bundleRoot, env: suppliedEnv });
        suppliedEnv.HOME = path.join(root, "mutated-home");
        suppliedEnv.LANG = "mutated-locale";
        const input = launchInput(workspaceDir, "env-launch", "env");
        await supervisor.launch(input, TEST_WORKER_ENDPOINT);
        await waitForTerminal(supervisor, input.launchId);
        const workerEnv = JSON.parse(
          fs.readFileSync(path.join(workspaceDir, `${input.launchId}.env.json`), "utf8"),
        ) as Record<string, string>;

        expect(workerEnv).toMatchObject(expectedWorkerEnv);
        expect(workerEnv).not.toHaveProperty("AMBIENT_SECRET");
        expect(workerEnv).not.toHaveProperty("OPENCLAW_AMBIENT_SECRET");
        expect(workerEnv).not.toHaveProperty("OPENCLAW_LAUNCHD_LABEL");
        expect(workerEnv).not.toHaveProperty("OPENCLAW_SERVICE_KIND");
        expect(workerEnv).not.toHaveProperty("OPENCLAW_STATE_DIR");
        expect(workerEnv).not.toHaveProperty("OPENCLAW_SUPPLIED_SECRET");
        expect(workerEnv).not.toHaveProperty("NODE_DISABLE_COMPILE_CACHE");
        expect(workerEnv).not.toHaveProperty("NODE_OPTIONS");
        expect(workerEnv).not.toHaveProperty("BASH_ENV");
        expect(workerEnv).not.toHaveProperty("DYLD_INSERT_LIBRARIES");
        expect(workerEnv).not.toHaveProperty("HTTP_PROXY");
        expect(workerEnv).not.toHaveProperty("HTTPS_PROXY");
        expect(workerEnv).not.toHaveProperty("SUPPLIED_SECRET");
        expect(JSON.stringify(workerEnv)).not.toContain(TEST_WORKER_CREDENTIAL);
        const platformInjectedKeys = new Set(
          process.platform === "darwin" ? ["__CF_USER_TEXT_ENCODING"] : [],
        );
        expect(
          Object.keys(workerEnv)
            .filter((key) => !platformInjectedKeys.has(key))
            .toSorted(),
        ).toEqual(
          Object.keys(expectedWorkerEnv)
            .filter((key) => expectedWorkerEnv[key] !== undefined)
            .toSorted(),
        );
        if (workerEnv["__CF_USER_TEXT_ENCODING"] !== undefined) {
          expect(process.platform).toBe("darwin");
          expect(workerEnv["__CF_USER_TEXT_ENCODING"]).toBeTypeOf("string");
        }
        await supervisor.close();
      },
    );
  });

  it("bounds output and scrubs launch credentials after registry eviction", async () => {
    const { supervisor, workspaceDir } = fixture();
    const successInput = launchInput(workspaceDir, "secret-success-launch", "secret-success");
    successInput.descriptor.assignment.github = {
      token: "worker-github-token",
      login: "worker-bot",
      branch: "session/worker-1",
    };
    const failureInput = launchInput(workspaceDir, "failure-launch", "secret-fail");
    const overflowInput = launchInput(workspaceDir, "overflow-launch", "overflow");

    const registrations = evictWorkerCredentialsOnRegistration();
    await supervisor.launch(successInput, TEST_WORKER_ENDPOINT);
    await supervisor.launch(failureInput, TEST_WORKER_ENDPOINT);
    await supervisor.launch(overflowInput, TEST_WORKER_ENDPOINT);
    expect(registrations).toHaveBeenCalledTimes(4);
    expect(registrations).toHaveBeenCalledWith(TEST_WORKER_CREDENTIAL);
    expect(registrations).toHaveBeenCalledWith(successInput.descriptor.assignment.github.token);
    const success = await waitForTerminal(supervisor, successInput.launchId);
    const failure = await waitForTerminal(supervisor, failureInput.launchId);
    const overflow = await waitForTerminal(supervisor, overflowInput.launchId);
    const representations = [
      TEST_WORKER_CREDENTIAL,
      encodeURIComponent(TEST_WORKER_CREDENTIAL),
      JSON.stringify(TEST_WORKER_CREDENTIAL).slice(1, -1),
      successInput.descriptor.assignment.github.token,
    ];
    expect(success.state).toBe("completed");
    expect(JSON.parse(success.resultJson ?? "null")).toEqual({
      status: "completed",
      transcriptLeafId: "raw [REDACTED] encoded [REDACTED] github [REDACTED]",
      transcriptNextSeq: 2,
    });
    expect(failure.state).toBe("failed");
    expect(Buffer.byteLength(failure.errorText ?? "", "utf8")).toBeLessThanOrEqual(4 * 1024);
    for (const representation of representations) {
      expect(success.resultJson).not.toContain(representation);
      expect(failure.errorText).not.toContain(representation);
    }
    expect(overflow).toMatchObject({
      state: "failed",
      errorText: expect.stringContaining("stdout exceeded 65536 bytes"),
    });
    await supervisor.close();
  });

  it.each([
    ["raw", "secret-cutoff-raw", TEST_WORKER_CREDENTIAL],
    ["URL", "secret-cutoff-url", encodeURIComponent(TEST_WORKER_CREDENTIAL)],
    ["JSON-escaped", "secret-cutoff-json", JSON.stringify(TEST_WORKER_CREDENTIAL).slice(1, -1)],
  ])(
    "redacts a %s credential representation across the stderr cutoff",
    async (_, prompt, representation) => {
      const { supervisor, workspaceDir } = fixture();
      const input = launchInput(workspaceDir, `cutoff-${prompt}`, prompt);

      await supervisor.launch(input, TEST_WORKER_ENDPOINT);
      const failure = await waitForTerminal(supervisor, input.launchId);

      expect(failure.state).toBe("failed");
      expect(Buffer.byteLength(failure.errorText ?? "", "utf8")).toBeLessThanOrEqual(4 * 1024);
      expect(failure.errorText).not.toContain(representation);
      expect(failure.errorText).not.toContain(representation.slice(-8));
      await supervisor.close();
    },
  );

  it("rotates credential scrubbing and drops prior-turn diagnostics when a worker is reused", async () => {
    const { supervisor, workspaceDir } = fixture({ capacity: 1 });
    const first = testWorkerLaunchInput(workspaceDir, "previous-diagnostic", "diagnostic-retain");
    const second = testWorkerLaunchInput(workspaceDir, "rotated-credential", "secret-success");
    second.descriptor.admission.credential = 'fresh worker/"credential\\secret?';
    second.descriptor.assignment.github = {
      token: "rotated-worker-github-token",
      login: "worker-bot",
      branch: "session/worker-1",
    };
    const last = testWorkerLaunchInput(workspaceDir, "fresh-failure", "quiet-fail");
    last.descriptor.admission.credential = "final-worker-credential";
    try {
      const original = await supervisor.launch(first, TEST_WORKER_ENDPOINT);
      await waitForTerminal(supervisor, first.launchId);
      const registrations = evictWorkerCredentialsOnRegistration();
      expect(await supervisor.launch(second, TEST_WORKER_ENDPOINT)).toMatchObject({
        worker: original.worker,
      });
      expect(registrations).toHaveBeenCalledWith(second.descriptor.admission.credential);
      expect(registrations).toHaveBeenCalledWith(second.descriptor.assignment.github.token);
      const completed = await waitForTerminal(supervisor, second.launchId);
      expect(JSON.parse(completed.resultJson ?? "null")).toEqual({
        status: "completed",
        transcriptLeafId: "raw [REDACTED] encoded [REDACTED] github [REDACTED]",
        transcriptNextSeq: 2,
      });

      registrations.mockRestore();
      await supervisor.launch(last, TEST_WORKER_ENDPOINT);
      const failed = await waitForTerminal(supervisor, last.launchId);
      expect(failed).toMatchObject({
        state: "failed",
        errorText: "node worker failed with exit code 7",
      });
      for (const input of [first, second, last]) {
        expect(JSON.stringify(failed)).not.toContain(input.descriptor.admission.credential);
      }
    } finally {
      await supervisor.close();
    }
  });

  it("bounds a blocked cancellation write and stops only its physical owner", async () => {
    const capacities: Array<{ total: number; available: number }> = [];
    const { env, supervisor, workspaceDir } = fixture({
      capacity: 2,
      capacityWaitMs: 25,
      onCapacityChanged: (capacity) => capacities.push(capacity),
    });
    const input = launchInput(workspaceDir, "blocked-cancel", "wait");
    const sibling = launchInput(workspaceDir, "unrelated-worker", "wait");
    const adapters = new Map<number, workerLaunchTransport.NodeWorkerChildAdapter>();
    const captureAdapter = observeNodeWorkerAdapters((adapter) => {
      if (adapter.pid !== undefined) {
        adapters.set(adapter.pid, adapter);
      }
    });
    let heldWrite: { data: unknown; callback?: (error?: Error | null) => void } | undefined;
    let restoreWrite: (() => void) | undefined;
    let cancellation: ReturnType<NodeWorkerSupervisor["cancel"]> | undefined;
    let cancelled: Awaited<ReturnType<NodeWorkerSupervisor["cancel"]>>;
    try {
      const running = await supervisor.launch(input, TEST_WORKER_ENDPOINT);
      const unrelated = await supervisor.launch(sibling, TEST_WORKER_ENDPOINT);
      captureAdapter.mockRestore();
      const adapter = adapters.get(running.worker!.pid);
      const siblingAdapter = adapters.get(unrelated.worker!.pid);
      if (!adapter?.stdin || !siblingAdapter) {
        throw new Error("missing physical worker stdin or adapter");
      }
      const stdin = adapter.stdin;
      const signalOwner = vi.spyOn(adapter, "kill");
      const signalSibling = vi.spyOn(siblingAdapter, "kill");
      // Model a pipe that cannot drain: neither frame delivery nor write completion occurs.
      const writeEntered = createDeferred();
      const write = vi.spyOn(stdin, "write").mockImplementation((data, callback) => {
        heldWrite = { data, callback };
        writeEntered.resolve();
      });
      restoreWrite = () => write.mockRestore();
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      cancellation = supervisor.cancel(testNodeWorkerLaunchIdentity(input)).then((receipt) => {
        cancelled = receipt;
        return receipt;
      });
      await writeEntered.promise;
      expect(heldWrite?.data).toBe(
        `${JSON.stringify({ type: "cancel", turnId: input.launchId })}\n`,
      );
      expect(heldWrite?.callback).toEqual(expect.any(Function));

      await vi.advanceTimersByTimeAsync(4_999);
      expect(signalOwner).not.toHaveBeenCalled();
      expect(signalSibling).not.toHaveBeenCalled();
      expect(cancelled).toBeUndefined();
      expect(
        (await new NodeWorkerLaunchStore(new NodeWorkerJournalWorker({ env })).get(input.launchId))
          ?.state,
      ).toBe("running");
      expect(inspectNodeWorkerProcessIdentity(running.worker!)).toBe("live");
      expect(inspectNodeWorkerProcessIdentity(unrelated.worker!)).toBe("live");
      expect(capacities.at(-1)).toEqual({ total: 2, available: 0 });

      // Fire only the blocked-write deadline. Restore real timers before its
      // rejection continuation schedules process termination and escalation.
      vi.advanceTimersByTime(1);
      vi.useRealTimers();
      await vi.waitFor(
        () => {
          expect(cancelled).toMatchObject({ state: "cancelled", worker: running.worker });
          expect(inspectNodeWorkerProcessIdentity(running.worker!)).not.toBe("live");
          expect(capacities.at(-1)).toEqual({ total: 2, available: 1 });
        },
        { timeout: 7_000, interval: 25 },
      );
      expect(
        (await new NodeWorkerLaunchStore(new NodeWorkerJournalWorker({ env })).get(input.launchId))
          ?.state,
      ).toBe("cancelled");
      expect(signalOwner).toHaveBeenCalledWith("SIGTERM");
      expect(signalSibling).not.toHaveBeenCalled();
      expect(await supervisor.status(sibling.launchId)).toMatchObject({ state: "running" });
      expect(inspectNodeWorkerProcessIdentity(unrelated.worker!)).toBe("live");
      await expect(
        supervisor.launch(
          launchInput(workspaceDir, "after-blocked-cancel", "wait"),
          TEST_WORKER_ENDPOINT,
        ),
      ).resolves.toMatchObject({ state: "running" });
    } finally {
      vi.useRealTimers();
      captureAdapter.mockRestore();
      restoreWrite?.();
      // Release the injected write even on the pre-fix failure, so cleanup cannot inherit its hang.
      heldWrite?.callback?.(new Error("released blocked test stdin"));
      await cancellation?.catch(() => undefined);
      await supervisor.close();
    }
  }, 15_000);

  it.each([
    [
      "connection-failure",
      "cancelled",
      "worker could not reach gateway gateway.example:18789: certificate rejected ",
    ],
    [
      "connection-deadline",
      "failed",
      "worker admission deadline exceeded after 3 attempts to gateway.example:18789: connect failed: Opening handshake has timed out ",
    ],
  ] as const)(
    "records the child's %s diagnosis in the terminal journal",
    async (prompt, state, errorText) => {
      const { supervisor, workspaceDir } = fixture();
      const input = launchInput(workspaceDir, "connection-failure-launch", prompt);
      await supervisor.launch(input, {
        kind: "websocket",
        url: "wss://gateway.example:18789/__openclaw__/worker",
      });
      if (state === "cancelled") {
        await vi.waitFor(() =>
          expect(fs.existsSync(path.join(workspaceDir, "connection-failure-reported"))).toBe(true),
        );
        await supervisor.cancel(testNodeWorkerLaunchIdentity(input));
      }
      const terminal = await waitForTerminal(supervisor, input.launchId);
      expect(terminal).toMatchObject({ state, errorText: expect.stringContaining(errorText) });
      expect(Buffer.byteLength(terminal.errorText ?? "", "utf8")).toBeLessThanOrEqual(4 * 1024);
      expect(terminal.errorText).not.toContain(TEST_WORKER_CREDENTIAL);
      await supervisor.close();
    },
  );

  it("does not return stale running after the active worker disappears", async () => {
    const { supervisor, workspaceDir } = fixture();
    const input = launchInput(workspaceDir, "silent-worker-death", "wait");
    const running = await supervisor.launch(input, TEST_WORKER_ENDPOINT);
    expect(running.worker).not.toBeNull();

    process.kill(running.worker!.pid, "SIGKILL");
    await vi.waitFor(async () => {
      expect((await supervisor.status(input.launchId))?.state).not.toBe("running");
    });
    await supervisor.close();
  });

  it("never signals a running worker for a mismatched immutable cancel identity", async () => {
    const { supervisor, workspaceDir } = fixture();
    const input = launchInput(workspaceDir, "identity-cancel-launch", "wait");
    const running = await supervisor.launch(input, TEST_WORKER_ENDPOINT);
    const expected = testNodeWorkerLaunchIdentity(input);
    const mismatches = [
      { ...expected, launchId: "launch-other" },
      { ...expected, planHash: "b".repeat(64) },
      { ...expected, environmentId: "environment-other" },
      { ...expected, sessionId: "session-other" },
      { ...expected, ownerEpoch: expected.ownerEpoch + 1 },
      { ...expected, placementGeneration: expected.placementGeneration + 1 },
      { ...expected, runId: "run-other" },
    ];

    for (const mismatch of mismatches) {
      await expect(supervisor.cancel(mismatch)).resolves.toBeUndefined();
      expect(inspectNodeWorkerProcessIdentity(running.worker!)).toBe("live");
      expect((await supervisor.status(input.launchId))?.state).toBe("running");
    }

    await expect(supervisor.cancel(expected)).resolves.toMatchObject({ state: "cancelled" });
    await supervisor.close();
  });

  it.each([
    ["cancel", "cancelled"],
    ["close", "interrupted"],
  ] as const)("%s terminates the worker-owned grandchild", async (operation, state) => {
    const { supervisor, workspaceDir } = fixture();
    const input = launchInput(workspaceDir, `${operation}-tree-launch`, "tree");
    let adapter: workerLaunchTransport.NodeWorkerChildAdapter | undefined;
    const captureAdapter = observeNodeWorkerAdapters((child) => {
      adapter = child;
    });
    try {
      const running = await supervisor.launch(input, TEST_WORKER_ENDPOINT);
      captureAdapter.mockRestore();
      if (!adapter) {
        throw new Error("missing worker adapter");
      }
      expect(running.state).toBe("running");
      const grandchildPath = path.join(workspaceDir, "grandchild.pid");
      await vi.waitFor(() =>
        expect(fs.readFileSync(grandchildPath, "utf8")).toMatch(/^[1-9]\d*$/u),
      );
      const grandchildPid = Number(fs.readFileSync(grandchildPath, "utf8"));
      const grandchild = requireNodeWorkerProcessIdentity(grandchildPid);
      expect(inspectNodeWorkerProcessIdentity(grandchild)).toBe("live");

      if (operation === "cancel") {
        await supervisor.cancel(testNodeWorkerLaunchIdentity(input));
      } else {
        await supervisor.close();
      }
      await (adapter.waitForExtinction?.() ?? adapter.wait());

      const terminal = await supervisor.status(input.launchId);
      expect(terminal).toMatchObject({ state, worker: running.worker });
      await vi.waitFor(() => {
        expect(inspectNodeWorkerProcessIdentity(running.worker!)).not.toBe("live");
        expect(inspectNodeWorkerProcessIdentity(grandchild)).not.toBe("live");
      });
    } finally {
      captureAdapter.mockRestore();
      await supervisor.close();
    }
  });

  it.each([false, true])(
    "preserves accepted turn cancellation after a rejected terminal event (journal retry: %s)",
    async (retryJournal) => {
      const capacities: Array<{ total: number; available: number }> = [];
      const { supervisor, workspaceDir, env } = fixture({
        capacity: 1,
        onCapacityChanged: (capacity) => capacities.push(capacity),
      });
      const input = launchInput(workspaceDir, "cancel-rejected-terminal", "tree-cancel-reject");
      const retryStarted = createDeferred();
      const releaseRetry = createDeferred();
      let cancellation: ReturnType<NodeWorkerSupervisor["cancel"]> | undefined;
      try {
        const running = await supervisor.launch(input, TEST_WORKER_ENDPOINT);
        const grandchildPath = path.join(workspaceDir, "grandchild.pid");
        await vi.waitFor(() =>
          expect(fs.readFileSync(grandchildPath, "utf8")).toMatch(/^[1-9]\d*$/u),
        );
        const grandchild = requireNodeWorkerProcessIdentity(
          Number(fs.readFileSync(grandchildPath, "utf8")),
        );

        if (retryJournal) {
          const finish = vi.spyOn(NodeWorkerTurnStore.prototype, "finish");
          finish
            .mockImplementationOnce(async () => {
              throw new Error("injected cancellation journal failure");
            })
            .mockImplementation(async function (this: NodeWorkerTurnStore, params) {
              retryStarted.resolve();
              await releaseRetry.promise;
              finish.mockRestore();
              return this.finish(params);
            });
        }
        cancellation = supervisor.cancel(testNodeWorkerLaunchIdentity(input));
        if (retryJournal) {
          await retryStarted.promise;
          const receiptJournal = new NodeWorkerJournalWorker({ env });
          try {
            expect(await new NodeWorkerTurnStore(receiptJournal).get(input.launchId)).toMatchObject(
              {
                state: "running",
              },
            );
          } finally {
            await receiptJournal.drain();
          }
          expect(capacities.at(-1)).toEqual({ total: 1, available: 0 });
          releaseRetry.resolve();
        }
        expect(await cancellation).toMatchObject({ state: "cancelled", worker: running.worker });
        expect(await supervisor.status(input.launchId)).toMatchObject({
          state: "cancelled",
          worker: running.worker,
        });
        expect(
          await new NodeWorkerLaunchStore(new NodeWorkerJournalWorker({ env })).get(input.launchId),
        ).toMatchObject({
          state: "failed",
          errorText:
            "node worker failed with exit code 1: worker live event rejected: invalid-event",
        });
        expect(inspectNodeWorkerProcessIdentity(running.worker!)).not.toBe("live");
        expect(inspectNodeWorkerProcessIdentity(grandchild)).not.toBe("live");
        expect(capacities.at(-1)).toEqual({ total: 1, available: 1 });

        const next = launchInput(workspaceDir, "after-cancel-rejected-terminal");
        await supervisor.launch(next, TEST_WORKER_ENDPOINT);
        expect(await waitForTerminal(supervisor, next.launchId)).toMatchObject({
          state: "completed",
        });
      } finally {
        releaseRetry.resolve();
        try {
          await cancellation;
        } finally {
          await supervisor.close();
        }
      }
    },
  );

  it("fails closed when the bundle entry resolves outside its namespaced bundle", async () => {
    const { bundleRoot, root, supervisor, workspaceDir } = fixture();
    const escapedHash = "b".repeat(64);
    const escapedBundle = path.join(bundleRoot, "gateway-1", "bundles", escapedHash);
    const outsideEntry = path.join(root, "outside.mjs");
    fs.mkdirSync(escapedBundle, { recursive: true });
    fs.writeFileSync(outsideEntry, TEST_WORKER_SOURCE);
    fs.symlinkSync(outsideEntry, path.join(escapedBundle, "worker.mjs"));
    const input = launchInput(workspaceDir, "escaped-entry");
    input.expectedBundleHash = escapedHash;
    input.descriptor.admission.handshake.bundleHash = escapedHash;

    expect(await supervisor.launch(input, TEST_WORKER_ENDPOINT)).toMatchObject({
      state: "failed",
      errorText: expect.stringContaining("inside its bundle"),
    });
    await supervisor.close();
  });
});
