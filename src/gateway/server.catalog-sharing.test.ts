import { expect, it } from "vitest";
import type { WebSocket } from "ws";
import type { SessionCatalogHost } from "../../packages/gateway-protocol/src/index.js";
import type { ResponseFrame } from "../../packages/gateway-protocol/src/schema/frames.js";
import { awaitGateBeforeSettlement } from "../../test/helpers/promise.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { createDeferredCore } from "../shared/deferred.js";
import { resetTestPluginRegistry, setTestPluginRegistry } from "./test-helpers.plugin-registry.js";
import {
  connectOk,
  createGatewaySuiteHarness,
  installGatewayTestHooks,
  onceMessage,
} from "./test-helpers.server.js";

installGatewayTestHooks({ scope: "suite" });

it("shares a held catalog RPC after 128 distinct catalog results settle", async ({ signal }) => {
  const token = "catalog-sharing-proof-token";
  const heldCatalogId = "catalog-sharing-proof";
  const completedCatalogId = "catalog-completed-proof";
  const started = createDeferredCore();
  const release = createDeferredCore();
  const host: SessionCatalogHost = {
    hostId: "gateway:local",
    label: "Catalog sharing proof",
    kind: "gateway",
    connected: true,
    sessions: [],
  };
  const publishHeldHosts: Array<() => void> = [];
  const providerRuns: Promise<SessionCatalogHost[]>[] = [];
  const requests: Promise<ResponseFrame>[] = [];
  const expectCatalog = (response: unknown, id: string, hosts: SessionCatalogHost[] = []) =>
    expect(response).toMatchObject({ ok: true, payload: { catalogs: [{ id, hosts }] } });
  let heldCalls = 0;
  const registry = createEmptyPluginRegistry();
  for (const catalogId of [heldCatalogId, completedCatalogId]) {
    registry.sessionCatalogs.push({
      pluginId: "catalog-sharing-proof",
      source: "test",
      provider: {
        id: catalogId,
        label: "Catalog sharing proof",
        audience: "gateway-operators",
        supportsProcessHomeIsolation: true,
        list: ({ search, onHost }) => {
          const operation = (async () => {
            if (search === "held") {
              heldCalls += 1;
              publishHeldHosts.push(() => onHost?.(host));
              started.resolve();
              await release.promise;
              return [host];
            }
            if (search === "after-follower") {
              for (const publish of publishHeldHosts) {
                publish();
              }
            }
            return [];
          })();
          providerRuns.push(operation);
          return operation;
        },
        read: async ({ hostId, threadId }) => ({ hostId, threadId, items: [] }),
      },
    });
  }
  setTestPluginRegistry(registry);
  const unblock = () => release.resolve();
  signal.addEventListener("abort", unblock, { once: true });
  let gateway: Awaited<ReturnType<typeof createGatewaySuiteHarness>> | undefined;
  let ws: WebSocket | undefined;
  let followerHost: Promise<unknown> | undefined;
  try {
    gateway = await createGatewaySuiteHarness({
      serverOptions: { bind: "loopback", auth: { mode: "token", token } },
    });
    await gateway.server.startupSettled;
    ws = await gateway.openWs();
    await connectOk(ws, { token, scopes: ["operator.admin"] });
    const socket = ws;
    const request = (catalogId: string, search: string, progressId?: string) => {
      const id = `catalog-${requests.length}`;
      const response = onceMessage<ResponseFrame>(
        socket,
        (frame) => frame.type === "res" && frame.id === id,
      );
      requests.push(response);
      const params = { catalogId, search, progressId };
      socket.send(JSON.stringify({ type: "req", id, method: "sessions.catalog.list", params }));
      return response;
    };
    const leader = request(heldCatalogId, "held", "leader-progress");
    await awaitGateBeforeSettlement(started.promise, leader, "provider admission");
    for (let index = 0; index < 128; index += 1) {
      expectCatalog(await request(completedCatalogId, `completed-${index}`), completedCatalogId);
    }
    followerHost = onceMessage(
      socket,
      (frame) =>
        frame.type === "event" &&
        frame.event === "sessions.catalog.host" &&
        frame.payload?.progressId === "follower-progress",
    );
    const follower = request(heldCatalogId, "held", "follower-progress");
    const [barrier, progress] = await Promise.all([
      request(completedCatalogId, "after-follower"),
      followerHost,
    ]);
    expectCatalog(barrier, completedCatalogId);
    expect(progress).toMatchObject({
      payload: {
        progressId: "follower-progress",
        catalog: { id: heldCatalogId, hosts: [host] },
      },
    });
    unblock();
    for (const response of await Promise.all([leader, follower])) {
      expectCatalog(response, heldCatalogId, [host]);
    }
    expect(heldCalls).toBe(1);
  } finally {
    unblock();
    await Promise.allSettled(providerRuns);
    ws?.terminate();
    await Promise.allSettled([...requests, followerHost]);
    await gateway?.server.close({ drainTimeoutMs: 0 });
    resetTestPluginRegistry();
    signal.removeEventListener("abort", unblock);
  }
});
