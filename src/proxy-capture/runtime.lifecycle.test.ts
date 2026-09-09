import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchWithSsrFGuard } from "../infra/net/fetch-guard.js";
import { registerSecretValueForRedaction } from "../logging/secret-redaction-registry.js";
import { resetSecretRedactionRegistryForTest } from "../logging/secret-redaction-registry.test-support.js";
import { createDeferredCore } from "../shared/deferred.js";
import { closeOpenClawStateDatabaseByPath } from "../state/openclaw-state-db.js";
import { resolveDebugProxySettings, type DebugProxySettings } from "./env.js";
import {
  captureHttpExchange,
  captureWsEvent,
  finalizeDebugProxyCapture,
  initializeDebugProxyCapture,
  prepareHttpCapture,
  type DebugProxyCaptureRuntimeDeps,
} from "./runtime.js";
import {
  acquireDebugProxyCaptureStore,
  closeDebugProxyCaptureStore,
  DebugProxyCaptureStore,
  persistEventPayload,
} from "./store.sqlite.js";
import type { CaptureEventRecord } from "./types.js";

const roots: string[] = [];
afterEach(() => {
  closeDebugProxyCaptureStore();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  resetSecretRedactionRegistryForTest();
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function stateRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "capture-lifecycle-"));
  roots.push(root);
  return root;
}

function captureSettings(root: string, sessionId = "lifecycle"): DebugProxySettings {
  return {
    enabled: true,
    required: false,
    dbPath: path.join(root, "capture.sqlite"),
    blobDir: path.join(root, "blobs"),
    certDir: path.join(root, "certs"),
    sessionId,
    sourceProcess: "fixture",
  };
}

function observePendingCapture(response: Response, prefixChunks: number) {
  const pending = createDeferredCore();
  const settled = createDeferredCore();
  const clone = response.clone.bind(response);
  vi.spyOn(response, "clone").mockImplementation(() => {
    const captured = clone();
    const reader = captured.body!.getReader();
    const read = reader.read.bind(reader);
    let reads = 0;
    vi.spyOn(reader, "read").mockImplementation(() => {
      reads += 1;
      const last = reads === prefixChunks + 1;
      if (last) {
        pending.resolve();
      }
      return read().finally(() => {
        if (last) {
          settled.resolve();
        }
      });
    });
    vi.spyOn(captured.body!, "getReader").mockReturnValue(reader);
    return captured;
  });
  return { pending: pending.promise, settled: settled.promise };
}

function pendingResponse(chunks: Buffer[]) {
  let controller: ReadableStreamDefaultController<Uint8Array>;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(value) {
        controller = value;
        for (const chunk of chunks) {
          controller.enqueue(chunk);
        }
      },
    }),
    { status: 200, headers: { "content-type": "text/plain" } },
  );
  return { response, controller: controller!, ...observePendingCapture(response, chunks.length) };
}

