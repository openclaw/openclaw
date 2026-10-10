import { afterEach, expect, it } from "vitest";
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

// Plugin state keeps cause text out of its public message; the maintenance refusal is the cause.
async function expectOfflineMaintenance(operation: Promise<unknown>) {
  const error = await operation.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  const messages: string[] = [];
  for (let current: unknown = error; current instanceof Error; current = current.cause) {
    messages.push(current.message);
  }
  expect(messages.join("\n")).toContain("offline maintenance");
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
    lookup(key: string) {
      return lookupPluginStateInWorker({ ...namespace, key });
    },
    entries() {
      return listPluginStateInWorker(namespace);
    },
  };
}

it.each(["siblings", "nested"] as const)(
  "retains %s agent handles until their common Doctor owner releases",
  async (topology) => {
    await withOpenClawTestState(
      { scenario: "external-service", label: "maintenance-nested-resources" },
      async (state) => {
        const parent = await beginCaptureMaintenance("Doctor", state.env);
        try {
          const owned = await parent.run(async () => {
            const database =
              topology === "nested"
                ? openOpenClawAgentDatabase({ agentId: "owned", env: state.env })
                : undefined;
            const first = await beginCaptureMaintenance(
              topology === "siblings" ? "Doctor" : "Gateway lock",
              state.env,
            );
            const second =
              topology === "siblings" ? await beginCaptureMaintenance("Doctor", state.env) : first;
            try {
              const handle =
                database ??
                first.run(() => openOpenClawAgentDatabase({ agentId: "owned", env: state.env }));
              expect(
                second.run(() => openOpenClawAgentDatabase({ agentId: "owned", env: state.env })),
              ).toBe(handle);
              await first.release();
              await second.release();
              expect(handle.db.isOpen).toBe(true);
              return handle;
            } finally {
              await first.release();
              await second.release();
            }
          });
          await parent.release();
          expect(owned.db.isOpen).toBe(false);
        } finally {
          await parent.release();
        }
      },
    );
  },
);

