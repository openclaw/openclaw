import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import { Agent as HttpsAgent } from "node:https";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as advertisedLanHost from "../../infra/advertised-lan-host.js";
import { claimTailscaleServePort, type TailscaleRouteClaim } from "../../infra/tailscale.js";
import * as httpListen from "../server/http-listen.js";
import { prepareTailscalePublishedOrigin } from "../tailscale-published-origin.js";
import { createPortalOperations, type GatewayPortalService } from "./portal-service.js";
import { holdPortalBind, authority, requestText, usePortalHarness } from "./portal.test-support.js";

const { target, makeService } = usePortalHarness();

async function unavailableWorkerConnection(): Promise<Duplex> {
  throw new Error("Worker connection unavailable");
}

function openWorker(
  service: GatewayPortalService,
  environmentId: string,
  ownerEpoch: number,
  options: Partial<Parameters<GatewayPortalService["open"]>[0]> = {},
) {
  return service.open({
    targetPort: 3000,
    target: {
      kind: "worker",
      environmentId,
      ownerEpoch,
      remotePort: 3000,
      connect: unavailableWorkerConnection,
    },
    ...options,
  });
}

async function getStatus(host: string, port: number, path: string) {
  return (await requestText(`http://${host.includes(":") ? `[${host}]` : host}:${port}${path}`))
    .status;
}

function expectStopped(servers: Iterable<Server>) {
  for (const server of servers) {
    expect(server.listening).toBe(false);
    expect(server.address()).toBeNull();
  }
}

function reportTargetPortCollision(server: Server, targetPort: number): void {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Missing portal listener address");
  }
  // Keep the OS allocation owned; only the next collision check sees the target port.
  vi.spyOn(server, "address").mockReturnValueOnce({ ...address, port: targetPort });
}

