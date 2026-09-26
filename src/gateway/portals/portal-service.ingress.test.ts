import { request, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import * as advertisedLanHost from "../../infra/advertised-lan-host.js";
import { claimTailscaleServePort, type TailscaleRouteClaim } from "../../infra/tailscale.js";
import { withServer } from "../../plugin-sdk/test-helpers/http-test-server.js";
import * as httpListen from "../server/http-listen.js";
import { prepareTailscalePublishedOrigin } from "../tailscale-published-origin.js";
import { createGatewayPortalService, type GatewayPortalService } from "./portal-service.js";

// Every managed route operation is fake: these tests must never change the host's tailnet.
vi.mock("../../infra/tailscale.js", () => ({ claimTailscaleServePort: vi.fn() }));

const services: GatewayPortalService[] = [];
const withdraw: Array<() => void> = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.closeAll()));
  for (const release of withdraw.splice(0)) {
    release();
  }
  vi.restoreAllMocks();
  vi.mocked(claimTailscaleServePort).mockReset();
});

function makeService(options: Partial<Parameters<typeof createGatewayPortalService>[0]> = {}) {
  const httpServers: Server[] = [];
  const service = createGatewayPortalService({
    httpBindHosts: ["127.0.0.1"],
    httpServers,
    ...options,
  });
  services.push(service);
  return { service, httpServers };
}

function publishManaged(mode: "serve" | "funnel" = "serve") {
  const release = prepareTailscalePublishedOrigin({
    origin: "https://gateway.example.ts.net",
    mode,
  });
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
  return await new Promise<{ status: number; body: string; cookie: string[]; location?: string }>(
    (resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port,
          path: `${parsed.pathname}${parsed.search}`,
          headers: { host: host ?? parsed.host },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
          res.on("end", () =>
            resolve({
              status: res.statusCode ?? 0,
              body: Buffer.concat(chunks).toString(),
              cookie: res.headers["set-cookie"] ?? [],
              location: res.headers.location,
            }),
          );
        },
      );
      req.on("error", reject);
      req.end();
    },
  );
}

