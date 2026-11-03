import { setImmediate as nextEventLoopTurn } from "node:timers/promises";
import { afterEach, assert, expect, it } from "vitest";
import { beginDoctorMaintenance } from "../commands/doctor-maintenance.js";
import { acquireGatewayLock } from "../infra/gateway-lock.js";
import {
  listPluginStateInWorker,
  lookupPluginStateInWorker,
  registerPluginStateInWorker,
} from "../plugin-state/plugin-state-worker-client.js";
import { resolveDebugProxySettings } from "../proxy-capture/env.js";
import {
  captureWsEventAsync,
  finalizeDebugProxyCaptureAsync,
  initializeDebugProxyCaptureAsync,
} from "../proxy-capture/runtime.js";
import { acquireDebugProxyCaptureStoreAsync } from "../proxy-capture/store.async.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { registerOpenClawAgentDatabaseAsyncResource } from "./openclaw-agent-db-resources.js";
import {
  closeOpenClawAgentDatabasesAsync,
  openOpenClawAgentDatabase,
} from "./openclaw-agent-db.js";
import { retainOpenClawStateDatabase } from "./openclaw-state-db-cache.js";
import { closeOpenClawStateDatabaseAsync, openOpenClawStateDatabase } from "./openclaw-state-db.js";

afterEach(async () => {
  await closeOpenClawAgentDatabasesAsync();
  await closeOpenClawStateDatabaseAsync();
});

type Maintenance = Awaited<ReturnType<typeof beginCaptureMaintenance>>;
type CaptureStore = Awaited<ReturnType<typeof acquireDebugProxyCaptureStoreAsync>>["store"];

function withResources(
  run: (fixture: {
    env: NodeJS.ProcessEnv;
    agent: (agentId: string) => ReturnType<typeof openOpenClawAgentDatabase>;
    begin: (producer: CaptureMaintenanceProducer) => Promise<Maintenance>;
    capture: (sessionId: string) => ReturnType<typeof captureSettings>;
    read: (run: (store: CaptureStore) => Promise<void>) => Promise<void>;
    defer: (cleanup: () => Promise<void>) => void;
  }) => Promise<void>,
  scenario?: "external-service",
) {
  return withOpenClawTestState({ label: "maintenance-resources", scenario }, async ({ env }) => {
    await using cleanup = new AsyncDisposableStack();
    await run({
      env,
      agent: (agentId) => openOpenClawAgentDatabase({ agentId, env }),
      async begin(producer) {
        const owner = await beginCaptureMaintenance(producer, env);
        cleanup.defer(() => owner.release());
        return owner;
      },
      capture(sessionId) {
        const settings = captureSettings(env, sessionId);
        cleanup.defer(() => finalizeDebugProxyCaptureAsync(settings));
        return settings;
      },
      async read(consume) {
        const reader = await acquireDebugProxyCaptureStoreAsync({ env });
        cleanup.defer(() => reader.release());
        await consume(reader.store);
      },
      defer: (close) => cleanup.defer(close),
    });
  });
}

function withExternalResources(run: Parameters<typeof withResources>[0]) {
  return withResources(run, "external-service");
}

async function expectSession(store: CaptureStore, id: string, expected: object) {
  expect((await store.listSessions()).find((session) => session.id === id)).toMatchObject(expected);
}

// Plugin state keeps cause text out of its public message; the maintenance refusal is the cause.
async function expectMissingMaintenanceScope(operation: Promise<unknown>) {
  const error = await operation.then(() => undefined).catch((caught: unknown) => caught);
  const messages: string[] = [];
  for (let current: unknown = error; current instanceof Error; current = current.cause) {
    messages.push(current.message);
  }
  expect(messages.join("\n")).toContain("without an active schema lease or maintenance scope");
}

function createSharedWorkerClient(env: NodeJS.ProcessEnv) {
  const namespace = { env, pluginId: "maintenance-resources-fixture", namespace: "shared" };
  return {
    register(key: string, value: { value: string }) {
      return registerPluginStateInWorker({
        ...namespace,
        key,
        valueJson: JSON.stringify(value),
        maxEntries: 10,
        overflowPolicy: "reject-new",
      });
    },
    lookup: (key: string) => lookupPluginStateInWorker({ ...namespace, key }),
    entries: () => listPluginStateInWorker(namespace),
  };
}

