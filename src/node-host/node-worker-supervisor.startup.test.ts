import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  WORKER_EXECUTION_AUTHORITY_PROTOCOL_FEATURE,
  WORKER_LINEAGE_START_PROTOCOL_FEATURE,
} from "../../packages/gateway-protocol/src/schema/worker-admission.js";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resetSecretRedactionRegistryForTest } from "../logging/secret-redaction-registry.test-support.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import { NodeWorkerJournalWorker } from "./node-worker-journal-worker.js";
import { NodeWorkerLaunchStore } from "./node-worker-launch-store.js";
import type { NodeWorkerChildAdapter } from "./node-worker-launch-transport.js";
import {
  createNodeWorkerSupervisorFixture,
  observeNodeWorkerAdapters,
  waitForNodeWorkerTerminal as waitForTerminal,
} from "./node-worker-supervisor.fixture.test-support.js";
import type { createNodeWorkerSupervisor } from "./node-worker-supervisor.js";
import {
  TEST_WORKER_ENDPOINT,
  testNodeWorkerLaunchIdentity,
  testWorkerLaunchInput,
} from "./node-worker-supervisor.test-support.js";

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
  return createNodeWorkerSupervisorFixture(tempDirs.make("node-worker-startup-"), options);
}

function launchInput(workspaceDir: string, launchId: string, prompt = "success") {
  const input = testWorkerLaunchInput(workspaceDir, launchId, prompt);
  input.descriptor.admission.environmentId = `environment-${launchId}`;
  input.descriptor.admission.sessionId = `session-${launchId}`;
  return input;
}

