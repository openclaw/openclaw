import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { cliRecoveryEntrypoints } from "../cli/cli-entrypoint.test-support.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { registerSecretValueForRedaction } from "../logging/secret-redaction-registry.js";
import { resetSecretRedactionRegistryForTest } from "../logging/secret-redaction-registry.test-support.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  closeOpenClawStateDatabaseByPath,
  closeOpenClawStateDatabaseByPathAsync,
} from "../state/openclaw-state-db-cache.js";
import { withExistingOpenClawStateDatabaseReadOnly } from "../state/openclaw-state-db-readonly.js";
import { resolveDebugProxySettings, type DebugProxySettings } from "./env.js";
import { proxyCaptureNativeProcessEntrypoints } from "./native-process-runtime.test-support.js";
import {
  captureHttpExchange,
  captureWsEvent,
  captureWsEventAsync,
  finalizeDebugProxyCaptureAsync,
  captureHttpExchangeAsync,
  finalizeDebugProxyCapture,
  initializeDebugProxyCapture,
  initializeDebugProxyCaptureAsync,
} from "./runtime.js";
import {
  listDebugProxyCaptureSessions,
  readDebugProxyCaptureBlob,
  readDebugProxyCaptureSessionEvents,
} from "./store-readonly.js";
import {
  closeDebugProxyCaptureStore,
  DebugProxyCaptureStore,
  getDebugProxyCaptureStore,
} from "./store.sqlite.js";
import type { CaptureEventRecord } from "./types.js";

const redactedPrefix = "first [REDACTED] café";
const runtimeUrl = resolveRuntimeWorkerUrl(proxyCaptureNativeProcessEntrypoints.runtime);
type HttpInput = Parameters<typeof captureHttpExchange>[0];
const http = (response: Response, overrides: Partial<HttpInput> = {}): HttpInput => ({
  url: "https://example.test/pending",
  method: "GET",
  response,
  ...overrides,
});
const frame = (payload: string | Buffer, flowId = "fixture") => ({
  url: "wss://example.test/stream",
  direction: "inbound" as const,
  kind: "ws-frame" as const,
  flowId,
  payload,
});

function secretPrefix() {
  registerSecretValueForRedaction("fixture-secret-value");
  const bytes = Buffer.from("first fixture-secret-value café");
  const chunks = [bytes.subarray(0, 15), bytes.subarray(15, -1), bytes.subarray(-1)];
  return { bytes, chunks, stream: pendingResponse(chunks) };
}

function readCapture(root: string, settings: DebugProxySettings, payloadFlowId?: string) {
  return withExistingOpenClawStateDatabaseReadOnly(
    ({ db }) => {
      const rows = readDebugProxyCaptureSessionEvents(db, settings.sessionId);
      const blobId = (
        payloadFlowId
          ? rows.find((row) => row.kind === "response" && row.flowId === payloadFlowId)
          : rows[0]
      )?.dataBlobId;
      return {
        session: listDebugProxyCaptureSessions(db).find(({ id }) => id === settings.sessionId),
        rows,
        payload: typeof blobId === "string" ? readDebugProxyCaptureBlob(db, blobId) : undefined,
      };
    },
    { env: { OPENCLAW_STATE_DIR: root } },
  );
}

function expectRows(
  rows: ReturnType<typeof readDebugProxyCaptureSessionEvents> | undefined,
  expected: Partial<CaptureEventRecord>[],
) {
  expect(rows).toEqual(expect.arrayContaining(expected.map((row) => expect.objectContaining(row))));
}
afterEach(() => {
  closeDebugProxyCaptureStore();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  resetSecretRedactionRegistryForTest();
});
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const stateRoot = () => tempDirs.make("capture-lifecycle-");

function captureSettings(root: string, sessionId = "lifecycle"): DebugProxySettings {
  return { ...resolveDebugProxySettings({ OPENCLAW_STATE_DIR: root }), enabled: true, sessionId };
}

function fixture(sessionId = "lifecycle") {
  const root = stateRoot();
  return { root, settings: captureSettings(root, sessionId) };
}

function runRuntimeScript(
  root: string,
  script: string,
  args: string[] = [],
  env: NodeJS.ProcessEnv = {},
) {
  return spawnSync(
    process.execPath,
    [
      "--disable-warning=ExperimentalWarning",
      ...args,
      ...resolveRuntimeWorkerArgv(runtimeUrl).slice(0, -1),
      "--input-type=module",
      "-e",
      script,
    ],
    {
      cwd: process.cwd(),
      env: { ...process.env, OPENCLAW_STATE_DIR: root, ...env },
      encoding: "utf8",
      timeout: 20_000,
    },
  );
}

