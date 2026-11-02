import { expect, it } from "vitest";
import type { WebSocket } from "ws";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import * as catalogs from "./server-methods/session-catalog.fixtures.test-support.js";
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
  const [started, release] = [createDeferred(), createDeferred()];
  const host = catalogs.catalogHost();
  const progressId = "follower-progress";
  const publishHeldHosts: Array<() => void> = [];
  const providerRuns: Promise<(typeof host)[]>[] = [];
  const requests: Array<ReturnType<typeof onceMessage>> = [];
  const expectCatalog = (response: unknown, id: string, hosts: (typeof host)[] = []) =>
    expect(response).toMatchObject({ ok: true, payload: { catalogs: [{ id, hosts }] } });
  let heldCalls = 0;
  const registry = createEmptyPluginRegistry();
  for (const catalogId of [heldCatalogId, completedCatalogId]) {
    registry.sessionCatalogs.push({
      pluginId: "catalog-sharing-proof",
      source: "test",
      provider: catalogs.catalogProvider(catalogId, {
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
              publishHeldHosts.forEach((publish) => publish());
            }
            return [];
          })();
          providerRuns.push(operation);
          return operation;
        },
      }),
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
    const request = (catalogId: string, search: string, progress?: string) => {
      const id = `catalog-${requests.length}`;
      const response = onceMessage(socket, (frame) => frame.type === "res" && frame.id === id);
      requests.push(response);
      const params = { catalogId, search, progressId: progress };
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
        frame.payload?.progressId === progressId,
    );
    const follower = request(heldCatalogId, "held", progressId);
    const [barrier, progress] = await Promise.all([
      request(completedCatalogId, "after-follower"),
      followerHost,
    ]);
    expectCatalog(barrier, completedCatalogId);
    expect(progress).toMatchObject({
      payload: { progressId, catalog: { id: heldCatalogId, hosts: [host] } },
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