it.each(["siblings", "nested"] as const)(
  "retains %s agent handles until their common Doctor owner releases",
  (topology) =>
    withExternalResources(async ({ agent, begin }) => {
      const parent = await begin("Doctor");
      const owned = await parent.run(async () => {
        const database = topology === "nested" ? agent("owned") : undefined;
        const first = await begin(topology === "siblings" ? "Doctor" : "Gateway lock");
        const second = topology === "siblings" ? await begin("Doctor") : first;
        const handle = database ?? first.run(() => agent("owned"));
        expect(second.run(() => agent("owned"))).toBe(handle);
        await first.release();
        await second.release();
        expect(handle.db.isOpen).toBe(true);
        return handle;
      });
      await parent.release();
      expect(owned.db.isOpen).toBe(false);
    }),
);

it("settles its agent resource before closing the associated native handle", () =>
  withResources(async ({ agent, begin }) => {
    const earlier = agent("earlier");
    const lock = await begin("Gateway lock");
    const observed: boolean[] = [];
    const owned = lock.run(() => {
      const database = agent("owned");
      const unregister = registerOpenClawAgentDatabaseAsyncResource({
        agentId: database.agentId,
        path: database.path,
        revoke() {},
        async close() {
          await Promise.resolve();
          observed.push(database.db.isOpen);
          unregister();
        },
      });
      return database;
    });
    await lock.release();
    expect({ observed, isOpen: owned.db.isOpen }).toEqual({ observed: [true], isOpen: false });
    const later = agent("later");
    expect([owned, earlier, later].map(({ db }) => db.isOpen)).toEqual([false, true, true]);
  }));

it.each(["new", "existing", "borrowed"] as const)(
  "preserves an independent shared client across maintenance release (%s)",
  (mode) =>
    withResources(async ({ env, begin, defer }) => {
      const store = createSharedWorkerClient(env);
      const earlier = mode === "borrowed" ? "foreign" : "earlier";
      if (mode !== "new") {
        await store.register(earlier, { value: earlier });
      }
      const lock = await begin("Gateway lock");
      const borrowed = await lock.run(async () => {
        const database = mode === "borrowed" ? openOpenClawStateDatabase({ env }) : undefined;
        const reference = database && retainOpenClawStateDatabase(database);
        defer(async () => reference?.release());
        await store.register("owned", { value: "owned" });
        return database && reference ? { database, reference } : undefined;
      });
      await expectMissingMaintenanceScope(store.register("later", { value: "later" }));
      if (borrowed) {
        borrowed.reference.release();
        expect(borrowed.database.db.isOpen).toBe(false);
      }
      await lock.release();
      if (borrowed) {
        expect(borrowed.database.db.isOpen).toBe(false);
        await expect(store.lookup("foreign")).resolves.toEqual({ value: "foreign" });
      }
      await store.register("later", { value: "later" });
      await store.register("after", { value: "after" });
      await expect(store.lookup("after")).resolves.toEqual({ value: "after" });
      expect((await store.entries()).map((entry) => entry.key).toSorted()).toEqual(
        [...(mode === "new" ? [] : [earlier]), "after", "later", "owned"].toSorted(),
      );
    }),
);

it.each(["Doctor", "Gateway lock"] as const)(
  "drains %s capture before releasing maintenance and preserves independent capture",
  (producer) =>
    withExternalResources(async ({ begin, capture, read }) => {
      const owned = capture("maintenance-owned-capture");
      const outside = capture("outside-maintenance-capture");
      await captureWsEventAsync(maintenanceCaptureFrame("outside-before"), outside);
      const maintenance = await begin(producer);
      const writing = maintenance.run(() =>
        captureWsEventAsync(maintenanceCaptureFrame("owned"), owned),
      );
      await maintenance.release();
      await writing;

      await captureWsEventAsync(maintenanceCaptureFrame("outside-after"), outside);
      await read(async (store) => {
        await expectSession(store, owned.sessionId, {
          endedAt: expect.any(Number),
          eventCount: 1,
        });
        await expectSession(store, outside.sessionId, {
          endedAt: null,
          eventCount: 2,
        });
        await expectCapturedPayload(store, owned.sessionId, "owned");
        expect(await store.getSessionEvents(outside.sessionId)).toMatchObject([
          { flowId: "outside-after", dataText: "bytes for outside-after" },
          { flowId: "outside-before", dataText: "bytes for outside-before" },
        ]);
      });
    }),
);

