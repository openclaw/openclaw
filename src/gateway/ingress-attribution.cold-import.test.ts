import { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import { expect, it, vi } from "vitest";

const tailscale = vi.hoisted(() => ({
  initialized: false,
  lookup: vi.fn<(ip: string) => Promise<{ login: string; name: string }>>(),
}));

// mock-isolation: Observe lazy initialization without loading subprocess launchers or host Tailscale.
vi.mock("../infra/tailscale.js", () => {
  tailscale.initialized = true;
  return { readTailscaleWhoisIdentity: tailscale.lookup };
});

it("loads the default Tailnet lookup only when Serve identity verification needs it", async () => {
  const { markGatewayIngressTransport, prepareGatewayIngressAttribution } =
    await import("./ingress-attribution.js");
  expect(tailscale.initialized).toBe(false);

  const identity = { login: "alice@example.test", name: "Alice" };
  tailscale.lookup.mockResolvedValue(identity);
  const prepare = (
    login?: string,
    tailscaleWhois?: Parameters<typeof prepareGatewayIngressAttribution>[0]["tailscaleWhois"],
  ) => {
    const req = new IncomingMessage(new Socket());
    Object.defineProperty(req.socket, "remoteAddress", { value: "127.0.0.1" });
    req.headers = {
      "x-forwarded-for": "100.64.0.10",
      "x-forwarded-proto": "https",
      "x-forwarded-host": "gateway.example.test",
      ...(login ? { "tailscale-user-login": login } : {}),
    };
    markGatewayIngressTransport(req, { kind: "managed-tailscale", mode: "serve" });
    const attribution = prepareGatewayIngressAttribution({ req, tailscaleWhois });
    if (attribution.kind !== "tailscale-serve") {
      throw new Error("expected managed Serve attribution");
    }
    return attribution;
  };

  await expect(prepare().verifyIdentity()).resolves.toBeUndefined();
  await expect(prepare(identity.login, async () => identity).verifyIdentity()).resolves.toEqual(
    identity,
  );
  expect(tailscale.initialized).toBe(false);

  const attribution = prepare(identity.login);
  const verification = attribution.verifyIdentity();
  expect(attribution.verifyIdentity()).toBe(verification);
  await expect(verification).resolves.toEqual(identity);
  expect(tailscale.initialized).toBe(true);
  expect(tailscale.lookup).toHaveBeenCalledExactlyOnceWith("100.64.0.10");
});