// Self-contained so native exit probes use the same stream/read barrier fixture.
function pendingResponse(chunks: Buffer[]) {
  const pending = Promise.withResolvers<void>();
  const settled = Promise.withResolvers<void>();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
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
  const clone = response.clone.bind(response);
  response.clone = () => {
    const captured = clone();
    const reader = captured.body!.getReader();
    const read = reader.read.bind(reader);
    let reads = 0;
    reader.read = () => {
      const last = ++reads === chunks.length + 1;
      if (last) {
        pending.resolve();
      }
      return read().finally(() => {
        if (last) {
          settled.resolve();
        }
      });
    };
    Object.defineProperty(captured.body, "getReader", { value: () => reader });
    return captured;
  };
  return { response, controller, pending: pending.promise, settled: settled.promise };
}

it.each(["close", "error", "finalize", "event", "retired"] as const)(
  "settles pending reads once through %s",
  async (mode) => {
    const { root, settings } = fixture();
    const store = new DebugProxyCaptureStore({ env: { OPENCLAW_STATE_DIR: root } });
    const deps = { getStore: () => store, fetchTarget: { ...globalThis } };
    const { bytes, stream } = secretPrefix();
    const streams =
      mode === "event" || mode === "retired"
        ? [stream, pendingResponse([Buffer.from("sibling")])]
        : [stream];
    const terminals: CaptureEventRecord[] = [];
    const attempted: string[] = [];
    const done = createDeferredCore();
    const failure = new Error("fixture failure: fixture-secret-value");
    const finish = () => finalizeDebugProxyCapture(settings, deps);
    const record = store.recordEvent.bind(store);
    vi.spyOn(store, "recordEvent").mockImplementation((event) => {
      expect(store.isClosed).toBe(false);
      if (event.kind !== "request") {
        attempted.push(event.flowId);
        if (mode === "event" && event.flowId === "0") {
          throw failure;
        }
      }
      record(event);
      if (event.kind !== "request") {
        terminals.push(event);
        done.resolve();
      }
    });
    try {
      initializeDebugProxyCapture("fixture", settings, deps);
      streams.forEach((value, index) =>
        captureHttpExchange(http(value.response, { flowId: String(index) }), settings, deps),
      );
      await Promise.all(streams.map((value) => value.pending));
      expect(terminals).toEqual([]);
      if (mode === "error") {
        stream.controller.error(failure);
        await done.promise;
      } else if (mode === "close") {
        store.close();
      } else if (mode === "event" || mode === "retired") {
        if (mode === "retired") {
          closeOpenClawStateDatabaseByPath(store.dbPath);
        }
        assert.throws(
          finish,
          (error: unknown) =>
            error instanceof AggregateError &&
            (mode === "retired" || error.errors[0].errors.includes(failure)),
        );
        if (mode === "retired") {
          expect(store.db.isOpen).toBe(false);
        }
      } else {
        finish();
        stream.controller.error(failure);
      }
      if (mode === "retired") {
        expect(terminals).toEqual([]);
      } else {
        expect(terminals).toMatchObject([
          {
            kind: mode === "error" ? "error" : "response",
            dataText: mode === "event" ? "sibling" : redactedPrefix,
          },
        ]);
        const meta = JSON.parse(terminals[0]!.metaJson!);
        expect(meta.bodyCapture).toBe(mode === "error" ? "failed" : "finalized");
        if (mode === "error") {
          expect(meta.stage).toBe("response-body");
          expect(terminals[0]!.errorText).toBe("fixture failure: [REDACTED]");
        }
      }
      if (mode === "close") {
        stream.controller.enqueue(Buffer.from("-later"));
        stream.controller.close();
        expect(await stream.response.text()).toBe(`${bytes.toString()}-later`);
      }
      await stream.settled;
      const attempts = [...attempted];
      finish();
      expect(store.isClosed).toBe(true);
      expect(attempted).toEqual(attempts);
      expect(terminals).toHaveLength(mode === "retired" ? 0 : 1);
      if (mode === "event") {
        expect(attempted).toEqual(["0", "1"]);
      }
      if (mode === "retired") {
        expect(attempted).toEqual([]);
      }
      if (mode === "close") {
        const persisted = readCapture(root, settings);
        expect(persisted?.session?.endedAt).toBeTypeOf("number");
        expect(persisted?.rows).toHaveLength(2);
        expect(persisted?.payload).toBe(redactedPrefix);
      }
    } finally {
      store.close();
      closeOpenClawStateDatabaseByPath(store.dbPath);
      for (const value of streams) {
        await value.response.body?.cancel().catch(() => undefined);
        await value.settled;
      }
    }
  },
);

