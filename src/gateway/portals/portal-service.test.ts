import { request, type Server } from "node:http";
import type { Duplex } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import * as advertisedLanHost from "../../infra/advertised-lan-host.js";
import { readResponseWithLimit } from "../../infra/http-body.js";
import { withServer } from "../../plugin-sdk/test-helpers/http-test-server.js";
import * as httpListen from "../server/http-listen.js";
import {
  createGatewayPortalService,
  createPortalOperations,
  type GatewayPortalService,
} from "./portal-service.js";

const services = new Set<GatewayPortalService>();

async function unavailableWorkerConnection(): Promise<Duplex> {
  throw new Error("Worker connection unavailable");
}

function workerTarget(environmentId = "cloud-a", ownerEpoch = 7) {
  return {
    kind: "worker" as const,
    environmentId,
    ownerEpoch,
    remotePort: 3000,
    connect: unavailableWorkerConnection,
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all([...services].map((service) => service.closeAll()));
  services.clear();
});

function makeService(hosts: string[]) {
  const httpServers: import("node:http").Server[] = [];
  const service = createGatewayPortalService({ httpBindHosts: hosts, httpServers });
  services.add(service);
  return { service, httpServers };
}

async function getStatus(host: string, port: number, path: string): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const req = request({ host, port, path }, (res) => {
      res.resume();
      res.once("end", () => resolve(res.statusCode ?? 0));
    });
    req.once("error", reject);
    req.end();
  });
}

function reportTargetPortCollision(server: Server, targetPort: number): void {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Missing portal listener address");
  }
  // Keep the OS allocation owned; only the next collision check sees the target port.
  vi.spyOn(server, "address").mockReturnValueOnce({ ...address, port: targetPort });
}

describe("portal open authority fence", () => {
  it("keeps a scoped stream after request completion and retires it with its resource owner", async () => {
    await withServer(
      (_req, res) => {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write("data: live\n\n");
      },
      async (targetUrl) => {
        const { service } = makeService(["127.0.0.1"]);
        const owner = new AbortController();
        let requestCurrent = true;
        const release = vi.fn();
        const portal = await service.open({
          targetPort: Number(new URL(targetUrl).port),
          ownerSignal: owner.signal,
          assertCurrent: () => {
            if (!requestCurrent) {
              throw new Error("request completed");
            }
          },
          onClose: release,
        });
        requestCurrent = false;
        expect(service.list()).toEqual([portal]);
        expect(await getStatus("127.0.0.1", portal.listenPort, "/")).toBe(401);
        const response = await fetch(portal.url);
        const reader = response.body!.getReader();
        expect((await reader.read()).done).toBe(false);
        owner.abort();
        expect(service.list()).toEqual([]);
        await expect(reader.read()).rejects.toThrow();
        expect(service.list()).toEqual([]);
        await service.closeAll();
        expect(release).toHaveBeenCalledOnce();
      },
    );
  });

  it("refuses to mutate a reused portal when the caller's authority lapsed", async () => {
    const { service } = makeService(["127.0.0.1"]);
    const first = await service.open({ targetPort: 41234, title: "Live" });
    const releaseRejected = vi.fn();
    await expect(
      service.open({
        targetPort: 41234,
        title: "Hijacked",
        onClose: releaseRejected,
        assertCurrent: () => {
          throw new Error("authority lapsed");
        },
      }),
    ).rejects.toThrow("authority lapsed");
    const summary = service.list().find((portal) => portal.id === first.id);
    expect(summary?.title).toBe("Live");
    expect(releaseRejected).toHaveBeenCalledOnce();
  });

  it.each([
    ["owner", "session reset"],
    ["listener", "Worker portal authority changed"],
    ["LAN", "authority revoked during LAN discovery"],
  ])("releases unpublished resources after %s authority loss", async (stage, message) => {
    const owner = new AbortController();
    const actualListen = httpListen.listenGatewayHttpServer;
    let authorityCurrent = true;
    let listener: Server | undefined;
    vi.spyOn(httpListen, "listenGatewayHttpServer").mockImplementation(async (params) => {
      listener = params.httpServer;
      await actualListen(params);
      if (stage === "owner") {
        owner.abort(new Error(message));
      } else if (stage === "listener") {
        authorityCurrent = false;
      }
    });
    if (stage === "LAN") {
      vi.spyOn(advertisedLanHost, "resolveAdvertisedLanHostCore").mockImplementation(async () => {
        authorityCurrent = false;
        return "192.168.1.20";
      });
    }
    const { service, httpServers } = makeService([stage === "LAN" ? "0.0.0.0" : "127.0.0.1"]);
    const releaseTarget = vi.fn();

    await expect(
      service.open({
        targetPort: 3000,
        onClose: releaseTarget,
        ownerSignal: owner.signal,
        assertCurrent: () => {
          if (!authorityCurrent) {
            throw new Error(message);
          }
        },
      }),
    ).rejects.toThrow(message);

    expect(service.list()).toEqual([]);
    expect(httpServers).toEqual([]);
    expect(listener?.listening).toBe(false);
    expect(releaseTarget).toHaveBeenCalledOnce();
  });
});

