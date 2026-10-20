import { Agent } from "node:http";
import { createConnection } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import * as advertisedLanHost from "../../infra/advertised-lan-host.js";
import { claimTailscaleServePort, type TailscaleRouteClaim } from "../../infra/tailscale.js";
import { prepareTailscalePublishedOrigin } from "../tailscale-published-origin.js";
import { holdPortalBind, authority, requestText, usePortalHarness } from "./portal.test-support.js";

// Every managed route operation is fake: these tests must never change the host's tailnet.
vi.mock("../../infra/tailscale.js", () => ({ claimTailscaleServePort: vi.fn() }));

const { target, makeService } = usePortalHarness();
const withdraw: Array<() => void> = [];
afterEach(() => {
  for (const release of withdraw.splice(0)) {
    release();
  }
  vi.restoreAllMocks();
  vi.mocked(claimTailscaleServePort).mockReset();
});

function wildcardService(httpBindHosts = ["127.0.0.1"]) {
  return makeService({ httpBindHosts, ingress: { domain: "preview.test", port: 0 } });
}

function publishManaged(mode: "serve" | "funnel" = "serve") {
  const release = prepareTailscalePublishedOrigin({ origin: "https://gw.ts.net", mode });
  withdraw.push(release);
  return release;
}

function fakeClaim() {
  const exit = createDeferred();
  let active = true;
  const lose = () => {
    active = false;
    exit.resolve();
  };
  const claim: TailscaleRouteClaim = {
    exited: exit.promise,
    isActive: () => active,
    stop: vi.fn(async () => lose()),
  };
  return { claim, lose };
}

async function ingressRequest(port: number, url: string, host?: string) {
  const parsed = new URL(url);
  const destination = new URL(`http://${host ?? parsed.host}`);
  const agent = new Agent({ keepAlive: false });
  agent.createConnection = () => createConnection({ host: "127.0.0.1", port });
  const response = await requestText(new URL(`${parsed.pathname}${parsed.search}`, destination), {
    headers: { host: host ?? parsed.host },
    agent,
  });
  return {
    ...response,
    cookie: response.headers["set-cookie"] ?? [],
    location: response.headers.location,
  };
}

