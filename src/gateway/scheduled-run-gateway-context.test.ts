import { AsyncLocalStorage } from "node:async_hooks";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it } from "vitest";
import {
  getGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../agents/tools/gateway-caller-context.js";
import { getSpawnBroker, runWithSpawnBroker } from "../process/spawn-broker/context.js";
import { useSpawnBrokerTestFixture } from "../process/spawn-broker/host.test-support.js";
import { spawnWithFallback } from "../process/spawn-utils.js";
import { createScheduledGatewayRunner } from "./scheduled-run-gateway-context.js";

describe.skipIf(process.platform === "win32" || Boolean(process.versions.bun))(
  "scheduled Gateway broker ownership",
  () => {
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
            spawnWithFallback({
              argv: [process.execPath, "-e", "process.exit(0)"],
              options: { stdio: "ignore" },
            }),
          ),
        ),
      ).rejects.toThrow("Spawn broker is unavailable");
    });
  },
);
