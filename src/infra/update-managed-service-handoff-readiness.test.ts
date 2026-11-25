import { once } from "node:events";
import { expect, it, vi } from "vitest";
import { withinTest } from "../../test/helpers/promise.js";
import { createDeferredCore } from "../shared/deferred.js";
import { resolveTestNodeExecPath } from "../test-utils/node-process.js";
import { useManagedServiceHandoffLifecycleFixture } from "./update-managed-service-handoff-fixture.test-support.js";
import * as worker from "./update-managed-service-handoff-worker.js";
import {
  cancelManagedServiceUpdateHandoff,
  startManagedServiceUpdateHandoff,
} from "./update-managed-service-handoff.js";

const { spawnMock, forceKillChildProcessTreeMock, tempDirs } =
  useManagedServiceHandoffLifecycleFixture(false, true);

it.for(["readiness", "exit"] as const)(
  "retains helper %s observed while its worker identity reply is pending",
  async (event, { signal }) => {
    const { spawn } =
      await vi.importActual<typeof import("node:child_process")>("node:child_process");
    const { forceKillChildProcessTree } = await vi.importActual<
      typeof import("../process/child-process-tree.js")
    >("../process/child-process-tree.js");
    forceKillChildProcessTreeMock.mockImplementation(forceKillChildProcessTree);
    const identityPending = createDeferredCore();
    const releaseIdentity = createDeferredCore();
    const prepare = worker.prepareManagedHandoffParentStore;
    const heldIdentity = vi
      .spyOn(worker, "prepareManagedHandoffParentStore")
      .mockImplementation(async (options) => {
        const store = await prepare(options);
        return {
          ...store,
          async processIdentity(...args) {
            const identity = await store.processIdentity(...args);
            if (args[0] !== process.pid) {
              identityPending.resolve();
              await releaseIdentity.promise;
            }
            return identity;
          },
        };
      });
    const spawned = createDeferredCore<ReturnType<typeof spawn>>();
    const ready = createDeferredCore();
    let closed: Promise<unknown> | undefined;
    spawnMock.mockImplementationOnce((...args: Parameters<typeof spawn>) => {
      const child =
        event === "readiness"
          ? spawn(...args)
          : spawn(
              resolveTestNodeExecPath(),
              ["-e", "process.stdin.once('data', () => process.exit(23))"],
              args[2],
            );
      closed = once(child, "close");
      let output = "";
      child.stdout?.on("data", (chunk: Buffer) => {
        output += chunk.toString();
        if (output.includes("OPENCLAW_UPDATE_HANDOFF_READY\n")) {
          ready.resolve();
        }
      });
      spawned.resolve(child);
      return child;
    });
    const root = tempDirs.make("handoff-early-response-");
    const start = startManagedServiceUpdateHandoff({
      root,
      restartDrainTimeoutMs: 300_000,
      recoveryTimeoutMs: 5_000,
      parentPid: process.pid,
      execPath: resolveTestNodeExecPath(),
      argv1: root + "/openclaw.mjs",
      env: { ...process.env, OPENCLAW_STATE_DIR: root },
      meta: {},
    }).then(
      (result) => ({ result }),
      (error: unknown) => ({ error }),
    );
    const child = await withinTest(spawned.promise, signal);
    try {
      await withinTest(identityPending.promise, signal);
      if (event === "readiness") {
        await withinTest(ready.promise, signal);
      } else {
        child.stdin?.write("exit\n");
        await withinTest(closed!, signal);
        expect(child.exitCode).toBe(23);
      }
      releaseIdentity.resolve();
      const outcome = await withinTest(start, signal);
      if (event === "exit") {
        expect(outcome).toMatchObject({
          error: expect.objectContaining({
            // The real pipe may close before ChildProcess emits its exit notification.
            message: expect.stringMatching(
              /exited before signaling readiness \(code=23|handoff control input closed/,
            ),
          }),
        });
      } else {
        expect(outcome).toMatchObject({ result: { status: "started" } });
        if ("result" in outcome && outcome.result.status === "started") {
          await expect(
            cancelManagedServiceUpdateHandoff({
              kind: "managed-update-handoff",
              ...outcome.result,
            }),
          ).resolves.toBe("restored-in-process");
        }
      }
    } finally {
      releaseIdentity.resolve();
      if (child.exitCode === null && child.signalCode === null) {
        forceKillChildProcessTree(child);
      }
      await closed;
      await start;
      heldIdentity.mockRestore();
    }
  },
);