describe("node worker startup", () => {
  it.runIf(process.platform === "linux" || process.platform === "darwin").each([
    { build: "current", lineage: true },
    { build: "released", lineage: false },
    { build: "execution-authority-only", lineage: false },
  ])(
    "preserves the $build worker's start envelope and process group",
    async ({ build, lineage }) => {
      const { bundleRoot, supervisor, workspaceDir } = fixture();
      const input = launchInput(workspaceDir, `start-contract-${build}`);
      input.descriptor.admission.handshake.openclawVersion = "2026.9.4";
      if (!lineage) {
        input.descriptor.admission.handshake.protocolFeatures =
          input.descriptor.admission.handshake.protocolFeatures.filter(
            (feature) =>
              feature !== WORKER_LINEAGE_START_PROTOCOL_FEATURE &&
              (build !== "released" || feature !== WORKER_EXECUTION_AUTHORITY_PROTOCOL_FEATURE),
          );
      }
      const reportPath = path.join(workspaceDir, "start-contract.json");
      fs.writeFileSync(
        path.join(
          bundleRoot,
          input.gatewayNamespace,
          "bundles",
          input.expectedBundleHash,
          "worker.mjs",
        ),
        `import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
const started = new Promise(resolve => process.once("message", message => {
  const keys = Object.keys(message).sort();
  const expected = ${JSON.stringify(lineage ? ["lineageFds", "type"] : ["type"])};
  if (message.type !== "openclaw-worker-start-v1" || JSON.stringify(keys) !== JSON.stringify(expected)) {
    process.stderr.write("unsupported start envelope");
    process.exit(24);
  }
  if (${lineage}) for (const fd of message.lineageFds) fs.fstatSync(fd);
  const group = spawnSync("ps", ["-p", String(process.pid), "-o", "pgid="], { encoding: "utf8" });
  if (group.status !== 0) process.exit(25);
  fs.writeFileSync(${JSON.stringify(reportPath)}, JSON.stringify({ pid: process.pid, pgid: Number(group.stdout.trim()), keys }));
  resolve();
}));
await started;
const lines = createInterface({ input: process.stdin });
lines.once("line", line => {
  const turn = JSON.parse(line);
  fs.writeSync(1, JSON.stringify({ type: "result", turnId: turn.turnId, retainWorker: false,
    result: { status: "completed", transcriptLeafId: "leaf-1", transcriptNextSeq: 2 } }) + "\\n");
  process.exit(0);
});`,
      );
      let adapterPid: number | undefined;
      const captureAdapter = observeNodeWorkerAdapters((adapter) => {
        adapterPid = adapter.pid;
      });
      try {
        await supervisor.launch(input, TEST_WORKER_ENDPOINT);
        expect(await waitForTerminal(supervisor, input.launchId)).toMatchObject({
          state: "completed",
        });
        const report = JSON.parse(fs.readFileSync(reportPath, "utf8")) as {
          pid: number;
          pgid: number;
          keys: string[];
        };
        expect(report.keys).toEqual(lineage ? ["lineageFds", "type"] : ["type"]);
        expect(report.pgid).toBe(adapterPid);
        if (lineage) {
          expect(report.pid).not.toBe(adapterPid);
        } else {
          expect(report.pid).toBe(adapterPid);
        }
      } finally {
        captureAdapter.mockRestore();
        await supervisor.close();
      }
    },
  );

  it("does not open or signal a child after markRunning observes its terminal receipt", async () => {
    const capacities: Array<{ total: number; available: number }> = [];
    const { supervisor, workspaceDir, env } = fixture({
      capacity: 1,
      onCapacityChanged: (capacity) => capacities.push(capacity),
    });
    const input = launchInput(workspaceDir, "fast-terminal-launch", "fast-terminal");
    const opened = vi.fn();
    const signalled = vi.fn();
    let childExit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    let cleanupSettled = false;
    let adapter: NodeWorkerChildAdapter | undefined;
    const captureAdapter = observeNodeWorkerAdapters((child) => {
      adapter = child;
      child.onExit((code, signal) => {
        childExit = { code, signal };
      });
      const cleanup = child.waitForExtinction?.() ?? child.wait().then(() => undefined);
      void cleanup.then(
        () => {
          cleanupSettled = true;
        },
        () => undefined,
      );
      const openStartGate = child.openStartGate!;
      vi.spyOn(child, "openStartGate").mockImplementation(() => {
        opened();
        return openStartGate();
      });
      const kill = child.kill;
      vi.spyOn(child, "kill").mockImplementation((signal) => {
        signalled(signal);
        kill(signal);
      });
    });
    vi.spyOn(NodeWorkerLaunchStore.prototype, "markRunning").mockImplementation(
      async function (this: NodeWorkerLaunchStore, params) {
        expect(adapter?.pid).toBe(params.worker.pid);
        return await this.finish({
          launchId: params.launchId,
          planHash: params.planHash,
          supervisor: params.supervisor,
          worker: null,
          state: "completed",
          resultJson: '{"status":"completed"}',
        });
      },
    );

    try {
      expect(await supervisor.launch(input, TEST_WORKER_ENDPOINT)).toMatchObject({
        state: "completed",
      });
      // Capacity returns only after the real child exit and adapter settlement.
      await vi.waitFor(() => expect(capacities.at(-1)).toEqual({ total: 1, available: 1 }), {
        timeout: 5_000,
      });
      expect(childExit).toEqual({ code: 0, signal: null });
      expect(cleanupSettled).toBe(true);
      expect(adapter?.stdin?.destroyed).toBe(true);
      expect(opened).not.toHaveBeenCalled();
      expect(fs.existsSync(path.join(workspaceDir, "fast-terminal-marker"))).toBe(false);
      expect(
        (await new NodeWorkerLaunchStore(new NodeWorkerJournalWorker({ env })).get(input.launchId))
          ?.state,
      ).toBe("completed");
      await supervisor.close();
      expect(signalled).not.toHaveBeenCalled();
    } finally {
      captureAdapter.mockRestore();
      await supervisor.close();
    }
  });

  it.each([
    { operation: "none", state: "failed", errorText: "node worker failed with exit code 23" },
    { operation: "cancel", state: "cancelled", errorText: "node worker launch cancelled" },
    {
      operation: "close",
      state: "interrupted",
      errorText: "node worker launch interrupted during node-host shutdown",
    },
  ] as const)(
    "records $state when a child exits before descriptor delivery ($operation)",
    async ({ operation, state, errorText }) => {
      const { bundleRoot, supervisor, workspaceDir, env } = fixture();
      const input = launchInput(workspaceDir, "prestart-exit-launch");
      const exitedPath = path.join(workspaceDir, "prestart-exited");
      fs.writeFileSync(
        path.join(
          bundleRoot,
          input.gatewayNamespace,
          "bundles",
          input.expectedBundleHash,
          "worker.mjs",
        ),
        `import fs from "node:fs"; process.once("message", () => { fs.writeFileSync(${JSON.stringify(exitedPath)}, "exited"); process.exit(23); });`,
      );
      const observationReleased = createDeferred();
      const controller = new AbortController();
      let closing: Promise<void> | undefined;
      let childExit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
      const captureAdapter = observeNodeWorkerAdapters((adapter) => {
        // Let the supervisor subscribe before wait can claim stdout for discarding.
        const wait = adapter.wait;
        const openStartGate = adapter.openStartGate!;
        const kill = adapter.kill;
        // Reach the closed real pipe before its exit can settle the launch journal.
        vi.spyOn(adapter, "openStartGate").mockImplementation(async () => {
          await openStartGate();
          childExit = await wait();
          if (operation === "cancel") {
            controller.abort(new Error("cancel during startup"));
          } else if (operation === "close") {
            closing = supervisor.close();
          }
        });
        vi.spyOn(adapter, "wait").mockImplementation(async () => {
          const exit = await wait();
          await observationReleased.promise;
          return exit;
        });
        vi.spyOn(adapter, "kill").mockImplementation((signal) => {
          kill(signal);
          observationReleased.resolve();
        });
      });

      try {
        await supervisor.launch(input, TEST_WORKER_ENDPOINT, controller.signal);
        const terminal = await waitForTerminal(supervisor, input.launchId);

        expect(fs.existsSync(exitedPath)).toBe(true);
        expect(childExit).toEqual({ code: 23, signal: null });
        expect(terminal).toMatchObject({ state, errorText });
        expect(
          await new NodeWorkerLaunchStore(new NodeWorkerJournalWorker({ env })).get(input.launchId),
        ).toMatchObject({
          state,
          errorText,
        });
      } finally {
        captureAdapter.mockRestore();
        observationReleased.resolve();
        await closing;
        await supervisor.close();
      }
    },
  );

  it.each([
    ["cancel", "cancelled"],
    ["close", "interrupted"],
  ] as const)(
    "%s during startup closes the gate before worker code runs",
    async (operation, state) => {
      const { supervisor, workspaceDir } = fixture();
      const input = launchInput(workspaceDir, `${operation}-startup-launch`, "tree");
      const originalMarkRunning = Object.getOwnPropertyDescriptor(
        NodeWorkerLaunchStore.prototype,
        "markRunning",
      )?.value as NodeWorkerLaunchStore["markRunning"];
      let stopping: Promise<unknown> | undefined;
      vi.spyOn(NodeWorkerLaunchStore.prototype, "markRunning").mockImplementation(
        async function (this: NodeWorkerLaunchStore, params, authority) {
          const receipt = await originalMarkRunning.call(this, params, authority);
          stopping =
            operation === "cancel"
              ? supervisor.cancel(testNodeWorkerLaunchIdentity(input))
              : supervisor.close();
          return receipt;
        },
      );

      await supervisor.launch(input, TEST_WORKER_ENDPOINT);
      await stopping;

      expect((await supervisor.status(input.launchId))?.state).toBe(state);
      expect(fs.existsSync(path.join(workspaceDir, "grandchild.pid"))).toBe(false);
      await supervisor.close();
    },
  );
});
