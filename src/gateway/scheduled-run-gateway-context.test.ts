import { AsyncLocalStorage } from "node:async_hooks";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it } from "vitest";
import {
  captureAgentPluginRuntimeRefresh,
  createAgentPluginRuntimeRefresh,
} from "../agents/plugin-runtime-refresh.js";
import {
  getGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../agents/tools/gateway-caller-context.js";
import { getSpawnBroker, runWithSpawnBroker } from "../process/spawn-broker/context.js";
import { useSpawnBrokerTestFixture } from "../process/spawn-broker/host.test-support.js";
import { spawnAndWait } from "../process/spawn-utils.js";
import { createScheduledGatewayRunner } from "./scheduled-run-gateway-context.js";

describe("scheduled Gateway refresh ownership", () => {
  it("does not inherit a worker refresh owner after it closes", async () => {
    const refresh = createAgentPluginRuntimeRefresh();
    const runner = createScheduledGatewayRunner();
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });

    const scheduled = refresh.run(() =>
      runner(async () => {
        await waiting;
        expect(() => captureAgentPluginRuntimeRefresh().assertCurrent()).not.toThrow();
      }),
    );

    refresh.close();
    release();
    await scheduled;
  });
});

describe.skipIf(process.platform === "win32")("scheduled Gateway broker ownership", () => {
  const createBroker = useSpawnBrokerTestFixture(afterEach);
  it("restores only its transport and never borrows another Gateway's broker", async () => {
    const firstBroker = expectDefined(await createBroker(), "first broker");
    const secondBroker = expectDefined(await createBroker(), "second broker");
    const runFirst = runWithSpawnBroker(firstBroker, () => createScheduledGatewayRunner());
    const runWithoutBroker = createScheduledGatewayRunner();
    const callbackContext = new AsyncLocalStorage<string>();
    await callbackContext.run("callback", () =>
      runWithSpawnBroker(secondBroker, () =>
        withGatewayToolCallerIdentity({ agentId: "main", sessionKey: "request" }, async () => {
          await runFirst(async () => {
            await Promise.resolve();
            expect(getSpawnBroker()).toBe(firstBroker);
            expect(getGatewayToolCallerIdentity()).toBeUndefined();
            expect(callbackContext.getStore()).toBe("callback");
          });
          expect(getSpawnBroker()).toBe(secondBroker);
          expect(getGatewayToolCallerIdentity()?.sessionKey).toBe("request");
          await runWithoutBroker(async () => {
            expect(getSpawnBroker()).toBeUndefined();
          });
        }),
      ),
    );

    await firstBroker.close();
    await expect(
      runWithSpawnBroker(secondBroker, () =>
        runFirst(() =>
          spawnAndWait({
            argv: [process.execPath, "-e", "process.exit(0)"],
            options: { stdio: "ignore" },
          }),
        ),
      ),
    ).rejects.toThrow("Spawn broker is unavailable");
  });
});
