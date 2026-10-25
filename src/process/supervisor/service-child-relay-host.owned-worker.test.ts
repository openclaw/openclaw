import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { NodeWorkerJournalWorker } from "../../node-host/node-worker-journal-worker.js";
import { NodeWorkerLaunchStore } from "../../node-host/node-worker-launch-store.js";
import { requireNodeWorkerProcessIdentity } from "../../node-host/node-worker-process-identity.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { createServiceChildRelayAdapter } from "./service-child-relay-host.js";
import type { ProcessExtinctionResult } from "./types.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    cleanup();
  }),
);

it
  .runIf(process.platform === "linux" || process.platform === "darwin")
  .for(["close-before-open", "stdin-closed", "journal-write-failed"] as const)(
  "runs a real owned worker through its IPC start gate and output drain (%s)",
  { timeout: 20_000 },
  async (action, { signal }) => {
    const home = tempDirs.make("openclaw-owned-worker-gate-");
    const env = {
      HOME: home,
      PATH: process.env.PATH,
      OPENCLAW_STATE_DIR: path.join(home, "state"),
      OPENCLAW_CONFIG_PATH: path.join(home, "openclaw.json"),
    };
    const store = new NodeWorkerLaunchStore(new NodeWorkerJournalWorker({ env }));
    const supervisor = requireNodeWorkerProcessIdentity(process.pid);
    const claim = {
      launchId: "owned-worker",
      planHash: "a".repeat(64),
      gatewayNamespace: "test-gateway",
      environmentId: "test-environment",
      sessionId: "test-session",
      ownerEpoch: 1,
      placementGeneration: 1,
      runId: "test-run",
    };
    expect((await store.claim(claim, supervisor, 1)).action).toBe("start");
    const cleanupBinding = await store.cleanupBinding({ ...claim, supervisor });
    const marker = path.join(home, "started.txt");
    const waiting = createDeferred();
    let adapter: Awaited<ReturnType<typeof createServiceChildRelayAdapter>>["adapter"] | undefined;
    let cleanup: Promise<ProcessExtinctionResult> | undefined;
    const expectedOutput = "owned worker finished\n";
    const output: string[] = [];
    let stderr = "";
    try {
      const workerArgs = [
        "-e",
        `
            const fs = require("node:fs");
            process.on("message", () => {
              fs.appendFileSync(${JSON.stringify(marker)}, "started\\n");
              process.stdout.write(${JSON.stringify(expectedOutput)}, () => process.disconnect());
            });
            process.send("waiting");
          `,
      ];
      const startup = await createServiceChildRelayAdapter({
        command: action === "stdin-closed" ? "/bin/sh" : process.execPath,
        // Redirect the inherited pipe before Node initializes its standard stream handles.
        args:
          action === "stdin-closed"
            ? ["-c", 'exec "$@" < /dev/null', "owned-worker-stdin", process.execPath, ...workerArgs]
            : workerArgs,
        cwd: home,
        env,
        stdinMode: "pipe-open",
        oomScoreWrapperSelected: false,
        ownedWorker: true,
        nativeProcessOwnerSupported: true,
        cleanupBinding,
        onWorkerMessage: (message) => {
          if (message === "waiting") {
            waiting.resolve();
          }
        },
        onSpawnCleanup: (pending) => {
          cleanup = pending;
          void pending.catch(() => undefined);
        },
      });
      adapter = startup.adapter;
      await startup.ready;
      const collectOutput = output.push.bind(output);
      adapter.onStdout(collectOutput);
      adapter.onStderr((chunk) => {
        stderr = (stderr + chunk).slice(-8192);
      });
      const ownerPid = adapter.pid;
      await store.markRunning({
        ...claim,
        supervisor,
        worker: requireNodeWorkerProcessIdentity(ownerPid!),
        cleanupMode: adapter.treeOwnership ?? "owned-anchor",
      });
      if (action === "journal-write-failed") {
        openOpenClawStateDatabase({ env }).db.exec(`
          CREATE TRIGGER abort_lineage_settlement
          BEFORE UPDATE OF ${adapter.treeOwnership ? "descendants_reaped ON node_worker_launch_process_scopes" : "lineage_settled ON node_worker_launch_cleanup"}
          BEGIN SELECT RAISE(ABORT, 'synthetic journal write failure'); END;
        `);
      }
      await withinTest(waiting.promise, signal);
      expect(existsSync(marker)).toBe(false);

      if (action !== "close-before-open") {
        if (action === "stdin-closed") {
          await vi.waitFor(async () => {
            await new Promise<void>((resolve) => {
              adapter!.stdin!.write("probe", () => resolve());
            });
            expect(adapter!.stdin!.destroyed).toBe(true);
          });
          expect(stderr).toBe("");
        }
        await Promise.all([adapter.openStartGate!(), adapter.openStartGate!()]);
        await expect(adapter.wait()).resolves.toEqual({ code: 0, signal: null });
        expect(await readFile(marker, "utf8")).toBe("started\n");
        expect(output.join("")).toBe(expectedOutput);
      } else {
        adapter.closeStartGate!();
        await expect(adapter.openStartGate!()).rejects.toThrow("closed before startup");
        await adapter.waitForExtinction();
        expect(existsSync(marker)).toBe(false);
        expect(output.join("")).toBe("");
      }
      await adapter.waitForExtinction();
      expect(await store.get(claim.launchId)).toMatchObject({
        workerCleanupMode: adapter.treeOwnership ?? "owned-anchor",
        workerLineageSettled: !adapter.treeOwnership && action !== "journal-write-failed",
        ...(adapter.treeOwnership
          ? { workerDescendantsReaped: action !== "journal-write-failed" }
          : {}),
      });
      if (action === "journal-write-failed") {
        expect(stderr).toContain(
          adapter.treeOwnership
            ? "node worker descendant extinction was not recorded; restart recovery retains capacity\n"
            : "node worker lineage completion was not recorded; restart recovery will retain capacity until cleanup can be verified\n",
        );
      }
    } finally {
      adapter?.kill("SIGKILL");
      await adapter?.wait().catch(() => undefined);
      await cleanup?.catch((error: unknown) => {
        throw new Error(`owned worker cleanup failed: ${stderr}`, { cause: error });
      });
      adapter?.dispose();
    }
  },
);
