import { expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import { createGatewayStartupOperations } from "../cli/gateway-cli/run-loop-startup.js";
import { acquireTestPortBlock } from "../test-utils/port-claims.js";
import { startGatewayServerCore } from "./server-start.js";
import * as startup from "./server-startup-finish.js";
import * as fixture from "./server-startup-state.test-support.js";
import * as tailscale from "./server-tailscale.js";

it("stops a ready Tailscale claim while the Gateway is still preparing its close handle", async ({
  signal,
}) => {
  const state = await fixture.createGatewayStartupTestState("gateway-tailscale-startup-stop", {
    OPENCLAW_TEST_TAILSCALE_BINARY: process.execPath,
  });
  const port = await acquireTestPortBlock({ offsets: [0], signal });
  const operations = createGatewayStartupOperations();
  const finishing = createDeferred();
  const resume = createDeferred();
  const stopped = createDeferred();
  const cleanup = vi.fn(async () => {
    stopped.resolve();
  });
  const exposure = vi.spyOn(tailscale, "startGatewayTailscaleExposure").mockResolvedValue(cleanup);
  const finish = vi.spyOn(startup, "finishGatewayStartup").mockImplementation(async (params) => {
    await params.kernelRuntime.startListening();
    finishing.resolve();
    await resume.promise;
    return { startupSettled: Promise.resolve() };
  });
  let starting: ReturnType<typeof startGatewayServerCore> | undefined;
  try {
    await state.writeConfig({
      gateway: {
        ...fixture.gatewayStartupTestConfig(port.port, "fixture-token"),
        bind: "loopback",
        tailscale: { mode: "serve" },
      },
      plugins: { enabled: false },
      discovery: { mdns: { mode: "off" } },
    });
    state.applyEnv();
    starting = startGatewayServerCore(port.port, { startupOperation: operations.run });
    const result = starting.then(
      () => "started",
      (error: unknown) => error,
    );
    await withinTest(
      awaitGateBeforeSettlement(
        finishing.promise,
        result,
        "Gateway never reached the post-exposure phase",
      ),
      signal,
    );
    operations.close();
    const draining = operations.drain();
    await withinTest(
      awaitGateBeforeSettlement(
        stopped.promise,
        draining,
        "Native stop left its Tailscale claim active",
      ),
      signal,
    );
    // The claimant is gone while startup is still blocked, before any close handle exists.
    expect(cleanup).toHaveBeenCalledOnce();
    resume.resolve();
    const error = await result;
    expect(operations.cancelledWith(error)).toBe(true);
    await draining;
  } finally {
    resume.resolve();
    const server = await starting?.catch(() => undefined);
    await server?.close();
    exposure.mockRestore();
    finish.mockRestore();
    await state.cleanup();
    await port.release();
  }
});
