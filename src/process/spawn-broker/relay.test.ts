import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../../test/helpers/promise.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { runExec } from "../exec.js";
import { createChildAdapter } from "../supervisor/adapters/child.js";
import { createServiceChildRelayAdapter } from "../supervisor/service-child-relay-host.js";
import { runWithSpawnBroker } from "./context.js";
import { createSpawnBrokerHost } from "./host.js";
import { supportsSpawnBrokerCommandTransport } from "./pipe.js";

const skipBrokerTests = !supportsSpawnBrokerCommandTransport();

describe.skipIf(skipBrokerTests)("brokered process lifecycle owners", () => {
  let broker: ReturnType<typeof createSpawnBrokerHost>;
  beforeAll(async () => {
    broker = createSpawnBrokerHost();
    await broker.ready();
  });
  afterAll(async () => {
    await broker.close();
  });

  it("retains relay control and lineage through root exit and tree cancellation", async ({
    signal,
  }) => {
    await runWithSpawnBroker(broker, async () => {
      const { adapter, ready } = await createServiceChildRelayAdapter({
        command: process.execPath,
        args: [
          "-e",
          `
          const {spawn}=require('node:child_process');
          const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{
            stdio:['ignore','ignore','ignore',3],
          });
          process.stdout.write(String(process.ppid));
          child.unref();
        `,
        ],
        stdinMode: "pipe-closed",
        oomScoreWrapperSelected: false,
      });
      let output = "";
      adapter.onStdout((chunk) => {
        output += chunk;
      });
      adapter.onStderr(() => {});
      const extinction = adapter.waitForExtinction();
      let extinct = false;
      void extinction.then(
        () => {
          extinct = true;
        },
        () => {},
      );
      try {
        await ready;
        await expect(adapter.wait()).resolves.toEqual({ code: 0, signal: null });
        expect(extinct).toBe(false);
        const anchorPid = Number(output);
        expect(anchorPid).toBeGreaterThan(0);
        const parentOf = async (pid: number) =>
          Number(
            (await runExec("ps", ["-o", "ppid=", "-p", String(pid)], { logOutput: false })).stdout,
          );
        // Native custody is brokered directly; process-group custody adds a relay.
        const brokerChildPid =
          adapter.treeOwnership === "linux-subreaper" ? anchorPid : await parentOf(anchorPid);
        expect(await parentOf(brokerChildPid)).toBe(broker.pid);
        adapter.kill("SIGTERM");
        await withinTest(extinction, signal);
        expect(extinct).toBe(true);
      } finally {
        adapter.kill("SIGKILL");
        await extinction.catch(() => {});
        adapter.dispose();
      }
    });
  });

  it("forwards the ownedWorker start gate and disconnect through the broker", async ({
    signal,
  }) => {
    await runWithSpawnBroker(broker, async () => {
      const response = createDeferredCore<unknown>();
      const { adapter, ready } = await createChildAdapter({
        argv: [
          process.execPath,
          "-e",
          `
          process.once('message',()=>process.send({ppid:process.ppid}));
          process.once('disconnect',()=>process.exit(0));
        `,
        ],
        ownedWorker: true,
        exactEnv: true,
        stdinMode: "pipe-closed",
        onWorkerMessage: response.resolve,
      });
      adapter.onStdout(() => {});
      adapter.onStderr(() => {});
      try {
        await ready;
        await adapter.openStartGate?.();
        await expect(
          withinTest(
            awaitGateBeforeSettlement(
              response.promise,
              adapter.wait(),
              "worker settled before acknowledging its start gate",
            ),
            signal,
          ),
        ).resolves.toEqual({
          ppid: broker.pid,
        });
        adapter.closeStartGate?.();
        await expect(adapter.wait()).resolves.toEqual({ code: 0, signal: null });
      } finally {
        adapter.kill("SIGKILL");
        adapter.dispose();
      }
    });
  });
});