function captureSettings(env: NodeJS.ProcessEnv, sessionId: string) {
  return { ...resolveDebugProxySettings(env), enabled: true, sessionId };
}

async function expectCapturedPayload(store: CaptureStore, sessionId: string, flowId: string) {
  const dataText = `bytes for ${flowId}`;
  const events = await store.getSessionEvents(sessionId);
  expect(events).toEqual([expect.objectContaining({ flowId, dataText })]);
  const blobId = events[0]!.dataBlobId;
  assert(typeof blobId === "string", "Expected captured payload blob");
  expect(await store.readBlob(blobId)).toBe(dataText);
}

type CaptureMaintenanceProducer = "Doctor" | "Gateway lock";

async function beginCaptureMaintenance(
  producer: CaptureMaintenanceProducer,
  env: NodeJS.ProcessEnv,
) {
  const maintenance =
    producer === "Doctor"
      ? await beginDoctorMaintenance({
          options: { repair: true },
          root: null,
          runtime: { log() {}, error() {}, exit() {} },
        })
      : await acquireGatewayLock({ env, role: "sqlite-maintenance", allowInTests: true });
  assert(maintenance, "Expected maintenance owner");
  return maintenance;
}

function maintenanceCaptureFrame(flowId: string) {
  return {
    url: "wss://synthetic.invalid/capture",
    direction: "outbound" as const,
    kind: "ws-frame" as const,
    flowId,
    payload: `bytes for ${flowId}`,
  };
}

it.each(["Doctor", "Gateway lock"] as const)(
  "preserves the session fetch patch for outside requests after %s release",
  (producer) =>
    withExternalResources(async ({ env, begin, defer, read }) => {
      const settings = captureSettings(env, "shared-maintenance-capture");
      const captureBodyEofs = new WeakMap<Response, Promise<void>>();
      const target: typeof globalThis = {
        ...globalThis,
        fetch: async () => {
          const response = new Response("finite capture response");
          const clone = response.clone.bind(response);
          response.clone = () => {
            const captured = clone();
            const eof = createDeferredCore();
            captureBodyEofs.set(response, eof.promise);
            const body = captured.body!.pipeThrough(
              new TransformStream<Uint8Array, Uint8Array>({
                flush: () => eof.resolve(),
              }),
            );
            return new Response(body, { status: captured.status, headers: captured.headers });
          };
          return response;
        },
      };
      const deps = { fetchTarget: target };
      const fetchBody = async (label: string) => {
        const bytes = Buffer.from(`request ${label}`);
        const headers = { "x-capture-phase": "accepted" };
        const requested = target.fetch(`https://synthetic.invalid/${label}`, {
          method: "POST",
          headers,
          body: bytes,
        });
        bytes.fill(0);
        headers["x-capture-phase"] = "mutated";
        const response = await requested;
        expect(await response.text()).toBe("finite capture response");
        const captureEof = captureBodyEofs.get(response);
        assert(captureEof, "Expected capture to clone the fixture response");
        await captureEof;
        // TransformStream flush resolves before the consumer observes its terminal read.
        // Let capture record EOF before this fixture can begin maintenance finalization.
        await nextEventLoopTurn();
      };
      defer(() => finalizeDebugProxyCaptureAsync(settings, deps));
      await initializeDebugProxyCaptureAsync("outside", settings, deps);
      const patchedFetch = target.fetch;
      const maintenance = await begin(producer);
      await maintenance.run(() => initializeDebugProxyCaptureAsync("maintenance", settings, deps));
      await maintenance.run(() => fetchBody("maintenance-first"));
      await maintenance.release();
      expect(target.fetch).toBe(patchedFetch);
      await fetchBody("outside-second");

      await read(async (store) => {
        await expectSession(store, settings.sessionId, { endedAt: null });
        await fetchBody("outside-after-release");
        await finalizeDebugProxyCaptureAsync(settings, deps);
        expect(target.fetch).not.toBe(patchedFetch);

        const events = await store.getSessionEvents(settings.sessionId);
        expect(events).toHaveLength(6);
        const paths = ["/maintenance-first", "/outside-second", "/outside-after-release"];
        const requestIds: number[] = [];
        for (const path of paths) {
          const request = events.find((event) => event.path === path && event.kind === "request");
          const response = events.find((event) => event.path === path && event.kind === "response");
          expect(request).toMatchObject({
            method: "POST",
            dataText: `request ${path.slice(1)}`,
          });
          expect(JSON.parse(String(request?.headersJson))).toMatchObject({
            "x-capture-phase": "accepted",
          });
          expect(response).toMatchObject({ status: 200, dataText: "finite capture response" });
          assert(typeof request?.id === "number" && typeof response?.id === "number");
          expect(request.id).toBeLessThan(response.id);
          expect(request.flowId).toBe(response.flowId);
          requestIds.push(request.id);
        }
        expect(requestIds[0]).toBeLessThan(requestIds[1]!);
        expect(requestIds[1]).toBeLessThan(requestIds[2]!);
        await expectSession(store, settings.sessionId, {
          endedAt: expect.any(Number),
          eventCount: 6,
        });
      });
    }),
);