describe("operator-managed private wildcard portal ingress", () => {
  it("publishes authoritative HTTPS paths on random per-lifetime hosts and gates every target", async () => {
    await withServer(
      (req, res) => {
        res.setHeader("Set-Cookie", ["session=ok; Path=/", "restricted=ok; SameSite=Strict"]);
        res.end(JSON.stringify({ path: req.url, proto: req.headers["x-forwarded-proto"] }));
      },
      async (targetUrl) => {
        const { service, httpServers } = makeService({
          httpBindHosts: ["0.0.0.0"],
          ingress: { domain: "previews.example.net", port: 0 },
        });
        const resolveHost = vi.spyOn(advertisedLanHost, "resolveAdvertisedLanHostCore");
        const targetPort = Number(new URL(targetUrl).port);
        const first = await service.open({ targetPort, path: "/nested/start?theme=dark" });
        expect(first.publicUrl).toMatch(
          /^https:\/\/[a-f0-9]{32}\.previews\.example\.net\/nested\/start\?theme=dark$/u,
        );
        expect(first.publicUrl).not.toContain("openclaw_portal");
        expect(httpServers).toHaveLength(1);
        expect(httpServers[0]?.address()).toMatchObject({
          address: "127.0.0.1",
          port: first.listenPort,
        });
        const response = await ingressRequest(first.listenPort, first.url);
        expect(response.status).toBe(200);
        expect(JSON.parse(response.body)).toEqual({
          path: "/nested/start?theme=dark",
          proto: "https",
        });
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
        expect(
          (await ingressRequest(first.listenPort, first.url, "unknown.previews.example.net"))
            .status,
        ).toBe(404);
        expect(
          (await ingressRequest(first.listenPort, first.url, "gateway.example.net")).status,
        ).toBe(404);
        expect(
          (await ingressRequest(first.listenPort, first.url, `${new URL(first.url).hostname}:8443`))
            .status,
        ).toBe(404);
        const reused = await service.open({ targetPort, path: "/updated" });
        expect(new URL(reused.url).origin).toBe(new URL(first.url).origin);
        expect(reused.publicUrl).toBe(`${new URL(first.url).origin}/updated`);
        await service.close(first.id);
        expect((await ingressRequest(first.listenPort, first.url)).status).toBe(404);
        const reopened = await service.open({ targetPort });
        expect(new URL(reopened.url).hostname).not.toBe(new URL(first.url).hostname);
        expect((await ingressRequest(first.listenPort, first.url)).status).toBe(404);
        expect(claimTailscaleServePort).not.toHaveBeenCalled();
        expect(resolveHost).not.toHaveBeenCalled();
      },
    );
  });

  it.each(["http://localhost", "//127.0.0.1"])(
    "clears the backend port from wildcard redirects using %s",
    async (prefix) => {
      let targetPort = 0;
      await withServer(
        (_req, res) => {
          res.writeHead(302, { Location: `${prefix}:${targetPort}/next?q=1#section` });
          res.end();
        },
        async (targetUrl) => {
          targetPort = Number(new URL(targetUrl).port);
          const { service } = makeService({
            ingress: { domain: "previews.example.net", port: 0 },
          });
          const portal = await service.open({ targetPort });
          const response = await ingressRequest(portal.listenPort, portal.url);
          expect(response.status).toBe(302);
          expect(response.location).toBe(`${new URL(portal.publicUrl).origin}/next?q=1#section`);
        },
      );
    },
  );

  it("shares listener startup across concurrent opens and closes only the selected portal", async () => {
    const { service, httpServers } = makeService({
      ingress: { domain: "previews.example.net", port: 0 },
    });
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
    const started = createDeferred();
    const release = createDeferred();
    const actual = httpListen.listenGatewayHttpServer;
    vi.spyOn(httpListen, "listenGatewayHttpServer").mockImplementation(async (params) => {
      started.resolve();
      await release.promise;
      await actual(params);
    });
    const { service, httpServers } = makeService({
      ingress: { domain: "previews.example.net", port: 0 },
    });
    const opening = service.open({ targetPort: 3000 });
    const rejected = expect(opening).rejects.toThrow("portals unavailable");
    await started.promise;
    const closing = service.closeAll();
    release.resolve();
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
});

describe("managed private Serve portal ingress", () => {
  it("partitions authentication and default app cookies for cross-site HTTPS embedding", async () => {
    await withServer(
      (_, res) => {
        res.setHeader("Set-Cookie", "session=ok; Path=/");
        res.end("app");
      },
      async (targetUrl) => {
        publishManaged();
        const { claim } = fakeClaim();
        vi.mocked(claimTailscaleServePort).mockResolvedValue(claim);
        const { service } = makeService({ managedTailscale: true });
        const portal = await service.open({ targetPort: Number(new URL(targetUrl).port) });
        const response = await ingressRequest(portal.listenPort, portal.url);
        expect(response.status).toBe(200);
        expect(response.cookie).toHaveLength(2);
        for (const cookie of response.cookie) {
          expect(cookie).toContain("SameSite=None");
          expect(cookie).toContain("Secure");
          expect(cookie).toContain("Partitioned");
        }
      },
    );
  });
  it.each(["serve", "funnel"] as const)(
    "uses a separate private Serve claim even for a %s Gateway",
    async (mode) => {
      const resolveHost = vi.spyOn(advertisedLanHost, "resolveAdvertisedLanHostCore");
      publishManaged(mode);
      const { claim } = fakeClaim();
      vi.mocked(claimTailscaleServePort).mockResolvedValue(claim);
      const { service, httpServers } = makeService({
        managedTailscale: true,
        httpBindHosts: ["0.0.0.0"],
      });
      const portal = await service.open({ targetPort: 3000, path: "/app" });
      expect(portal.publicUrl).toBe(`https://gateway.example.ts.net:${portal.listenPort}/app`);
      expect(claimTailscaleServePort).toHaveBeenCalledExactlyOnceWith(
        portal.listenPort,
        portal.listenPort,
        expect.any(Function),
      );
      expect(httpServers[0]?.address()).toMatchObject({ address: "127.0.0.1" });
      expect(portal.listenPort).not.toBe(443);
      await service.open({ targetPort: 3000 });
      expect(claimTailscaleServePort).toHaveBeenCalledTimes(1);
      await service.close(portal.id);
      expect(claim.stop).toHaveBeenCalledOnce();
      expect(service.list()).toEqual([]);
      expect(resolveHost).not.toHaveBeenCalled();
    },
  );

  it("never silently publishes direct listener URLs when the managed route is absent", async () => {
    const { service, httpServers } = makeService({ managedTailscale: true });
    await expect(service.open({ targetPort: 3000 })).rejects.toThrow(
      "managed Tailscale route is not active",
    );
    expect(httpServers).toEqual([]);
    expect(claimTailscaleServePort).not.toHaveBeenCalled();
  });

  it("rolls back listener and target ownership on claim startup failure", async () => {
    publishManaged();
    vi.mocked(claimTailscaleServePort).mockRejectedValue(new Error("HTTPS port occupied"));
    const releaseTarget = vi.fn();
    const { service, httpServers } = makeService({ managedTailscale: true });
    await expect(service.open({ targetPort: 3000, onClose: releaseTarget })).rejects.toThrow(
      "HTTPS port occupied",
    );
    expect(httpServers).toEqual([]);
    expect(service.list()).toEqual([]);
    expect(releaseTarget).toHaveBeenCalledOnce();
  });

  it("revalidates authority after route startup and releases the unpublished claim", async () => {
    publishManaged();
    const { claim } = fakeClaim();
    let current = true;
    vi.mocked(claimTailscaleServePort).mockImplementation(async () => {
      current = false;
      return claim;
    });
    const { service, httpServers } = makeService({ managedTailscale: true });
    const releaseTarget = vi.fn();
    await expect(
      service.open({
        targetPort: 3000,
        onClose: releaseTarget,
        assertCurrent: () => {
          if (!current) {
            throw new Error("authority revoked");
          }
        },
      }),
    ).rejects.toThrow("authority revoked");
    expect(claim.stop).toHaveBeenCalledOnce();
    expect(releaseTarget).toHaveBeenCalledOnce();
    expect(httpServers).toEqual([]);
    expect(service.list()).toEqual([]);
  });

  it.each(["claim", "gateway"])(
    "withdraws publication and closes resources after %s owner loss",
    async (loss) => {
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
    },
  );
});