describe("capture store lifecycle", () => {
  it.each(
    (["shared", "legacy"] as const).flatMap((storage) =>
      (["direct", "last-lease"] as const).map((close) => ({ storage, close })),
    ),
  )("settles bytes once before $storage $close close", async ({ storage, close }) => {
    const root = stateRoot();
    const settings = captureSettings(root);
    const acquire = () =>
      storage === "shared"
        ? acquireDebugProxyCaptureStore({ env: { OPENCLAW_STATE_DIR: root } })
        : acquireDebugProxyCaptureStore(settings.dbPath, settings.blobDir);
    const lease = acquire();
    const sibling = acquire();
    const store = lease.store;
    const getStore = vi.fn(() => store);
    const deps: DebugProxyCaptureRuntimeDeps = {
      getStore,
      persistEventPayload: (_store, payload) => persistEventPayload(store, payload),
    };
    registerSecretValueForRedaction("fixture-secret-value");
    const bytes = Buffer.from("first fixture-secret-value caf\u00e9");
    const stream = pendingResponse([
      bytes.subarray(0, 15),
      bytes.subarray(15, -1),
      bytes.subarray(-1),
    ]);
    const terminals: CaptureEventRecord[] = [];
    const record = store.recordEvent.bind(store);
    const recording = vi.spyOn(store, "recordEvent").mockImplementation((event) => {
      expect(store.isClosed).toBe(false);
      record(event);
      if (event.kind !== "request") {
        terminals.push(event);
      }
    });
    const end = vi.spyOn(store, "endSession");
    try {
      store.upsertSession({
        id: settings.sessionId,
        startedAt: Date.now(),
        mode: "fixture",
        sourceScope: "openclaw",
        sourceProcess: "fixture",
      });
      captureHttpExchange(
        { url: "https://example.test/pending", method: "GET", response: stream.response },
        settings,
        deps,
      );
      await stream.pending;
      lease.release();
      expect(store.isClosed).toBe(false);
      expect(terminals).toHaveLength(0);
      if (close === "direct") {
        store.close();
      } else {
        sibling.release();
      }
      expect(store.isClosed).toBe(true);
      expect(terminals).toHaveLength(1);
      expect(terminals[0]).toMatchObject({
        kind: "response",
        status: 200,
        dataText: "first [REDACTED] caf\u00e9",
      });
      expect(JSON.parse(terminals[0]!.metaJson!)).toMatchObject({ bodyCapture: "finalized" });
      expect(end).toHaveBeenCalledExactlyOnceWith(settings.sessionId);

      stream.controller.enqueue(Buffer.from("-later"));
      stream.controller.close();
      expect(await stream.response.text()).toBe(`${bytes.toString()}-later`);
      await stream.settled;
      finalizeDebugProxyCapture(settings, deps);
      store.close();
      sibling.release();
      expect(terminals).toHaveLength(1);
      expect(end).toHaveBeenCalledTimes(1);
      expect(getStore).toHaveBeenCalledTimes(1);

      const reopened = acquire();
      try {
        expect(reopened.store.listSessions()[0]?.endedAt).toBeTypeOf("number");
        expect(reopened.store.getSessionEvents(settings.sessionId)).toHaveLength(2);
        expect(reopened.store.readBlob(terminals[0]!.dataBlobId!)).toBe(
          "first [REDACTED] caf\u00e9",
        );
      } finally {
        reopened.release();
      }
    } finally {
      recording.mockRestore();
      lease.release();
      sibling.release();
      store.close();
      closeOpenClawStateDatabaseByPath(store.dbPath);
    }
  });

  it.each(["eof", "error", "finalize"] as const)(
    "records one terminal through a pending-read %s race",
    async (mode) => {
      const root = stateRoot();
      const settings = captureSettings(root);
      const store = new DebugProxyCaptureStore({ env: { OPENCLAW_STATE_DIR: root } });
      const deps: DebugProxyCaptureRuntimeDeps = { getStore: () => store };
      const stream = pendingResponse([Buffer.from("prefix")]);
      const terminals: CaptureEventRecord[] = [];
      const done = createDeferredCore();
      const record = store.recordEvent.bind(store);
      vi.spyOn(store, "recordEvent").mockImplementation((event) => {
        record(event);
        if (event.kind !== "request") {
          terminals.push(event);
          done.resolve();
        }
      });
      registerSecretValueForRedaction("fixture-error-secret");
      const reason = new Error("fixture read failure: fixture-error-secret");
      try {
        captureHttpExchange(
          { url: "https://example.test/race", method: "GET", response: stream.response },
          settings,
          deps,
        );
        await stream.pending;
        if (mode === "eof") {
          stream.controller.close();
        } else if (mode === "error") {
          stream.controller.error(reason);
        } else {
          finalizeDebugProxyCapture(settings, deps);
          stream.controller.error(reason);
        }
        await done.promise;
        await stream.settled;
        expect(terminals).toHaveLength(1);
        expect(terminals[0]).toMatchObject({
          kind: mode === "error" ? "error" : "response",
          status: 200,
          dataText: "prefix",
        });
        if (mode === "error") {
          expect(terminals[0]).toMatchObject({ errorText: "fixture read failure: [REDACTED]" });
          expect(JSON.parse(terminals[0]!.metaJson!)).toMatchObject({
            bodyCapture: "failed",
            stage: "response-body",
          });
        }
        finalizeDebugProxyCapture(settings, deps);
        expect(terminals).toHaveLength(1);
      } finally {
        await stream.response.body?.cancel().catch(() => undefined);
        store.close();
        closeOpenClawStateDatabaseByPath(store.dbPath);
      }
    },
  );

  it.each(["blob", "event"] as const)(
    "settles sibling reads and closes after one terminal %s persistence fails",
    async (surface) => {
      const root = stateRoot();
      const settings = captureSettings(root);
      const store = new DebugProxyCaptureStore({ env: { OPENCLAW_STATE_DIR: root } });
      const deps: DebugProxyCaptureRuntimeDeps = { getStore: () => store };
      const streams = [
        pendingResponse([Buffer.from("one")]),
        pendingResponse([Buffer.from("two")]),
      ];
      const failure = new Error("fixture storage failure");
      const attempted: string[] = [];
      if (surface === "blob") {
        const persist = store.persistPayload.bind(store);
        vi.spyOn(store, "persistPayload").mockImplementation((data, contentType) => {
          if (data.toString() === "one") {
            throw failure;
          }
          return persist(data, contentType);
        });
      }
      const record = store.recordEvent.bind(store);
      vi.spyOn(store, "recordEvent").mockImplementation((event) => {
        if (event.kind !== "request") {
          attempted.push(event.flowId);
          if (surface === "event" && event.flowId === "one") {
            throw failure;
          }
        }
        record(event);
      });
      try {
        for (const [index, stream] of streams.entries()) {
          captureHttpExchange(
            {
              url: "https://example.test/sibling",
              method: "GET",
              response: stream.response,
              flowId: index === 0 ? "one" : "two",
            },
            settings,
            deps,
          );
        }
        await Promise.all(streams.map((stream) => stream.pending));
        let error: unknown;
        try {
          finalizeDebugProxyCapture(settings, deps);
        } catch (caught) {
          error = caught;
        }
        expect(error).toBeInstanceOf(AggregateError);
        expect((error as AggregateError).errors[0].errors).toContain(failure);
        expect(store.isClosed).toBe(true);
        expect(attempted).toEqual(surface === "blob" ? ["two"] : ["one", "two"]);
        finalizeDebugProxyCapture(settings, deps);
        expect(attempted).toEqual(surface === "blob" ? ["two"] : ["one", "two"]);
      } finally {
        for (const stream of streams) {
          stream.controller.close();
          await stream.response.body?.cancel();
          await stream.settled;
        }
        store.close();
        closeOpenClawStateDatabaseByPath(store.dbPath);
      }
    },
  );

  it("does not revive a retired database while finalizing its retained owner", async () => {
    const root = stateRoot();
    const settings = captureSettings(root);
    const store = new DebugProxyCaptureStore({ env: { OPENCLAW_STATE_DIR: root } });
    const getStore = vi.fn(() => store);
    const deps: DebugProxyCaptureRuntimeDeps = { getStore };
    const stream = pendingResponse([Buffer.from("prefix")]);
    try {
      captureHttpExchange(
        { url: "https://example.test/retired", method: "GET", response: stream.response },
        settings,
        deps,
      );
      await stream.pending;
      closeOpenClawStateDatabaseByPath(store.dbPath);
      expect(store.isClosed).toBe(true);
      expect(() => finalizeDebugProxyCapture(settings, deps)).toThrow(AggregateError);
      expect(() => finalizeDebugProxyCapture(settings, deps)).not.toThrow();
      expect(getStore).toHaveBeenCalledTimes(1);
      expect(store.db.isOpen).toBe(false);
    } finally {
      stream.controller.close();
      await stream.response.body?.cancel();
      await stream.settled;
      store.close();
    }
  });

  it.each(
    (["shared", "legacy"] as const).flatMap((storage) =>
      (["none", "blob", "event"] as const).map((failure) => ({ storage, failure })),
    ),
  )(
    "ends the $storage session and reports $failure failure before CLI exit finalization",
    ({ storage, failure }) => {
      const root = stateRoot();
      const settings = captureSettings(root);
      const runtimeUrl = new URL("./runtime.ts", import.meta.url).href;
      const storeUrl = new URL("./store.sqlite.ts", import.meta.url).href;
      const redactionUrl = new URL("../logging/secret-redaction-registry.ts", import.meta.url).href;
      const script = `
        import assert from "node:assert/strict";
        import { captureHttpExchange, initializeDebugProxyCapture, finalizeDebugProxyCapture } from ${JSON.stringify(runtimeUrl)};
        import { getDebugProxyCaptureStore } from ${JSON.stringify(storeUrl)};
        import { registerSecretValueForRedaction } from ${JSON.stringify(redactionUrl)};
        const settings = ${JSON.stringify(settings)};
        const store = ${storage === "shared" ? "getDebugProxyCaptureStore()" : "getDebugProxyCaptureStore(settings.dbPath, settings.blobDir)"};
        const failure = ${JSON.stringify(failure)};
        registerSecretValueForRedaction("fixture-storage-secret");
        const error = new Error("fixture " + failure + " persistence failure: fixture-storage-secret");
        let acquired = 0, terminals = 0, ended = 0, failures = 0;
        const persist = store.persistPayload.bind(store);
        store.persistPayload = (data, contentType) => {
          if (failure === "blob" && data?.toString() === "prefix-one") {
            failures++;
            throw error;
          }
          return persist(data, contentType);
        };
        const record = store.recordEvent.bind(store);
        store.recordEvent = event => {
          assert.equal(store.isClosed, false);
          if (failure === "event" && event.kind !== "request" && event.flowId === "one") {
            failures++;
            throw error;
          }
          record(event);
          if (event.kind !== "request") terminals++;
        };
        const end = store.endSession.bind(store);
        store.endSession = id => { ended++; end(id); };
        const deps = { getStore: () => { acquired++; return store; } };
        initializeDebugProxyCapture("fixture", settings, deps);
        for (const flowId of ["one", "two"]) {
          const response = new Response(new ReadableStream({
            start(controller) { controller.enqueue(new TextEncoder().encode("prefix-" + flowId)); }
          }));
          const clone = response.clone.bind(response);
          let pending, reads = 0;
          const ready = new Promise(resolve => pending = resolve);
          response.clone = () => {
            const cloned = clone();
            const reader = cloned.body.getReader();
            const read = reader.read.bind(reader);
            reader.read = () => { if (++reads === 2) pending(); return read(); };
            cloned.body.getReader = () => reader;
            return cloned;
          };
          captureHttpExchange({ url: "https://example.test/exit", method: "GET", response, flowId }, settings, deps);
          await ready;
        }
        process.once("exit", () => {
          assert.equal(store.isClosed, true);
          finalizeDebugProxyCapture(settings, deps);
          finalizeDebugProxyCapture(settings, deps);
          assert.equal(acquired, 1);
          assert.equal(terminals, failure === "none" ? 2 : 1);
          assert.equal(ended, 1);
          assert.equal(failures, failure === "none" ? 0 : 1);
          process.stdout.write(JSON.stringify({ acquired, terminals, ended, failures }));
        });
        process.exit(0);
      `;
      const child = spawnSync(
        process.execPath,
        [
          "--disable-warning=ExperimentalWarning",
          "--import",
          "tsx",
          "--input-type=module",
          "-e",
          script,
        ],
        {
          cwd: process.cwd(),
          env: { ...process.env, OPENCLAW_STATE_DIR: root },
          encoding: "utf8",
          timeout: 20_000,
        },
      );
      expect(child.stderr).toBe(
        failure === "none"
          ? ""
          : `[proxy-capture] Capture persistence failed: fixture ${failure} persistence failure: [REDACTED]\n`,
      );
      expect(child.status).toBe(0);
      expect(JSON.parse(child.stdout)).toEqual({
        acquired: 1,
        terminals: failure === "none" ? 2 : 1,
        ended: 1,
        failures: failure === "none" ? 0 : 1,
      });
      const reopened =
        storage === "shared"
          ? new DebugProxyCaptureStore({ env: { OPENCLAW_STATE_DIR: root } })
          : new DebugProxyCaptureStore(settings.dbPath, settings.blobDir);
      try {
        expect(reopened.listSessions()[0]?.endedAt).toBeTypeOf("number");
        const events = reopened.getSessionEvents(settings.sessionId);
        expect(events).toHaveLength(failure === "none" ? 4 : 3);
        expect(events[0]).toMatchObject({ kind: "response", dataText: "prefix-two" });
      } finally {
        reopened.close();
        closeOpenClawStateDatabaseByPath(reopened.dbPath);
      }
    },
  );
});