it("ends the session and reports a blob failure before CLI exit finalization", () => {
  const { root, settings } = fixture();
  const storeUrl = resolveRuntimeWorkerUrl(proxyCaptureNativeProcessEntrypoints.store).href;
  const redactionUrl = resolveRuntimeWorkerUrl(
    proxyCaptureNativeProcessEntrypoints.secretRedaction,
  ).href;
  const script = `
        import assert from "node:assert/strict";
        import { captureHttpExchange, initializeDebugProxyCapture } from ${JSON.stringify(runtimeUrl.href)};
        import { getDebugProxyCaptureStore } from ${JSON.stringify(storeUrl)};
        import { registerSecretValueForRedaction } from ${JSON.stringify(redactionUrl)};
        const settings = ${JSON.stringify(settings)};
        const store = getDebugProxyCaptureStore();
        registerSecretValueForRedaction("fixture-storage-secret");
        const persist = store.persistPayload.bind(store);
        store.persistPayload = (data, contentType) => {
          if (data?.toString() === "prefix-one") {
            throw new Error("fixture blob persistence failure: fixture-storage-secret");
          }
          return persist(data, contentType);
        };
        const deps = { getStore: () => store };
        const pendingResponse = ${pendingResponse.toString()};
        initializeDebugProxyCapture("fixture", settings, deps);
        for (const flowId of ["one", "two"]) {
          const stream = pendingResponse([Buffer.from("prefix-" + flowId)]);
          captureHttpExchange({ url: "https://example.test/exit", method: "GET", response: stream.response, flowId }, settings, deps);
          await stream.pending;
        }
        process.once("exit", () => assert.equal(store.isClosed, true));
        process.exit(0);
      `;
  const child = runRuntimeScript(root, script);
  expect(child.stderr).toBe(
    "[proxy-capture] Capture persistence failed: fixture blob persistence failure: [REDACTED]\n",
  );
  expect(child.status).toBe(0);
  const persisted = readCapture(root, settings);
  expect(persisted?.session?.endedAt).toBeTypeOf("number");
  expect(persisted?.rows).toHaveLength(3);
  expect(persisted?.rows[0]).toMatchObject({ kind: "response", dataText: "prefix-two" });
});
it("isolates same-session databases through independent finalization", async () => {
  const envs = [stateRoot(), stateRoot()].map((root) => ({
    OPENCLAW_STATE_DIR: root,
    OPENCLAW_DEBUG_PROXY_ENABLED: "1",
  }));
  const settings = envs.map((env) => resolveDebugProxySettings(env));
  expect(settings[0]!.sessionId).toBe(settings[1]!.sessionId);
  const stores = envs.map((env) => new DebugProxyCaptureStore({ env }));
  let selected = stores[0]!;
  const deps = { getStore: () => selected };
  const streams = stores.map((_, index) => pendingResponse([Buffer.from(`database-${index}`)]));
  const rows = (index: number) =>
    readCapture(envs[index]!.OPENCLAW_STATE_DIR, settings[index]!)?.rows;
  try {
    for (const [index, value] of settings.entries()) {
      selected = stores[index]!;
      captureHttpExchange(
        http(streams[index]!.response, { flowId: `database-${index}` }),
        value,
        deps,
      );
    }
    await Promise.all(streams.map((stream) => stream.pending));
    for (const index of [0, 1]) {
      const fresh = resolveDebugProxySettings(envs[index]);
      captureWsEvent(frame("before-close", `database-${index}`), fresh, deps);
      finalizeDebugProxyCapture(fresh, deps);
      expect(stores[index]!.isClosed).toBe(true);
      const recorded = rows(index);
      expect(recorded).toHaveLength(3);
      expectRows(recorded, [
        { kind: "ws-frame", dataText: "before-close" },
        { kind: "response", flowId: `database-${index}`, dataText: `database-${index}` },
      ]);
      expect(recorded?.filter((event) => event.kind === "response")).toHaveLength(1);
      captureHttpExchange(http(new Response("late")), settings[index], deps);
      expect(rows(index)).toEqual(recorded);
      if (index === 0) {
        expect(stores[1]!.isClosed).toBe(false);
        expect(rows(1)).toMatchObject([{ kind: "request", flowId: "database-1" }]);
      }
    }
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
});

it("preserves fresh ambient lazy sessions without reopening retired admission", () => {
  const { root, settings } = fixture("first");
  vi.stubEnv("OPENCLAW_STATE_DIR", root);
  vi.stubEnv("OPENCLAW_DEBUG_PROXY_ENABLED", "1");
  vi.stubEnv("OPENCLAW_DEBUG_PROXY_SESSION_ID", settings.sessionId);
  const record = vi.fn();
  const deps = {
    getStore: () => ({ upsertSession() {}, endSession() {}, recordEvent: record, close() {} }),
    persistEventPayload: () => ({}),
    fetchTarget: { ...globalThis },
  };
  captureWsEvent(frame("frame"), undefined, deps);
  finalizeDebugProxyCapture(undefined, deps);
  captureWsEvent(frame("frame"), undefined, deps);
  expect(record).toHaveBeenCalledTimes(1);

  vi.stubEnv("OPENCLAW_DEBUG_PROXY_SESSION_ID", "second");
  captureWsEvent(frame("frame"), undefined, deps);
  expect(record).toHaveBeenCalledTimes(2);
  finalizeDebugProxyCapture(undefined, deps);

  initializeDebugProxyCapture("replacement", undefined, deps);
  captureWsEvent(frame("frame"), undefined, deps);
  expect(record).toHaveBeenCalledTimes(3);
  finalizeDebugProxyCapture(undefined, deps);
});

it("releases retired settings, store, and runtime closures while delayed admission stays fenced", () => {
  const root = stateRoot();
  const script = `
      import assert from "node:assert/strict";
      import { initializeDebugProxyCapture, finalizeDebugProxyCapture } from ${JSON.stringify(runtimeUrl.href)};
      let store, recorded = 0, complete;
      const getStore = () => store;
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
        const late = target.fetch("https://example.test/delayed");
        finalizeDebugProxyCapture(settings, deps);
        store = undefined;
        return { refs, late };
      }
      const retired = retire();
      for (let i = 0; i < 30; i++) {
        await new Promise(setImmediate);
        globalThis.gc();
      }
      assert.equal(control.deref(), undefined, "GC control must be collected");
      const response = new Response("late");
      complete(response);
      assert.equal(await retired.late, response);
      assert.equal(recorded, 0);
      process.stdout.write(JSON.stringify(retired.refs.map(ref => ref.deref() === undefined)));
    `;
  const child = runRuntimeScript(root, script, ["--expose-gc"]);
  expect(child.status).toBe(0);
  expect(JSON.parse(child.stdout)).toEqual([true, true, true]);
});
it.skipIf(process.platform === "win32")(
  "drains a queued capture and ends its session on SIGTERM",
  () => {
    const { root, settings } = fixture("signal-SIGTERM");
    const payload = "queued capture before SIGTERM";
    const signalUrl = resolveRuntimeWorkerUrl(cliRecoveryEntrypoints.signalExitBarrier);
    const script = `
      import { initializeDebugProxyCaptureAsync, captureWsEventAsync } from ${JSON.stringify(runtimeUrl.href)};
      import { installCliSignalExitHandlers } from ${JSON.stringify(signalUrl.href)};
      installCliSignalExitHandlers();
      const settings = ${JSON.stringify(settings)};
      await initializeDebugProxyCaptureAsync("signal-fixture", settings);
      void captureWsEventAsync({
        url: "wss://example.test/signal",
        direction: "outbound",
        kind: "ws-frame",
        flowId: "queued-at-signal",
        payload: ${JSON.stringify(payload)},
      }, settings);
      process.kill(process.pid, "SIGTERM");
    `;
    const child = runRuntimeScript(root, script, [], { HOME: root, XDG_CACHE_HOME: root });
    expect([child.error, child.signal, child.status], child.stderr).toEqual([undefined, null, 143]);
    const persisted = readCapture(root, settings);
    expect(persisted?.session?.endedAt).toBeTypeOf("number");
    expect(persisted?.rows).toEqual([
      expect.objectContaining({
        kind: "ws-frame",
        flowId: "queued-at-signal",
        dataText: payload,
      }),
    ]);
    expect(persisted?.payload).toBe(payload);
  },
);

it.each(["host-only", "legacy-first", "async-first"])(
  "drains immutable host capture with %s ownership",
  async (order) => {
    const { root, settings } = fixture("async-lifecycle");
    vi.stubEnv("OPENCLAW_STATE_DIR", root);
    const fetchTarget: typeof globalThis = {
      ...globalThis,
      fetch: async () => new Response("host"),
    };
    const deps = { fetchTarget };
    const legacy =
      order === "host-only" ? undefined : pendingResponse([Buffer.from("legacy prefix")]);
    if (order === "legacy-first") {
      initializeDebugProxyCapture("legacy-plugin", settings, deps);
    }
    if (legacy) {
      await initializeDebugProxyCaptureAsync("host", settings, deps);
    }
    if (order === "async-first") {
      initializeDebugProxyCapture("legacy-plugin", settings, deps);
    }
    const legacyStore = legacy ? getDebugProxyCaptureStore() : undefined;
    if (legacy) {
      captureHttpExchange(http(legacy.response), settings, deps);
    }
    const { chunks, stream } = secretPrefix();
    const wsBytes = Buffer.from("websocket original");
    const wsMeta = { provider: "fixture", detail: { phase: "accepted" } };
    const wsWriting = captureWsEventAsync(
      {
        ...frame(wsBytes, "ws-before-admission"),
        direction: "outbound",
        meta: wsMeta,
      },
      settings,
      deps,
    );
    wsBytes.fill(0);
    wsMeta.detail.phase = "mutated";
    let caller: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const request = Buffer.from("request original");
      const meta = { detail: { phase: "accepted" } };
      const writing = captureHttpExchangeAsync(
        http(stream.response, {
          method: "POST",
          requestBody: request,
          flowId: "http-prefix",
          meta,
        }),
        settings,
        deps,
      );
      request.fill(0);
      meta.detail.phase = "mutated";
      // Taking the caller reader immediately would break any clone delayed until after admission.
      caller = stream.response.body!.getReader();
      for (const chunk of chunks) {
        expect(await caller.read()).toEqual({ done: false, value: chunk });
      }
      await stream.pending;
      let reopenedStore: DebugProxyCaptureStore | undefined;
      if (legacy) {
        await legacy.pending;
        finalizeDebugProxyCapture(settings, deps);
        expect(legacyStore!.isClosed).toBe(true);
        captureWsEvent(frame("late legacy"), settings, deps);
        await fetchTarget.fetch("https://example.test/after-legacy");
        await captureWsEventAsync(frame("host still active"), settings, deps);
        const before = readCapture(root, settings);
        expect(before?.session?.endedAt).toBeNull();
        expectRows(before?.rows, [
          { kind: "response", dataText: "legacy prefix" },
          { kind: "ws-frame", dataText: "host still active" },
        ]);
        expect(
          before?.rows.some(
            (row) => row.dataText === "late legacy" || row.dataText === redactedPrefix,
          ),
        ).toBe(false);
        initializeDebugProxyCapture("legacy-reinitialized", settings, deps);
        reopenedStore = getDebugProxyCaptureStore();
        captureWsEvent(frame("legacy reopened"), settings, deps);
      }
      await finalizeDebugProxyCaptureAsync(settings, deps);
      await Promise.all([writing, wsWriting]);
      if (reopenedStore) {
        expect(reopenedStore.isClosed).toBe(true);
      }

      // Finalization must settle with the source and caller tee branch still open.
      stream.controller.enqueue(Buffer.from("-later"));
      stream.controller.close();
      expect(await caller.read()).toEqual({ done: false, value: Buffer.from("-later") });
      expect(await caller.read()).toEqual({ done: true, value: undefined });
      await stream.settled;

      const persisted = readCapture(root, settings, "http-prefix");
      if (legacy) {
        expectRows(persisted?.rows, [
          { kind: "ws-frame", dataText: "legacy reopened" },
          { kind: "response", path: "/after-legacy", dataText: "host" },
        ]);
      }
      const rows = persisted!.rows
        .toReversed()
        .filter(
          (row) => !legacy || row.flowId === "ws-before-admission" || row.flowId === "http-prefix",
        );
      expect(rows).toMatchObject([
        { kind: "ws-frame", dataText: "websocket original" },
        { kind: "request", dataText: "request original" },
        { kind: "response", flowId: "http-prefix", dataText: redactedPrefix, status: 200 },
      ]);
      expect(JSON.parse(String(rows[0]!.metaJson))).toEqual({
        provider: "fixture",
        detail: { phase: "accepted" },
      });
      expect(JSON.parse(String(rows[2]!.metaJson))).toEqual({
        detail: { phase: "accepted" },
        bodyCapture: "finalized",
      });
      expect(persisted?.payload).toBe(redactedPrefix);
      expect(persisted?.session?.endedAt).toBeTypeOf("number");
    } finally {
      await finalizeDebugProxyCaptureAsync(settings, deps);
      await legacy?.response.body?.cancel();
      if (caller) {
        await caller.cancel();
      } else {
        await stream.response.body?.cancel();
      }
      await closeOpenClawStateDatabaseByPathAsync(path.join(root, "state", "openclaw.sqlite"));
    }
  },
);