describe("gateway portal service", () => {
  it("keeps a scoped stream after request completion and retires it with its resource owner", async () => {
    target.handler = (_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write("data: live\n\n");
    };
    const { service } = makeService();
    const owner = new AbortController();
    const request = authority("request completed");
    const release = vi.fn();
    const portal = await service.open({
      targetPort: target.port,
      ownerSignal: owner.signal,
      assertCurrent: request.assertCurrent,
      onClose: release,
    });
    request.current = false;
    expect(service.list()).toEqual([portal]);
    expect(await getStatus("127.0.0.1", portal.listenPort, "/")).toBe(401);
    const response = await fetch(portal.url);
    const reader = response.body!.getReader();
    expect((await reader.read()).done).toBe(false);
    owner.abort();
    expect(service.list()).toEqual([]);
    await expect(reader.read()).rejects.toThrow();
    await service.closeAll();
    expect(release).toHaveBeenCalledOnce();
  });

  it.each([
    ["owner", "session reset"],
    ["LAN", "authority revoked during LAN discovery"],
    ["collision", "Portal listener repeatedly allocated target port"],
    ["partial bind", "already listening"],
    ["absent route", "managed Tailscale route is not active"],
    ["failed route", "HTTPS port occupied"],
    ["revoked route", "authority revoked"],
  ])("rolls back unpublished resources after %s", async (stage, message) => {
    const owner = new AbortController();
    const guard = authority(message);
    const release = vi.fn();
    const attempted = new Set<Server>();
    const originalListen = httpListen.listenGatewayHttpServer;
    vi.spyOn(httpListen, "listenGatewayHttpServer").mockImplementation(async (params) => {
      attempted.add(params.httpServer);
      await originalListen(params);
      if (stage === "owner") {
        owner.abort(new Error(message));
      }
      if (stage === "collision") {
        reportTargetPortCollision(params.httpServer, target.port);
      }
    });
    if (stage === "LAN") {
      vi.spyOn(advertisedLanHost, "resolveAdvertisedLanHostCore").mockImplementation(async () => {
        guard.current = false;
        return "192.168.1.20";
      });
    }
    const managed = stage.endsWith("route");
    const { claim } = fakeClaim();
    if (managed && stage !== "absent route") {
      publishManaged();
      vi.mocked(claimTailscaleServePort).mockImplementation(async () => {
        if (stage === "failed route") {
          throw new Error(message);
        }
        guard.current = false;
        return claim;
      });
    }
    const { service, httpServers } = makeService({
      managedTailscale: managed,
      httpBindHosts:
        stage === "partial bind"
          ? ["127.0.0.1", "127.0.0.1"]
          : [stage === "LAN" ? "0.0.0.0" : "127.0.0.1"],
    });
    await expect(
      service.open({
        targetPort: target.port,
        onClose: release,
        ownerSignal: owner.signal,
        assertCurrent: guard.assertCurrent,
      }),
    ).rejects.toThrow(message);
    expect(service.list()).toEqual([]);
    expect(httpServers).toEqual([]);
    expect(release).toHaveBeenCalledOnce();
    expectStopped(attempted);
    if (stage === "absent route") {
      expect(claimTailscaleServePort).not.toHaveBeenCalled();
    }
    if (stage === "revoked route") {
      expect(claim.stop).toHaveBeenCalledOnce();
    }
  });

  it("owns the same port on IPv4 and IPv6 and closes both listeners", async () => {
    const { service, httpServers } = makeService({ httpBindHosts: ["127.0.0.1", "::1"] });
    const portal = await service.open({ targetPort: target.port, title: "App" });
    expect(portal.port).toBe(target.port);
    for (const host of ["127.0.0.1", "::1"]) {
      expect(await getStatus(host, portal.listenPort, "/")).toBe(401);
    }
    expect(httpServers).toHaveLength(2);
    expect(await requestText(portal.url)).toMatchObject({ status: 200, body: "target" });
    const ownedServers = [...httpServers];
    await service.closeAll();
    expect(httpServers).toEqual([]);
    expectStopped(ownedServers);
  });

  it("updates an existing target without replacing its listener or token", async () => {
    const { service, httpServers } = makeService();
    const releaseFirst = vi.fn();
    const releaseRedundant = vi.fn();
    const first = await service.open({ targetPort: 3000, title: "First", onClose: releaseFirst });
    const releaseRejected = vi.fn();
    await expect(
      service.open({
        targetPort: 3000,
        title: "Hijacked",
        onClose: releaseRejected,
        assertCurrent: () => {
          throw new Error("authority lapsed");
        },
      }),
    ).rejects.toThrow("authority lapsed");
    expect(service.list().find((portal) => portal.id === first.id)?.title).toBe("First");
    expect(releaseRejected).toHaveBeenCalledOnce();
    const second = await service.open({
      targetPort: 3000,
      title: "Second",
      description: "Updated",
      path: "/preview",
      onClose: releaseRedundant,
    });

    expect(second).toMatchObject({
      id: first.id,
      listenPort: first.listenPort,
      tokenQuery: first.tokenQuery,
      title: "Second",
      description: "Updated",
      path: "/preview",
      publicUrl: `http://127.0.0.1:${first.listenPort}/preview`,
    });
    expect(second.url).toBe(`${second.publicUrl}?${second.tokenQuery}`);
    expect(httpServers).toHaveLength(1);
    expect(service.list()).toEqual([second]);
    expect(releaseFirst).not.toHaveBeenCalled();
    expect(releaseRedundant).toHaveBeenCalledOnce();

    await service.close(first.id);
    expect(releaseFirst).toHaveBeenCalledOnce();
    expect(releaseRedundant).toHaveBeenCalledOnce();
  });

  it("keeps local and worker portals on the same application port distinct", async () => {
    const { service } = makeService();
    const closeStaleForward = vi.fn();
    const closeCurrentForward = vi.fn();
    const local = await service.open({ targetPort: 3000 });
    const worker = await openWorker(service, "cloud/a", 7, {
      origin: "Cloud worker A",
      onClose: closeCurrentForward,
    });
    const otherWorker = await openWorker(service, "cloud-a", 7);
    const staleWorker = await openWorker(service, "cloud/a", 6, { onClose: closeStaleForward });

    expect(local.id).toBe("p3000");
    expect(new Set([local.id, worker.id, otherWorker.id, staleWorker.id]).size).toBe(4);
    expect(worker).toMatchObject({
      port: 3000,
      origin: "Cloud worker A",
      exposure: { kind: "loopback-only", browserReachability: "unverified" },
    });
    expect(service.listWorkerPortals("cloud/a", 7)).toEqual([worker]);
    expect(service.listWorkerPortals("cloud/a", 6)).toEqual([staleWorker]);
    expect(service.listWorkerPortals("cloud-a", 7)).toEqual([otherWorker]);
    expect(service.listWorkerPortals("cloud/a", 8)).toEqual([]);
    await service.closeWorkerPortals("cloud/a", 6);
    expect(closeStaleForward).toHaveBeenCalledOnce();
    expect(closeCurrentForward).not.toHaveBeenCalled();
    expect(service.list()).toEqual(expect.arrayContaining([local, worker, otherWorker]));
    expect(service.list()).toHaveLength(3);
    await service.close(worker.id);
    expect(closeCurrentForward).toHaveBeenCalledOnce();
  });

  it("revalidates worker close authority immediately before queued removal", async () => {
    const { service } = makeService();
    const guard = authority("Worker portal authority changed");
    const owner = {
      environmentId: "cloud-a",
      ownerEpoch: 1,
      ownershipError: "Worker portal belongs to another owner",
      assertCurrent: guard.assertCurrent,
      prepareTarget: async () => ({ connect: unavailableWorkerConnection, close: vi.fn() }),
    };
    const operations = createPortalOperations(service, owner);
    const portal = await operations.open({ port: 3000 });
    const closing = operations.close(portal.id);
    guard.current = false;

    await expect(closing).rejects.toThrow("Worker portal authority changed");
    expect(service.list()).toEqual([portal]);
  });

  it.each(["worker", "ingress"])("settles an in-flight %s bind before teardown", async (kind) => {
    const bind = holdPortalBind();
    const { service, httpServers } = kind === "worker" ? makeService() : wildcardService();
    const release = vi.fn();
    const opening =
      kind === "worker"
        ? openWorker(service, "cloud-a", 7, { onClose: release })
        : service.open({ targetPort: 3000, onClose: release });
    const settled =
      kind === "worker" ? opening : expect(opening).rejects.toThrow("portals unavailable");
    await bind.started;
    const closing =
      kind === "worker" ? service.closeWorkerPortals("cloud-a", 7) : service.closeAll();
    bind.release();
    await settled;
    await closing;
    expect(service.list()).toEqual([]);
    expect(httpServers).toEqual([]);
    expect(release).toHaveBeenCalledOnce();
  });

  it.each([
    ["0.0.0.0", "192.168.1.20", "192.168.1.20", "/app?view=one"],
    ["0.0.0.0", null, "127.0.0.1", "/"],
    ["::", null, "[::1]", "/"],
  ] as const)("publishes %s with LAN %s as %s", async (bindHost, lanHost, openableHost, path) => {
    const resolveHost = vi
      .spyOn(advertisedLanHost, "resolveAdvertisedLanHostCore")
      .mockResolvedValue(lanHost);
    const { service, httpServers } = makeService({ httpBindHosts: [bindHost] });
    const portal = await service.open({ targetPort: 3000, path });

    expect(portal.publicUrl).toBe(`http://${openableHost}:${portal.listenPort}${path}`);
    expect(portal.exposure).toEqual({
      kind: lanHost ? "non-loopback" : "loopback-only",
      browserReachability: "unverified",
    });
    expect(portal.url).toBe(
      `${portal.publicUrl}${path.includes("?") ? "&" : "?"}${portal.tokenQuery}`,
    );
    if (lanHost) {
      expect(httpServers[0]?.address()).toMatchObject({ address: bindHost });
      expect(await getStatus("127.0.0.1", portal.listenPort, "/")).toBe(401);
      // Publication belongs to this listener lifetime, not each listing or caller's hostname.
      resolveHost.mockResolvedValue("192.168.1.21");
      expect(service.list()).toEqual([portal]);
      expect(await service.open({ targetPort: 3000 })).toEqual(portal);
      expect(resolveHost).toHaveBeenCalledOnce();
    }
  });
});
describe("direct HTTPS portal publication", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  let certificates: Record<"dns" | "ip" | "wildcard", { cert: string; key: string }>;

  // Fresh material keeps CA, expiry, and hostname checks enabled in every case.
  function createCertificate(subjectAltName: string) {
    const directory = tempDirs.make("portal-direct-tls-");
    const certPath = join(directory, "cert.pem");
    const keyPath = join(directory, "key.pem");
    execFileSync(
      "openssl",
      [
        ..."req -x509 -newkey rsa:2048 -nodes -days 2 -subj /CN=gw.e.test".split(" "),
        "-addext",
        `subjectAltName=${subjectAltName}`,
        "-keyout",
        keyPath,
        "-out",
        certPath,
      ],
      { stdio: "ignore" },
    );
    return { cert: readFileSync(certPath, "utf8"), key: readFileSync(keyPath, "utf8") };
  }

  beforeAll(() => {
    certificates = {
      dns: createCertificate("DNS:gw.e.test,DNS:alt.e.test"),
      ip: createCertificate("IP:127.0.0.1"),
      wildcard: createCertificate("DNS:*.e.test"),
    };
  });

  // Own the listener route while keeping CA, expiry, and URL hostname checks enabled.
  async function readPortal(url: string, ca: string) {
    const agent = new HttpsAgent({
      ca,
      family: 4,
      lookup: (_host, _options, callback) => callback(null, "127.0.0.1", 4),
    });
    try {
      return await requestText(url, { agent });
    } finally {
      agent.destroy();
    }
  }

  it.each([
    ["ip", "ip", "127.0.0.1", []],
    ["wildcard", "wildcard", "gw.e.test", ["*", "https://gw.e.test"]],
    ["chain", "dns", "gw.e.test", []],
    ["LAN", "dns", "gw.e.test", []],
    ["configured", "dns", "alt.e.test", ["https://other.e.test", "https://alt.e.test:8443"]],
  ] as const)(
    "publishes certificate-valid %s origins",
    async (kind, identity, hostname, gatewayOrigins) => {
      const material = certificates[identity];
      if (kind === "LAN") {
        // A broken candidate must fail on TLS, not routing.
        vi.spyOn(advertisedLanHost, "resolveAdvertisedLanHostCore").mockResolvedValue("127.0.0.2");
      }
      const { service } = makeService({
        httpBindHosts: [kind === "LAN" ? "0.0.0.0" : "127.0.0.1"],
        tlsOptions: { ...material, cert: kind === "chain" ? [material.cert] : material.cert },
        gatewayOrigins: [...gatewayOrigins],
      });
      const portal = await service.open({ targetPort: kind === "LAN" ? target.port : 3000 });
      expect(new URL(portal.publicUrl).hostname).toBe(hostname);
      expect(portal.exposure).toEqual({
        kind: kind === "LAN" ? "non-loopback" : "loopback-only",
        browserReachability: "unverified",
      });
      if (kind === "LAN") {
        target.handler = (_req, res) => res.end("direct TLS app");
        expect(await readPortal(portal.url, material.cert)).toMatchObject({
          status: 200,
          body: "direct TLS app",
        });
      }
      expect((await readPortal(portal.publicUrl, material.cert)).status).toBe(401);
    },
  );
});

