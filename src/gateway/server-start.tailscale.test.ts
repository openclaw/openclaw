import type { HelloOk } from "@openclaw/gateway-protocol";
import { expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import { createGatewayStartupOperations } from "../cli/gateway-cli/run-loop-startup.js";
import { TailscaleServeDisabledError } from "../infra/tailscale-serve-disabled-error.js";
import * as tailscaleCommands from "../infra/tailscale.js";
import { acquireTestPortBlock } from "../test-utils/port-claims.js";
import { GatewayClient } from "./client.js";
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
  const finishing = fixture.createStartupGate();
  const stopped = createDeferred();
  const cleanup = vi.fn(async () => stopped.resolve());
  const wait = (gate: Promise<void>, work: Promise<unknown>, message: string) =>
    withinTest(awaitGateBeforeSettlement(gate, work, message), signal);
  vi.spyOn(tailscale, "startGatewayTailscaleExposure").mockResolvedValue(cleanup);
  vi.spyOn(startup, "finishGatewayStartup").mockImplementation(async (params) => {
    await params.kernelRuntime.startListening();
    await finishing.run();
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
    const result = starting.catch((error: unknown) => error);
    await wait(finishing.entered, result, "Startup settled before the post-exposure phase");
    operations.close();
    const draining = operations.drain();
    await wait(stopped.promise, draining, "Native stop left its Tailscale claim active");
    // The claimant is gone while startup is still blocked, before any close handle exists.
    expect(cleanup).toHaveBeenCalledOnce();
    finishing.release();
    expect(operations.cancelledWith(await result)).toBe(true);
    await draining;
  } finally {
    finishing.release();
    const server = await starting?.catch(() => undefined);
    await server?.close();
    vi.restoreAllMocks();
    await state.cleanup();
    await port.release();
  }
});

it("reports failed Serve activation in the authenticated Gateway snapshot", async ({ signal }) => {
  const state = await fixture.createGatewayStartupTestState("gateway-tailscale-exposure", {
    OPENCLAW_TEST_TAILSCALE_BINARY: process.execPath,
  });
  const port = await acquireTestPortBlock({ offsets: [0], signal });
  vi.spyOn(tailscaleCommands, "claimTailscaleRoute").mockRejectedValue(
    new TailscaleServeDisabledError(),
  );
  let server: Awaited<ReturnType<typeof startGatewayServerCore>> | undefined;
  let client: GatewayClient | undefined;
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
    server = await startGatewayServerCore(
      port.port,
      fixture.gatewayStartupTestOptions("fixture-token"),
    );
    const hello = new Promise<HelloOk>((resolve, reject) => {
      client = new GatewayClient({
        url: `ws://127.0.0.1:${port.port}`,
        token: "fixture-token",
        onHelloOk: resolve,
        onConnectError: reject,
      });
      client.start();
    });
    const snapshot = (await withinTest(hello, signal)).snapshot;
    expect(snapshot).toMatchObject({
      bindHost: "127.0.0.1",
      tailscaleMode: "off",
      tailscaleExposure: { requestedMode: "serve", activeMode: "off", status: "failed" },
    });
    expect(snapshot.tailscaleExposure?.reason).toContain("Serve is disabled");
  } finally {
    client?.stop();
    await server?.close();
    vi.restoreAllMocks();
    await state.cleanup();
    await port.release();
  }
});