describe("capture admission generation", () => {
  it.each([
    [0, 1],
    [1, 0],
  ] as const)(
    "isolates same-session databases when finalizing %s before %s",
    async (first, second) => {
      const envs = [stateRoot(), stateRoot()].map((root) => ({
        OPENCLAW_STATE_DIR: root,
        OPENCLAW_DEBUG_PROXY_ENABLED: "1",
      }));
      const settings = envs.map((env) => resolveDebugProxySettings(env));
      expect(settings[0]!.sessionId).toBe(settings[1]!.sessionId);
      expect(settings[0]!.dbPath).not.toBe(settings[1]!.dbPath);
      const stores = envs.map((env) => new DebugProxyCaptureStore({ env }));
      let selected = stores[0]!;
      const getStore = vi.fn(() => selected);
      const deps = { getStore };
      const recordings = stores.map((store) => vi.spyOn(store, "recordEvent"));
      const streams = stores.map((_, index) => pendingResponse([Buffer.from(`database-${index}`)]));
      const admissions = settings.map((value, index) => {
        selected = stores[index]!;
        return prepareHttpCapture(value, deps)!;
      });
      try {
        for (const [index, capture] of admissions.entries()) {
          capture({
            url: "https://example.test/identity",
            method: "POST",
            flowId: `database-${index}`,
            requestBody: `request-${index}`,
            response: streams[index]!.response,
          });
        }
        await Promise.all(streams.map((stream) => stream.pending));
        expect(
          stores.map((store, index) =>
            store.getSessionEvents(settings[index]!.sessionId).map((event) => event.flowId),
          ),
        ).toEqual([["database-0"], ["database-1"]]);
        expect(getStore).toHaveBeenCalledTimes(2);
        getStore.mockImplementation(() => {
          throw new Error("Existing-owner lookup or finalization acquired a store.");
        });
        for (const index of [first, second]) {
          const fresh = resolveDebugProxySettings(envs[index]);
          captureWsEvent(
            {
              url: "wss://example.test/identity",
              direction: "inbound",
              kind: "ws-frame",
              flowId: `database-${index}`,
              payload: "before-close",
            },
            fresh,
            deps,
          );
          expect(recordings[index]!.mock.lastCall?.[0].kind).toBe("ws-frame");
          finalizeDebugProxyCapture(fresh, deps);
          expect(stores[index]!.isClosed).toBe(true);
          const terminals = recordings[index]!.mock.calls.map(([event]) => event).filter(
            (event) => event.kind === "response",
          );
          expect(terminals).toHaveLength(1);
          expect(terminals[0]).toMatchObject({
            flowId: `database-${index}`,
            dataText: `database-${index}`,
          });
          const recorded = recordings[index]!.mock.calls.length;
          admissions[index]!({
            url: "https://example.test/delayed",
            method: "GET",
            response: new Response("late"),
          });
          expect(recordings[index]).toHaveBeenCalledTimes(recorded);
          if (index === first) {
            expect(stores[second]!.isClosed).toBe(false);
            expect(
              recordings[second]!.mock.calls.some(([event]) => event.kind === "response"),
            ).toBe(false);
          }
          finalizeDebugProxyCapture(resolveDebugProxySettings(envs[index]), deps);
        }
        expect(getStore).toHaveBeenCalledTimes(2);
      } finally {
        for (const [index, stream] of streams.entries()) {
          finalizeDebugProxyCapture(settings[index], deps);
          stream.controller.close();
          await stream.response.body?.cancel();
          await stream.settled;
          stores[index]!.close();
          closeOpenClawStateDatabaseByPath(stores[index]!.dbPath);
        }
      }
    },
  );

  it.each(["explicit", "ambient"] as const)(
    "preserves fresh %s lazy sessions without reopening retired admission",
    (mode) => {
      const root = stateRoot();
      let settings = captureSettings(root, "first");
      vi.stubEnv("OPENCLAW_STATE_DIR", root);
      vi.stubEnv("OPENCLAW_DEBUG_PROXY_ENABLED", "1");
      vi.stubEnv("OPENCLAW_DEBUG_PROXY_SESSION_ID", settings.sessionId);
      const record = vi.fn();
      const getStore = vi.fn(() => ({
        upsertSession() {},
        endSession() {},
        recordEvent: record,
        close() {},
      }));
      const deps = {
        getStore,
        persistEventPayload: () => ({}),
        fetchTarget: { fetch: vi.fn() } as unknown as typeof globalThis,
      };
      const resolved = () => (mode === "explicit" ? settings : undefined);
      const frame = {
        url: "wss://example.test/stream",
        direction: "inbound" as const,
        kind: "ws-frame" as const,
        flowId: "fixture",
        payload: "frame",
      };
      const delayed = prepareHttpCapture(resolved(), deps)!;
      captureWsEvent(frame, resolved(), deps);
      finalizeDebugProxyCapture(resolved(), deps);
      captureWsEvent(frame, resolved(), deps);
      expect(getStore).toHaveBeenCalledTimes(1);
      expect(record).toHaveBeenCalledTimes(1);

      settings = captureSettings(root, "second");
      vi.stubEnv("OPENCLAW_DEBUG_PROXY_SESSION_ID", settings.sessionId);
      captureWsEvent(frame, resolved(), deps);
      expect(getStore).toHaveBeenCalledTimes(2);
      expect(record).toHaveBeenCalledTimes(2);
      delayed({
        url: "https://example.test/delayed",
        method: "GET",
        response: new Response("late"),
      });
      expect(record).toHaveBeenCalledTimes(2);
      finalizeDebugProxyCapture(resolved(), deps);

      initializeDebugProxyCapture("replacement", resolved(), deps);
      captureWsEvent(frame, resolved(), deps);
      expect(getStore).toHaveBeenCalledTimes(3);
      expect(record).toHaveBeenCalledTimes(3);
      finalizeDebugProxyCapture(resolved(), deps);
    },
  );

  it("releases retired settings, store, and runtime closures while delayed admission stays fenced", () => {
    const root = stateRoot();
    const runtimeUrl = new URL("./runtime.ts", import.meta.url).href;
    const script = `
      import assert from "node:assert/strict";
      import { initializeDebugProxyCapture, finalizeDebugProxyCapture, prepareHttpCapture } from ${JSON.stringify(runtimeUrl)};
      let store, acquired = 0, recorded = 0, complete;
      const getStore = () => { acquired++; return store; };
      const target = { fetch: () => new Promise(resolve => complete = resolve) };
      const control = new WeakRef({});
      function retire() {
        const settings = ${JSON.stringify(captureSettings(root))};
        store = { upsertSession() {}, endSession() {}, recordEvent() { recorded++; }, close() {} };
        const payload = { retained: Buffer.alloc(1024) };
        const persist = () => { assert.ok(payload.retained); return {}; };
        const refs = [new WeakRef(settings), new WeakRef(store), new WeakRef(persist)];
        const deps = { getStore, persistEventPayload: persist, fetchTarget: target };
        initializeDebugProxyCapture("fixture", settings, deps);
        const capture = prepareHttpCapture(settings, deps);
        const late = target.fetch("https://example.test/delayed");
        finalizeDebugProxyCapture(settings, deps);
        store = undefined;
        return { refs, capture, late };
      }
      const retired = retire();
      for (let i = 0; i < 30; i++) {
        await new Promise(setImmediate);
        globalThis.gc();
      }
      assert.equal(control.deref(), undefined, "GC control must be collected");
      const released = retired.refs.map(ref => ref.deref() === undefined);
      const response = new Response("late");
      complete(response);
      assert.equal(await retired.late, response);
      retired.capture({ url: "https://example.test/delayed", method: "GET", response });
      assert.equal(acquired, 1);
      assert.equal(recorded, 0);
      process.stdout.write(JSON.stringify(released));
    `;
    const child = spawnSync(
      process.execPath,
      [
        "--disable-warning=ExperimentalWarning",
        "--expose-gc",
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        script,
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, OPENCLAW_STATE_DIR: root },
        encoding: "utf8",
        timeout: 20_000,
      },
    );
    expect(child.stderr).toBe("");
    expect(child.status).toBe(0);
    expect(JSON.parse(child.stdout)).toEqual([true, true, true]);
  });

  it.each(
    (["patched", "guarded"] as const).flatMap((route) =>
      (["success", "rejection"] as const).map((outcome) => ({ route, outcome })),
    ),
  )(
    "does not attach a delayed $route $outcome to a replacement owner",
    async ({ route, outcome }) => {
      const root = stateRoot();
      const settings = captureSettings(root, `generation-${route}-${outcome}`);
      vi.stubEnv("OPENCLAW_STATE_DIR", root);
      vi.stubEnv("OPENCLAW_DEBUG_PROXY_ENABLED", "1");
      vi.stubEnv("OPENCLAW_DEBUG_PROXY_SESSION_ID", settings.sessionId);
      const admitted = createDeferredCore();
      const transport = createDeferredCore<Response>();
      const fetchImpl = vi.fn(async () => {
        admitted.resolve();
        return await transport.promise;
      });
      const target = { ...globalThis, fetch: fetchImpl } as typeof globalThis;
      const deps = { fetchTarget: target };
      initializeDebugProxyCapture("first", settings, deps);
      const firstStore = acquireDebugProxyCaptureStore();
      const operation =
        route === "patched"
          ? target.fetch("https://example.test/delayed").then((response) => ({
              response,
              release: async () => {},
            }))
          : fetchWithSsrFGuard({ url: "https://example.test/delayed", fetchImpl });
      const result = operation.then(
        (value) => ({ value, error: undefined }),
        (error: unknown) => ({ value: undefined, error }),
      );
      await admitted.promise;
      finalizeDebugProxyCapture(settings, deps);
      expect(firstStore.store.isClosed).toBe(true);
      initializeDebugProxyCapture("replacement", settings, deps);
      const replacement = acquireDebugProxyCaptureStore();
      const record = vi.spyOn(replacement.store, "recordEvent");
      const response = new Response("late");
      const error = new Error("fixture late transport failure");
      try {
        if (outcome === "success") {
          transport.resolve(response);
        } else {
          transport.reject(error);
        }
        const completed = await result;
        if (outcome === "success") {
          expect(completed.error).toBeUndefined();
          expect(completed.value?.response).toBe(response);
          expect(await completed.value!.response.text()).toBe("late");
          await completed.value!.release();
        } else {
          expect(completed.error).toBe(error);
        }
        expect(record).not.toHaveBeenCalled();
        expect(replacement.store.getSessionEvents(settings.sessionId)).toEqual([]);
      } finally {
        finalizeDebugProxyCapture(settings, deps);
        firstStore.release();
        replacement.release();
        closeOpenClawStateDatabaseByPath(replacement.store.dbPath);
      }
    },
  );
});
