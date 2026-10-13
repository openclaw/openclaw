import { expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import { createGatewayStartupOperations } from "../cli/gateway-cli/run-loop-startup.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { acquireTestPortBlock } from "../test-utils/port-claims.js";
import { startGatewayServerCore } from "./server-start.js";
import * as startup from "./server-startup-finish.js";
import * as tailscale from "./server-tailscale.js";

it("stops a ready Tailscale claim while the Gateway is still preparing its close handle", async ({
  signal,
}) => {
  const state = await createOpenClawTestState({
    label: "gateway-tailscale-startup-stop",
    layout: "home",
    env: {
      OPENCLAW_GATEWAY_PASSWORD: undefined,
      OPENCLAW_GATEWAY_TOKEN: undefined,
      OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
      OPENCLAW_SKIP_CANVAS_HOST: "1",
      OPENCLAW_SKIP_CHANNELS: "1",
      OPENCLAW_SKIP_CRON: "1",
      OPENCLAW_SKIP_GMAIL_WATCHER: "1",
      OPENCLAW_SKIP_PROVIDERS: "1",
      OPENCLAW_TEST_MINIMAL_GATEWAY: "0",
      OPENCLAW_TEST_TAILSCALE_BINARY: process.execPath,
      VITEST: "1",
    },
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
        port: port.port,
        bind: "loopback",
        auth: { mode: "token", token: "fixture-token" },
        tailscale: { mode: "serve" },
        controlUi: { enabled: false },
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
