import { expect, it, vi } from "vitest";
import { acquireTestPortBlock } from "../test-utils/port-claims.js";
import { installGatewayTestHooks, startTestGatewayServer, testState } from "./test-helpers.js";

installGatewayTestHooks();

it("transfers a reserved port block to the Gateway until its shutdown completes", async () => {
  const claim = await acquireTestPortBlock({ offsets: [0, 1, 2, 3, 4] });
  const release = vi.fn(claim.release);
  const competingClaim = () => acquireTestPortBlock({ port: claim.port, offsets: [0, 1, 2, 3, 4] });
  await expect(competingClaim()).rejects.toMatchObject({ code: "EADDRINUSE" });
  const server = await startTestGatewayServer({ ...claim, release });
  try {
    expect(process.env.OPENCLAW_GATEWAY_PORT).toBe(String(claim.port));
    const response = await fetch(`http://127.0.0.1:${claim.port}/healthz`);
    await response.body?.cancel();
    expect(response.status).toBe(200);
    await expect(competingClaim()).rejects.toMatchObject({ code: "EADDRINUSE" });
  } finally {
    await Promise.all([server.close(), server.close()]);
  }
  expect(release).toHaveBeenCalledOnce();
});

it("releases the transferred port block when startup rejects its auth configuration", async () => {
  const claim = await acquireTestPortBlock({ offsets: [0, 1, 2, 3, 4] });
  const release = vi.fn(claim.release);
  const auth = { mode: "token", token: "" } as const;
  testState.gatewayAuth = auth;
  await expect(startTestGatewayServer({ ...claim, release }, { auth })).rejects.toThrow(
    "gateway auth token is blank",
  );
  expect(release).toHaveBeenCalledOnce();
});
