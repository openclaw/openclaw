import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import { Agent as HttpsAgent } from "node:https";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as advertisedLanHost from "../../infra/advertised-lan-host.js";
import * as httpListen from "../server/http-listen.js";
import { createPortalOperations, type GatewayPortalService } from "./portal-service.js";
import { holdPortalBind, authority, requestText, usePortalHarness } from "./portal.test-support.js";

const { target, makeService } = usePortalHarness();

async function unavailableWorkerConnection(): Promise<Duplex> {
  throw new Error("Worker connection unavailable");
}

afterEach(() => vi.restoreAllMocks());

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
  ])("releases unpublished resources after %s authority loss", async (stage, message) => {
    const owner = new AbortController();
    const actualListen = httpListen.listenGatewayHttpServer;
    const guard = authority(message);
    let listener: Server | undefined;
    vi.spyOn(httpListen, "listenGatewayHttpServer").mockImplementation(async (params) => {
      listener = params.httpServer;
      await actualListen(params);
      if (stage === "owner") {
        owner.abort(new Error(message));
      }
    });
    if (stage === "LAN") {
      vi.spyOn(advertisedLanHost, "resolveAdvertisedLanHostCore").mockImplementation(async () => {
        guard.current = false;
        return "192.168.1.20";
      });
    }
    const { service, httpServers } = makeService({
      httpBindHosts: [stage === "LAN" ? "0.0.0.0" : "127.0.0.1"],
    });
    const releaseTarget = vi.fn();
    await expect(
      service.open({
        targetPort: 3000,
        onClose: releaseTarget,
        ownerSignal: owner.signal,
        assertCurrent: guard.assertCurrent,
      }),
    ).rejects.toThrow(message);
    expect(service.list()).toEqual([]);
    expect(httpServers).toEqual([]);
    expect(listener?.listening).toBe(false);
    expect(releaseTarget).toHaveBeenCalledOnce();
  });
  it.each([false, true])("owns listeners after collision=%s", async (collision) => {
    const targetPort = target.port;
    const actualListen = httpListen.listenGatewayHttpServer;
    const calls: Array<{ host: string; port: number }> = [];
    const attemptedServers = new Set<Server>();
    const listen = vi
      .spyOn(httpListen, "listenGatewayHttpServer")
      .mockImplementation(async (params) => {
        calls.push({ host: params.bindHost, port: params.port });
        attemptedServers.add(params.httpServer);
        await actualListen(params);
        if (collision && params.bindHost === "127.0.0.1" && params.port === 0) {
          reportTargetPortCollision(params.httpServer, targetPort);
        }
      });
    const { service, httpServers } = makeService({
      httpBindHosts: collision ? ["127.0.0.1"] : ["127.0.0.1", "::1"],
    });

    if (collision) {
      await expect(service.open({ targetPort })).rejects.toThrow(
        `Portal listener repeatedly allocated target port ${targetPort}`,
      );
      expect(listen).toHaveBeenCalledOnce();
      expect(attemptedServers.size).toBe(1);
      expect(httpServers).toEqual([]);
      const [primaryServer] = attemptedServers;
      expect(primaryServer?.listening).toBe(false);
      expect(primaryServer?.address()).toBeNull();
      return;
    }

    const portal = await service.open({ targetPort, title: "App" });
    expect(portal).toMatchObject({ id: `p${targetPort}`, port: targetPort, title: "App" });
    expect(await getStatus("127.0.0.1", portal.listenPort, "/")).toBe(401);
    expect(await getStatus("::1", portal.listenPort, "/")).toBe(401);
    expect(calls).toEqual([
      { host: "127.0.0.1", port: 0 },
      { host: "::1", port: portal.listenPort },
    ]);
    expect(httpServers).toHaveLength(2);
    expect(httpServers.every((server) => server.listening)).toBe(true);
    for (const server of httpServers) {
      expect(server.address()).toMatchObject({ port: portal.listenPort });
    }
    expect(await requestText(portal.url)).toMatchObject({ status: 200, body: "target" });

    const ownedServers = [...httpServers];
    await service.closeAll();
    expect(httpServers).toEqual([]);
    expect(ownedServers.every((server) => !server.listening && server.address() === null)).toBe(
      true,
    );
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
    expect(
      service
        .list()
        .map((portal) => portal.id)
        .toSorted(),
    ).toEqual([local.id, worker.id, otherWorker.id].toSorted());
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

  it("fences a worker portal whose listener is still opening during owner teardown", async () => {
    const bind = holdPortalBind();
    const { service } = makeService();
    const closeForward = vi.fn();
    const opening = openWorker(service, "cloud-a", 7, { onClose: closeForward });
    await bind.started;

    const closing = service.closeWorkerPortals("cloud-a", 7);
    bind.release();
    await opening;
    await closing;

    expect(service.list()).toEqual([]);
    expect(closeForward).toHaveBeenCalledOnce();
  });

  it("removes every registered listener after a partial bind failure", async () => {
    const { service, httpServers } = makeService({ httpBindHosts: ["127.0.0.1", "127.0.0.1"] });

    await expect(service.open({ targetPort: 3000 })).rejects.toThrow(/already listening/u);
    expect(service.list()).toEqual([]);
    expect(httpServers).toEqual([]);
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
  let certificate: { cert: string; key: string };
  let ipCertificate: { cert: string; key: string };
  let wildcardCertificate: { cert: string; key: string };

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
    certificate = createCertificate("DNS:gw.e.test,DNS:alt.e.test");
    ipCertificate = createCertificate("IP:127.0.0.1");
    wildcardCertificate = createCertificate("DNS:*.e.test");
  });

  // Own the listener route while keeping CA, expiry, and URL hostname checks enabled.
  async function readPortal(url: string, ca = certificate.cert) {
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

  it.each(["ip", "wildcard", "chain", "LAN", "configured"] as const)(
    "publishes certificate-valid %s origins",
    async (kind) => {
      const material =
        kind === "ip" ? ipCertificate : kind === "wildcard" ? wildcardCertificate : certificate;
      const hostname =
        kind === "ip" ? "127.0.0.1" : kind === "configured" ? "alt.e.test" : "gw.e.test";
      if (kind === "LAN") {
        // A broken candidate must fail on TLS, not routing.
        vi.spyOn(advertisedLanHost, "resolveAdvertisedLanHostCore").mockResolvedValue("127.0.0.2");
      }
      const { service } = makeService({
        httpBindHosts: [kind === "LAN" ? "0.0.0.0" : "127.0.0.1"],
        tlsOptions: { ...material, cert: kind === "chain" ? [material.cert] : material.cert },
        gatewayOrigins:
          kind === "wildcard"
            ? ["*", `https://${hostname}`]
            : kind === "configured"
              ? ["https://other.e.test", "https://alt.e.test:8443"]
              : [],
      });
      const portal = await service.open({ targetPort: kind === "LAN" ? target.port : 3000 });
      expect(new URL(portal.publicUrl).hostname).toBe(hostname);
      expect(portal.exposure).toEqual({
        kind: kind === "LAN" ? "non-loopback" : "loopback-only",
        browserReachability: "unverified",
      });
      if (kind === "LAN") {
        target.handler = (_req, res) => res.end("direct TLS app");
        expect(await readPortal(portal.url)).toMatchObject({ status: 200, body: "direct TLS app" });
      }
      expect((await readPortal(portal.publicUrl, material.cert)).status).toBe(401);
    },
  );
});