it.each(["Doctor", "Gateway lock"] as const)(
  "drains the first capture created by an accepted callback after %s release begins",
  (producer) =>
    withExternalResources(async ({ env, begin, defer, read }) => {
      const settings = captureSettings(env, "late-maintenance-capture");
      const maintenance = await begin(producer);
      const entered = createDeferredCore();
      const resume = createDeferredCore();
      const accepted = maintenance.run(async () => {
        entered.resolve();
        await resume.promise;
        await captureWsEventAsync(maintenanceCaptureFrame("accepted-late-capture"), settings);
      });
      defer(async () => {
        resume.resolve();
        await accepted;
      });
      await entered.promise;
      const closing = maintenance.release();
      resume.resolve();
      await Promise.all([accepted, closing]);

      await read(async (store) => {
        await expectSession(store, settings.sessionId, {
          endedAt: expect.any(Number),
          eventCount: 1,
        });
        await expectCapturedPayload(store, settings.sessionId, "accepted-late-capture");
      });
    }),
);

it.each(["Doctor", "Gateway lock"] as const)(
  "ends the shared session before an outside fetch resolves after %s release",
  (producer) =>
    withExternalResources(async ({ env, defer, read }) => {
      const settings = captureSettings(env, "pending-outside-capture");
      const transport = createDeferredCore<Response>();
      const response = new Response("late transport response", { status: 200 });
      const target: typeof globalThis = {
        ...globalThis,
        fetch: async () => await transport.promise,
      };
      const deps = { fetchTarget: target };
      defer(() => finalizeDebugProxyCaptureAsync(settings, deps));
      await initializeDebugProxyCaptureAsync("outside", settings, deps);
      const pending = target.fetch("https://synthetic.invalid/pending-outside");
      let maintenance: Maintenance | undefined = undefined;
      defer(async () => {
        await maintenance?.release();
      });
      defer(async () => {
        transport.resolve(response);
        const delivered = await pending;
        if (!delivered.bodyUsed) {
          await delivered.text();
        }
      });
      maintenance = await beginCaptureMaintenance(producer, env);
      await maintenance.run(() => initializeDebugProxyCaptureAsync("maintenance", settings, deps));
      await maintenance.release();
      await finalizeDebugProxyCaptureAsync(settings, deps);

      await read(async (store) => {
        const ended = (await store.listSessions()).find(
          (session) => session.id === settings.sessionId,
        );
        expect(ended).toMatchObject({ endedAt: expect.any(Number), eventCount: 0 });
        expect(await store.getSessionEvents(settings.sessionId)).toEqual([]);

        transport.resolve(response);
        const delivered = await pending;
        expect(delivered).toBe(response);
        expect(delivered.status).toBe(200);
        expect(await delivered.text()).toBe("late transport response");
        expect(await store.getSessionEvents(settings.sessionId)).toEqual([]);
        expect(
          (await store.listSessions()).find((session) => session.id === settings.sessionId),
        ).toEqual(ended);
      });
    }),
);