// Every managed route operation is fake: these tests must never change the host's tailnet.
vi.mock(import("../../infra/tailscale.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  claimTailscaleServePort: vi.fn(),
}));

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
  const response = await requestText(`http://127.0.0.1:${port}${parsed.pathname}${parsed.search}`, {
    headers: { host: host ?? parsed.host },
  });
  return { ...response, cookie: response.headers["set-cookie"] ?? [] };
}

describe("private portal ingress", () => {
  it("publishes authoritative HTTPS paths on random per-lifetime hosts and gates every target", async () => {
    target.handler = (req, res) => {
      res.setHeader("Set-Cookie", ["session=ok; Path=/", "restricted=ok; SameSite=Strict"]);
      res.end(JSON.stringify({ path: req.url, proto: req.headers["x-forwarded-proto"] }));
    };
    const { service, httpServers } = wildcardService(["0.0.0.0"]);
    const resolveHost = vi.spyOn(advertisedLanHost, "resolveAdvertisedLanHostCore");
    const first = await service.open({ targetPort: target.port, path: "/a/b?x=1" });
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
    const reused = await service.open({ targetPort: target.port, path: "/updated" });
    expect(reused.publicUrl).toBe(`${new URL(first.url).origin}/updated`);
    await service.close(first.id);
    expect((await ingressRequest(first.listenPort, first.url)).status).toBe(404);
    const reopened = await service.open({ targetPort: target.port });
    expect(new URL(reopened.url).hostname).not.toBe(new URL(first.url).hostname);
    expect((await ingressRequest(first.listenPort, first.url)).status).toBe(404);
    expect(claimTailscaleServePort).not.toHaveBeenCalled();
    expect(resolveHost).not.toHaveBeenCalled();
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

  it("rejects configured and managed Gateway host collisions", () => {
    expect(() =>
      makeService({
        ingress: { domain: "example.net", port: 18890 },
        gatewayOrigins: ["https://control.example.net"],
      }),
    ).toThrow("separate DNS domain");
  });
  it.each(["claim", "gateway"])("keeps Funnel portals private until %s loss", async (loss) => {
    target.handler = (_, res) => {
      res.setHeader("Set-Cookie", "session=ok; Path=/");
      res.end("app");
    };
    const resolveHost = vi.spyOn(advertisedLanHost, "resolveAdvertisedLanHostCore");
    const withdrawGateway = publishManaged("funnel");
    const { claim, lose } = fakeClaim();
    vi.mocked(claimTailscaleServePort).mockResolvedValue(claim);
    const { service, httpServers } = makeService({
      managedTailscale: true,
      httpBindHosts: ["0.0.0.0"],
    });
    const releaseTarget = vi.fn();
    const portal = await service.open({
      targetPort: target.port,
      path: "/app",
      onClose: releaseTarget,
    });
    const listener = httpServers[0];
    expect(portal.publicUrl).toBe(`https://gw.ts.net:${portal.listenPort}/app`);
    expect(httpServers[0]?.address()).toMatchObject({ address: "127.0.0.1" });
    const response = await ingressRequest(portal.listenPort, portal.url);
    expect(response.status).toBe(200);
    expect(response.cookie).toHaveLength(2);
    for (const cookie of response.cookie) {
      for (const attribute of ["SameSite=None", "Secure", "Partitioned"]) {
        expect(cookie).toContain(attribute);
      }
    }
    await service.open({ targetPort: target.port });
    expect(claimTailscaleServePort).toHaveBeenCalledTimes(1);
    if (loss === "claim") {
      lose();
    } else {
      withdrawGateway();
    }
    expect(service.list()).toEqual([]);
    // Explicit close joins the owner teardown instead of polling the event loop.
    await service.close(portal.id);
    expect(claim.stop).toHaveBeenCalledOnce();
    expect(releaseTarget).toHaveBeenCalledOnce();
    expect(listener?.listening).toBe(false);
    expect(resolveHost).not.toHaveBeenCalled();
  });
});