it("settles its agent resource before closing the associated native handle", async () => {
  await withOpenClawTestState({ label: "maintenance-resource-order" }, async (state) => {
    const lock = await acquireGatewayLock({
      env: state.env,
      role: "sqlite-maintenance",
      allowInTests: true,
    });
    if (!lock) {
      throw new Error("Expected maintenance lock");
    }
    const observed: boolean[] = [];
    try {
      const owned = lock.run(() => {
        const database = openOpenClawAgentDatabase({ agentId: "owned", env: state.env });
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
      expect(observed).toEqual([true]);
      expect(owned.db.isOpen).toBe(false);
    } finally {
      await lock.release();
    }
  });
});

it("closes its created agent handle while preserving earlier and later runtime handles", async () => {
  await withOpenClawTestState({ label: "maintenance-native-resources" }, async (state) => {
    const earlier = openOpenClawAgentDatabase({ agentId: "earlier", env: state.env });
    const lock = await acquireGatewayLock({
      env: state.env,
      role: "sqlite-maintenance",
      allowInTests: true,
    });
    if (!lock) {
      throw new Error("Expected maintenance lock");
    }
    try {
      const owned = lock.run(() => openOpenClawAgentDatabase({ agentId: "owned", env: state.env }));
      await lock.release();
      const later = openOpenClawAgentDatabase({ agentId: "later", env: state.env });
      expect(owned.db.isOpen).toBe(false);
      expect(earlier.db.isOpen).toBe(true);
      expect(later.db.isOpen).toBe(true);
    } finally {
      await lock.release();
    }
  });
});

it.each(["new", "existing", "borrowed"] as const)(
  "preserves an independent shared client across maintenance release (%s)",
  async (mode) => {
    await withOpenClawTestState({ label: "maintenance-shared-resources" }, async (state) => {
      const store = createSharedWorkerClient(state.env);
      const earlier = mode === "borrowed" ? "foreign" : "earlier";
      if (mode !== "new") {
        await store.register(earlier, { value: earlier });
      }
      const lock = await beginCaptureMaintenance("Gateway lock", state.env);
      let borrowed:
        | {
            database: ReturnType<typeof openOpenClawStateDatabase>;
            reference: ReturnType<typeof retainOpenClawStateDatabase>;
          }
        | undefined;
      try {
        await lock.run(async () => {
          if (mode === "borrowed") {
            const database = openOpenClawStateDatabase({ env: state.env });
            borrowed = { database, reference: retainOpenClawStateDatabase(database) };
          }
          await store.register("owned", { value: "owned" });
        });
        await expectOfflineMaintenance(store.register("later", { value: "later" }));
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
      } finally {
        try {
          borrowed?.reference.release();
        } finally {
          await lock.release();
        }
      }
    });
  },
);

it.each(["Doctor", "Gateway lock"] as const)(
  "drains %s capture before releasing maintenance and preserves independent capture",
  async (producer) => {
    await withOpenClawTestState(
      { scenario: "external-service", label: "maintenance-capture-lifetime" },
      async (state) => {
        const settings = { ...resolveDebugProxySettings(state.env), enabled: true };
        const ownedSettings = { ...settings, sessionId: "maintenance-owned-capture" };
        const outsideSettings = { ...settings, sessionId: "outside-maintenance-capture" };
        const frame = (flowId: string, payload: string) => ({
          url: "wss://synthetic.invalid/capture",
          direction: "outbound" as const,
          kind: "ws-frame" as const,
          flowId,
          payload,
        });
        try {
          await captureWsEventAsync(frame("outside-before", "outside before"), outsideSettings);
          const maintenance = await beginCaptureMaintenance(producer, state.env);
          try {
            const writing = maintenance.run(() =>
              captureWsEventAsync(frame("owned", "owned capture bytes"), ownedSettings),
            );
            await maintenance.release();
            await writing;

            await captureWsEventAsync(frame("outside-after", "outside after"), outsideSettings);
            const reader = await acquireDebugProxyCaptureStoreAsync({ env: state.env });
            try {
              const sessions = await reader.store.listSessions();
              expect(
                sessions.find((session) => session.id === ownedSettings.sessionId),
              ).toMatchObject({
                endedAt: expect.any(Number),
                eventCount: 1,
              });
              expect(
                sessions.find((session) => session.id === outsideSettings.sessionId),
              ).toMatchObject({
                endedAt: null,
                eventCount: 2,
              });
              const ownedEvents = await reader.store.getSessionEvents(ownedSettings.sessionId);
              expect(ownedEvents).toEqual([
                expect.objectContaining({ flowId: "owned", dataText: "owned capture bytes" }),
              ]);
              const blobId = ownedEvents[0]!.dataBlobId;
              if (typeof blobId !== "string") {
                throw new Error("Expected captured payload blob");
              }
              expect(await reader.store.readBlob(blobId)).toBe("owned capture bytes");
              expect(
                (await reader.store.getSessionEvents(outsideSettings.sessionId)).map(
                  ({ flowId, dataText }) => ({ flowId, dataText }),
                ),
              ).toEqual([
                { flowId: "outside-after", dataText: "outside after" },
                { flowId: "outside-before", dataText: "outside before" },
              ]);
            } finally {
              await reader.release();
            }
          } finally {
            await maintenance.release();
          }
        } finally {
          try {
            await finalizeDebugProxyCaptureAsync(ownedSettings);
          } finally {
            await finalizeDebugProxyCaptureAsync(outsideSettings);
          }
        }
      },
    );
  },
);

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
  if (!maintenance) {
    throw new Error("Expected maintenance owner");
  }
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
  async (producer) => {
    await withOpenClawTestState(
      { scenario: "external-service", label: "maintenance-shared-capture-session" },
      async (state) => {
        const settings = {
          ...resolveDebugProxySettings(state.env),
          enabled: true,
          sessionId: "shared-maintenance-capture",
        };
        const captureBodyEofs = new WeakMap<Response, Promise<void>>();
        const target: typeof globalThis = {
          ...globalThis,
          fetch: async () => {
            const response = new Response("finite capture response", {
              status: 200,
              headers: { "content-type": "text/plain" },
            });
            const clone = response.clone.bind(response);
            response.clone = () => {
              const captured = clone();
              const eof = createDeferredCore();
              captureBodyEofs.set(response, eof.promise);
              const body = captured.body!.pipeThrough(
                new TransformStream<Uint8Array, Uint8Array>({
                  flush() {
                    eof.resolve();
                  },
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
          if (!captureEof) {
            throw new Error("Expected capture to clone the fixture response");
          }
          await captureEof;
        };
        let maintenance: Awaited<ReturnType<typeof beginCaptureMaintenance>> | undefined;
        try {
          await initializeDebugProxyCaptureAsync("outside", settings, deps);
          const patchedFetch = target.fetch;
          maintenance = await beginCaptureMaintenance(producer, state.env);
          await maintenance.run(() =>
            initializeDebugProxyCaptureAsync("maintenance", settings, deps),
          );
          await maintenance.run(() => fetchBody("maintenance-first"));
          await maintenance.release();
          expect(target.fetch).toBe(patchedFetch);
          await fetchBody("outside-second");

          const reader = await acquireDebugProxyCaptureStoreAsync({ env: state.env });
          try {
            expect(
              (await reader.store.listSessions()).find(
                (session) => session.id === settings.sessionId,
              ),
            ).toMatchObject({ endedAt: null });
            await fetchBody("outside-after-release");
            await finalizeDebugProxyCaptureAsync(settings, deps);
            expect(target.fetch).not.toBe(patchedFetch);

            const events = await reader.store.getSessionEvents(settings.sessionId);
            expect(events).toHaveLength(6);
            const paths = ["/maintenance-first", "/outside-second", "/outside-after-release"];
            const requestIds: number[] = [];
            for (const path of paths) {
              const request = events.find(
                (event) => event.path === path && event.kind === "request",
              );
              const response = events.find(
                (event) => event.path === path && event.kind === "response",
              );
              expect(request).toMatchObject({
                method: "POST",
                dataText: `request ${path.slice(1)}`,
              });
              expect(JSON.parse(String(request?.headersJson))).toMatchObject({
                "x-capture-phase": "accepted",
              });
              expect(response).toMatchObject({ status: 200, dataText: "finite capture response" });
              if (typeof request?.id !== "number" || typeof response?.id !== "number") {
                throw new Error("Expected persisted capture event IDs");
              }
              expect(request.id).toBeLessThan(response.id);
              expect(request.flowId).toBe(response.flowId);
              requestIds.push(request.id);
            }
            expect(requestIds[0]).toBeLessThan(requestIds[1]!);
            expect(requestIds[1]).toBeLessThan(requestIds[2]!);
            expect(
              (await reader.store.listSessions()).find(
                (session) => session.id === settings.sessionId,
              ),
            ).toMatchObject({ endedAt: expect.any(Number), eventCount: 6 });
          } finally {
            await reader.release();
          }
        } finally {
          try {
            await maintenance?.release();
          } finally {
            await finalizeDebugProxyCaptureAsync(settings, deps);
          }
        }
      },
    );
  },
);

it.each(["Doctor", "Gateway lock"] as const)(
  "drains the first capture created by an accepted callback after %s release begins",
  async (producer) => {
    await withOpenClawTestState(
      { scenario: "external-service", label: "maintenance-late-capture" },
      async (state) => {
        const settings = {
          ...resolveDebugProxySettings(state.env),
          enabled: true,
          sessionId: "late-maintenance-capture",
        };
        const maintenance = await beginCaptureMaintenance(producer, state.env);
        const entered = createDeferredCore();
        const resume = createDeferredCore();
        const accepted = maintenance.run(async () => {
          entered.resolve();
          await resume.promise;
          await captureWsEventAsync(maintenanceCaptureFrame("accepted-late-capture"), settings);
        });
        try {
          await entered.promise;
          const closing = maintenance.release();
          resume.resolve();
          await Promise.all([accepted, closing]);

          const reader = await acquireDebugProxyCaptureStoreAsync({ env: state.env });
          try {
            expect(
              (await reader.store.listSessions()).find(
                (session) => session.id === settings.sessionId,
              ),
            ).toMatchObject({ endedAt: expect.any(Number), eventCount: 1 });
            const events = await reader.store.getSessionEvents(settings.sessionId);
            expect(events).toEqual([
              expect.objectContaining({
                flowId: "accepted-late-capture",
                dataText: "bytes for accepted-late-capture",
              }),
            ]);
            const blobId = events[0]!.dataBlobId;
            if (typeof blobId !== "string") {
              throw new Error("Expected captured payload blob");
            }
            expect(await reader.store.readBlob(blobId)).toBe("bytes for accepted-late-capture");
          } finally {
            await reader.release();
          }
        } finally {
          resume.resolve();
          try {
            await accepted;
          } finally {
            await maintenance.release();
          }
        }
      },
    );
  },
);

it.each(["Doctor", "Gateway lock"] as const)(
  "ends the shared session before an outside fetch resolves after %s release",
  async (producer) => {
    await withOpenClawTestState(
      { scenario: "external-service", label: "maintenance-pending-outside-fetch" },
      async (state) => {
        const settings = {
          ...resolveDebugProxySettings(state.env),
          enabled: true,
          sessionId: "pending-outside-capture",
        };
        const transport = createDeferredCore<Response>();
        const response = new Response("late transport response", { status: 200 });
        const target: typeof globalThis = {
          ...globalThis,
          fetch: async () => await transport.promise,
        };
        const deps = { fetchTarget: target };
        let maintenance: Awaited<ReturnType<typeof beginCaptureMaintenance>> | undefined;
        let pending: Promise<Response> | undefined;
        try {
          await initializeDebugProxyCaptureAsync("outside", settings, deps);
          pending = target.fetch("https://synthetic.invalid/pending-outside");
          maintenance = await beginCaptureMaintenance(producer, state.env);
          await maintenance.run(() =>
            initializeDebugProxyCaptureAsync("maintenance", settings, deps),
          );
          await maintenance.release();
          await finalizeDebugProxyCaptureAsync(settings, deps);

          const reader = await acquireDebugProxyCaptureStoreAsync({ env: state.env });
          try {
            const ended = (await reader.store.listSessions()).find(
              (session) => session.id === settings.sessionId,
            );
            expect(ended).toMatchObject({ endedAt: expect.any(Number), eventCount: 0 });
            expect(await reader.store.getSessionEvents(settings.sessionId)).toEqual([]);

            transport.resolve(response);
            const delivered = await pending;
            expect(delivered).toBe(response);
            expect(delivered.status).toBe(200);
            expect(await delivered.text()).toBe("late transport response");
            expect(await reader.store.getSessionEvents(settings.sessionId)).toEqual([]);
            expect(
              (await reader.store.listSessions()).find(
                (session) => session.id === settings.sessionId,
              ),
            ).toEqual(ended);
          } finally {
            await reader.release();
          }
        } finally {
          transport.resolve(response);
          try {
            if (pending) {
              const delivered = await pending;
              if (!delivered.bodyUsed) {
                await delivered.text();
              }
            }
          } finally {
            try {
              await maintenance?.release();
            } finally {
              await finalizeDebugProxyCaptureAsync(settings, deps);
            }
          }
        }
      },
    );
  },
);