describe("gateway portal service", () => {
  it.each([false, true])(
    "owns all listeners after target-port collision exhaustion=%s",
    async (exhausted) => {
      await withServer(
        (_req, res) => res.end("target"),
        async (targetUrl) => {
          const targetPort = Number(new URL(targetUrl).port);
          const actualListen = httpListen.listenGatewayHttpServer;
          const calls: Array<{ host: string; port: number }> = [];
          const attemptedServers = new Set<Server>();
          let primaryAttempt = 0;
          const listen = vi
            .spyOn(httpListen, "listenGatewayHttpServer")
            .mockImplementation(async (params) => {
              calls.push({ host: params.bindHost, port: params.port });
              attemptedServers.add(params.httpServer);
              await actualListen(params);
              if (params.bindHost === "127.0.0.1" && params.port === 0) {
                primaryAttempt += 1;
                if (exhausted || primaryAttempt === 1) {
                  reportTargetPortCollision(params.httpServer, targetPort);
                }
              }
            });
          const { service, httpServers } = makeService(
            exhausted ? ["127.0.0.1"] : ["127.0.0.1", "::1"],
          );

          if (exhausted) {
            await expect(service.open({ targetPort })).rejects.toThrow(
              `Portal listener repeatedly allocated target port ${targetPort}`,
            );
            expect(listen).toHaveBeenCalledTimes(10);
            expect(attemptedServers.size).toBe(1);
            expect(httpServers).toEqual([]);
            const [primaryServer] = attemptedServers;
            expect(primaryServer?.listening).toBe(false);
            expect(primaryServer?.address()).toBeNull();
            return;
          }

          const portal = await service.open({ targetPort, title: "App" });

          expect(portal).toMatchObject({ id: `p${targetPort}`, port: targetPort, title: "App" });
          expect(portal.listenPort).toBeGreaterThan(0);
          expect(await getStatus("127.0.0.1", portal.listenPort, "/")).toBe(401);
          expect(await getStatus("::1", portal.listenPort, "/")).toBe(401);
          expect(portal.listenPort).not.toBe(targetPort);
          expect(calls).toEqual([
            { host: "127.0.0.1", port: 0 },
            { host: "127.0.0.1", port: 0 },
            { host: "::1", port: portal.listenPort },
          ]);
          expect(httpServers).toHaveLength(2);
          expect(httpServers.every((server) => server.listening)).toBe(true);
          for (const server of httpServers) {
            expect(server.address()).toMatchObject({ port: portal.listenPort });
          }
          const response = await fetch(portal.url);
          expect(response.status).toBe(200);
          expect((await readResponseWithLimit(response, 32)).toString("utf8")).toBe("target");

          const ownedServers = [...httpServers];
          await service.closeAll();
          expect(httpServers).toEqual([]);
          expect(
            ownedServers.every((server) => !server.listening && server.address() === null),
          ).toBe(true);
        },
      );
    },
  );

  it("updates an existing target without replacing its listener or token", async () => {
    const { service, httpServers } = makeService(["127.0.0.1"]);
    const releaseFirst = vi.fn();
    const releaseRedundant = vi.fn();
    const first = await service.open({
      targetPort: 3000,
      title: "First",
      onClose: releaseFirst,
    });
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
    const { service } = makeService(["127.0.0.1"]);
    const local = await service.open({ targetPort: 3000 });
    const worker = await service.open({
      targetPort: 3000,
      target: workerTarget("cloud/a", 7),
      origin: "Cloud worker A",
    });
    const otherWorker = await service.open({
      targetPort: 3000,
      target: workerTarget("cloud-a", 7),
    });
    const staleWorker = await service.open({
      targetPort: 3000,
      target: workerTarget("cloud/a", 6),
    });

    expect(local.id).toBe("p3000");
    expect(new Set([local.id, worker.id, otherWorker.id, staleWorker.id]).size).toBe(4);
    expect(worker).toMatchObject({ port: 3000, origin: "Cloud worker A" });
    expect(service.list()).toHaveLength(4);
    expect(service.listWorkerPortals("cloud/a", 7)).toEqual([worker]);
    expect(service.listWorkerPortals("cloud/a", 6)).toEqual([staleWorker]);
    expect(service.listWorkerPortals("cloud-a", 7)).toEqual([otherWorker]);
    expect(service.listWorkerPortals("cloud/a", 8)).toEqual([]);
  });

  it("closes worker forwards only for the selected environment owner epoch", async () => {
    const { service } = makeService(["127.0.0.1"]);
    const closeStaleForward = vi.fn();
    const closeCurrentForward = vi.fn();
    const stale = await service.open({
      targetPort: 3000,
      target: workerTarget("cloud-a", 6),
      onClose: closeStaleForward,
    });
    const current = await service.open({
      targetPort: 3000,
      target: workerTarget("cloud-a", 7),
      onClose: closeCurrentForward,
    });

    await service.closeWorkerPortals("cloud-a", 6);

    expect(closeStaleForward).toHaveBeenCalledOnce();
    expect(closeCurrentForward).not.toHaveBeenCalled();
    expect(service.list().map((portal) => portal.id)).toEqual([current.id]);
    expect(stale.id).not.toBe(current.id);

    await service.close(current.id);
    expect(closeCurrentForward).toHaveBeenCalledOnce();
  });

  it("revalidates worker close authority immediately before queued removal", async () => {
    const { service } = makeService(["127.0.0.1"]);
    const owner = {
      environmentId: "cloud-a",
      ownerEpoch: 1,
      ownershipError: "Worker portal belongs to another owner",
      current: true,
      assertCurrent() {
        if (!this.current) {
          throw new Error("Worker portal authority changed");
        }
      },
      prepareTarget: async () => ({ connect: unavailableWorkerConnection, close: vi.fn() }),
    };
    const operations = createPortalOperations(service, owner);
    const portal = await operations.open({ port: 3000 });
    const closing = operations.close(portal.id);
    owner.current = false;

    await expect(closing).rejects.toThrow("Worker portal authority changed");
    expect(service.list()).toEqual([portal]);
  });

  it("fences a worker portal whose listener is still opening during owner teardown", async () => {
    const actualListen = httpListen.listenGatewayHttpServer;
    const bindStarted = createDeferred();
    const bindReleased = createDeferred();
    vi.spyOn(httpListen, "listenGatewayHttpServer").mockImplementation(async (params) => {
      bindStarted.resolve();
      await bindReleased.promise;
      await actualListen(params);
    });
    const { service } = makeService(["127.0.0.1"]);
    const closeForward = vi.fn();
    const opening = service.open({
      targetPort: 3000,
      target: workerTarget("cloud-a", 7),
      onClose: closeForward,
    });
    await bindStarted.promise;

    const closing = service.closeWorkerPortals("cloud-a", 7);
    bindReleased.resolve();
    await opening;
    await closing;

    expect(service.list()).toEqual([]);
    expect(closeForward).toHaveBeenCalledOnce();
  });

  it("closes idempotently and closes every portal on shutdown", async () => {
    const { service, httpServers } = makeService(["127.0.0.1"]);
    const first = await service.open({ targetPort: 3000 });
    const firstServer = httpServers.at(-1);
    const second = await service.open({ targetPort: 4000 });
    const secondServer = httpServers.at(-1);
    expect(firstServer).toBeDefined();
    expect(secondServer).toBeDefined();

    await service.close(first.id);
    await service.close(first.id);
    expect(service.list().map((entry) => entry.id)).toEqual([second.id]);
    // A closed ephemeral port can be reassigned immediately to a parallel test.
    // Assert the owned Server instead of probing whichever listener now owns its port.
    expect(firstServer?.listening).toBe(false);
    expect(firstServer?.address()).toBeNull();

    await service.closeAll();
    expect(service.list()).toEqual([]);
    expect(httpServers).toEqual([]);
    expect(secondServer?.listening).toBe(false);
    expect(secondServer?.address()).toBeNull();
  });

  it("removes every registered listener after a partial bind failure", async () => {
    const { service, httpServers } = makeService(["127.0.0.1", "127.0.0.1"]);

    await expect(service.open({ targetPort: 3000 })).rejects.toThrow(/already listening/u);
    expect(service.list()).toEqual([]);
    expect(httpServers).toEqual([]);
  });

  it.each([
    ["127.0.0.1", "192.168.1.20", "127.0.0.1", "/"],
    ["0.0.0.0", "192.168.1.20", "192.168.1.20", "/app?view=one"],
    ["::", "192.168.1.20", "192.168.1.20", "/app?view=one"],
    ["0.0.0.0", null, "127.0.0.1", "/"],
    ["::", null, "[::1]", "/"],
  ] as const)("publishes %s with LAN %s as %s", async (bindHost, lanHost, openableHost, path) => {
    const resolveHost = vi
      .spyOn(advertisedLanHost, "resolveAdvertisedLanHostCore")
      .mockResolvedValue(lanHost);
    const { service, httpServers } = makeService([bindHost]);
    const portal = await service.open({ targetPort: 3000, path });

    expect(portal.publicUrl).toBe(`http://${openableHost}:${portal.listenPort}${path}`);
    expect(portal.url).toBe(
      `${portal.publicUrl}${path.includes("?") ? "&" : "?"}${portal.tokenQuery}`,
    );
    if (bindHost === "127.0.0.1") {
      expect(resolveHost).not.toHaveBeenCalled();
    } else if (lanHost) {
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