describe("private portal ingress", () => {
  it("publishes authoritative HTTPS paths on random per-lifetime hosts and gates every target", async () => {
    target.handler = (req, res) => {
      res.setHeader("Set-Cookie", ["session=ok; Path=/", "restricted=ok; SameSite=Strict"]);
      res.end(JSON.stringify({ path: req.url, proto: req.headers["x-forwarded-proto"] }));
    };
    const { service, httpServers } = wildcardService(["0.0.0.0"]);
    const resolveHost = vi.spyOn(advertisedLanHost, "resolveAdvertisedLanHostCore");
    const targetPort = target.port;
    const first = await service.open({ targetPort, path: "/a/b?x=1" });
    expect(first.publicUrl).toMatch(/^https:\/\/[a-f0-9]{32}\.preview\.test\/a\/b\?x=1$/u);
    expect(httpServers).toHaveLength(1);
    expect(httpServers[0]?.address()).toMatchObject({
      address: "127.0.0.1",
      port: first.listenPort,
    });
    expect(first.exposure).toEqual({ kind: "non-loopback", browserReachability: "unverified" });
    const response = await ingressRequest(first.listenPort, first.url);
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ path: "/a/b?x=1", proto: "https" });
    expect(response.cookie.join(";")).toContain("HttpOnly");
    expect(response.cookie.join(";")).toContain("Secure");
    const authCookie = response.cookie.find((cookie) => cookie.startsWith("openclaw_portal_"));
    expect(authCookie).toContain("SameSite=None; Partitioned");
    const appCookie = response.cookie.find((cookie) => cookie.includes("_session="));
    expect(appCookie).toContain("SameSite=None; Secure; Partitioned");
    const restrictedCookie = response.cookie.find((cookie) => cookie.includes("_restricted="));
    expect(restrictedCookie).toContain("SameSite=Strict");
    expect(restrictedCookie).not.toContain("SameSite=None");
    expect((await ingressRequest(first.listenPort, first.publicUrl)).status).toBe(401);
    for (const host of [
      "unknown.preview.test",
      "gateway.example.net",
      `${new URL(first.url).hostname}:8443`,
    ]) {
      expect((await ingressRequest(first.listenPort, first.url, host)).status).toBe(404);
    }
    const reused = await service.open({ targetPort, path: "/updated" });
    expect(reused.publicUrl).toBe(`${new URL(first.url).origin}/updated`);
    await service.close(first.id);
    expect((await ingressRequest(first.listenPort, first.url)).status).toBe(404);
    const reopened = await service.open({ targetPort });
    expect(new URL(reopened.url).hostname).not.toBe(new URL(first.url).hostname);
    expect((await ingressRequest(first.listenPort, first.url)).status).toBe(404);
    expect(claimTailscaleServePort).not.toHaveBeenCalled();
    expect(resolveHost).not.toHaveBeenCalled();
  });

  it.each(["http://localhost", "//127.0.0.1"])("rewrites %s redirects", async (prefix) => {
    const targetPort = target.port;
    target.handler = (_req, res) => {
      res.writeHead(302, { Location: `${prefix}:${targetPort}/next?q=1#section` }).end();
    };
    const { service } = wildcardService();
    const portal = await service.open({ targetPort });
    const response = await ingressRequest(portal.listenPort, portal.url);
    expect(response.status).toBe(302);
    expect(response.location).toBe(`${new URL(portal.publicUrl).origin}/next?q=1#section`);
  });

  it("shares listener startup across concurrent opens and closes only the selected portal", async () => {
    const { service, httpServers } = wildcardService();
    const [first, second] = await Promise.all([
      service.open({ targetPort: 3000 }),
      service.open({ targetPort: 4000 }),
    ]);
    expect(httpServers).toHaveLength(1);
    expect(first.listenPort).toBe(second.listenPort);
    expect(new URL(first.url).hostname).not.toBe(new URL(second.url).hostname);
    await service.close(first.id);
    expect((await ingressRequest(second.listenPort, second.publicUrl)).status).toBe(401);
    const listener = httpServers[0];
    await service.closeAll();
    expect(listener?.listening).toBe(false);
    expect(httpServers).toEqual([]);
  });

  it("settles an in-flight ingress bind before whole-service teardown", async () => {
    const bind = holdPortalBind();
    const { service, httpServers } = wildcardService();
    const opening = service.open({ targetPort: 3000 });
    const rejected = expect(opening).rejects.toThrow("portals unavailable");
    await bind.started;
    const closing = service.closeAll();
    bind.release();
    await rejected;
    await closing;
    expect(service.list()).toEqual([]);
    expect(httpServers).toEqual([]);
  });

  it("rejects configured and managed Gateway host collisions", () => {
    expect(() =>
      makeService({
        ingress: { domain: "example.net", port: 18890 },
        gatewayOrigins: ["https://control.example.net"],
      }),
    ).toThrow("separate DNS domain");
  });
  it("uses a private Serve claim with partitioned cookies even for a Funnel Gateway", async () => {
    target.handler = (_, res) => {
      res.setHeader("Set-Cookie", "session=ok; Path=/");
      res.end("app");
    };
    const resolveHost = vi.spyOn(advertisedLanHost, "resolveAdvertisedLanHostCore");
    publishManaged("funnel");
    const { claim } = fakeClaim();
    vi.mocked(claimTailscaleServePort).mockResolvedValue(claim);
    const { service, httpServers } = makeService({
      managedTailscale: true,
      httpBindHosts: ["0.0.0.0"],
    });
    const targetPort = target.port;
    const portal = await service.open({ targetPort, path: "/app" });
    expect(portal.publicUrl).toBe(`https://gw.ts.net:${portal.listenPort}/app`);
    expect(claimTailscaleServePort).toHaveBeenCalledExactlyOnceWith(
      portal.listenPort,
      portal.listenPort,
      expect.any(Function),
    );
    expect(httpServers[0]?.address()).toMatchObject({ address: "127.0.0.1" });
    const response = await ingressRequest(portal.listenPort, portal.url);
    expect(response.status).toBe(200);
    expect(response.cookie).toHaveLength(2);
    for (const cookie of response.cookie) {
      expect(cookie).toContain("SameSite=None");
      expect(cookie).toContain("Secure");
      expect(cookie).toContain("Partitioned");
    }
    await service.open({ targetPort });
    expect(claimTailscaleServePort).toHaveBeenCalledTimes(1);
    await service.close(portal.id);
    expect(claim.stop).toHaveBeenCalledOnce();
    expect(service.list()).toEqual([]);
    expect(resolveHost).not.toHaveBeenCalled();
  });

  it.each([
    ["absent", "managed Tailscale route is not active"],
    ["failed", "HTTPS port occupied"],
    ["revoked", "authority revoked"],
  ])("rolls back unpublished resources when the managed route is %s", async (state, message) => {
    const { claim } = fakeClaim();
    const guard = authority(message);
    if (state !== "absent") {
      publishManaged();
      vi.mocked(claimTailscaleServePort).mockImplementation(async () => {
        if (state === "failed") {
          throw new Error(message);
        }
        guard.current = false;
        return claim;
      });
    }
    const { service, httpServers } = makeService({ managedTailscale: true });
    const releaseTarget = vi.fn();
    await expect(
      service.open({
        targetPort: 3000,
        onClose: releaseTarget,
        assertCurrent: guard.assertCurrent,
      }),
    ).rejects.toThrow(message);
    expect(releaseTarget).toHaveBeenCalledOnce();
    expect(httpServers).toEqual([]);
    expect(service.list()).toEqual([]);
    if (state === "absent") {
      expect(claimTailscaleServePort).not.toHaveBeenCalled();
    } else if (state === "revoked") {
      expect(claim.stop).toHaveBeenCalledOnce();
    }
  });

  it.each(["claim", "gateway"])("retires portals on %s loss", async (loss) => {
    const withdrawGateway = publishManaged();
    const { claim, lose } = fakeClaim();
    vi.mocked(claimTailscaleServePort).mockResolvedValue(claim);
    const { service, httpServers } = makeService({ managedTailscale: true });
    const releaseTarget = vi.fn();
    await service.open({ targetPort: 3000, onClose: releaseTarget });
    const listener = httpServers[0];
    if (loss === "claim") {
      lose();
    } else {
      withdrawGateway();
    }
    expect(service.list()).toEqual([]);
    // Explicit close joins the owner teardown instead of polling the event loop.
    await service.close("p3000");
    expect(claim.stop).toHaveBeenCalledOnce();
    expect(releaseTarget).toHaveBeenCalledOnce();
    expect(listener?.listening).toBe(false);
  });
});
