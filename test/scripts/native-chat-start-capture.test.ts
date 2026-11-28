import { AsyncLocalStorage } from "node:async_hooks";
import { spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { expect, it, onTestFinished } from "vitest";
import { createMockNativeChatAccounting } from "../../scripts/e2e/lib/mock-inference-facts.ts";
import { instrumentNativeChatStartModule } from "../../scripts/perf/native-chat-start-preload.mjs";
import { summarizeNativeChatStart } from "../../scripts/perf/native-chat-start-report.mjs";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";

it("decorates measured owner callbacks without changing their results or retaining content", () => {
  const marks: unknown[] = [];
  const source = `
    const observer = {
      state: {},
      observeResponseChunk(_startedAt, chunk) { this.last = chunk.delta; },
    };
    const isModelOutputDelta = (chunk) => chunk.type === "text_delta" && chunk.delta.length > 0;
    const modelRequestBodyState = (options) => options.bodyState ??= {};
    function withDiagnosticRequestContext(observer, callId, ctx) {
      const requestOptions = {};
      modelRequestBodyState(requestOptions).onBytes = (bytes) => {
        observer.state.requestPayloadBytes = bytes;
      };
      return {
        serialized(bytes) { requestOptions.bodyState.onBytes(bytes); },
        headers(response) { observer.state.responseStatus = response.status; },
      };
    }
    function createModelLifecycle(params) {
      const callId = "synthetic-call";
      const startedAt = Date.now();
      return {
        ...withDiagnosticRequestContext(observer, callId, params.ctx),
        observeChunk(chunk) { observer.observeResponseChunk(startedAt, chunk); },
      };
    }
    const lifecycle = createModelLifecycle({ctx: {runId: "synthetic-run"}});
    lifecycle.serialized(42);
    lifecycle.headers({status: 200});
    lifecycle.observeChunk({type: "start", delta: ""});
    lifecycle.observeChunk({type: "text_delta", delta: "private synthetic content"});
    observer.state;
  `;
  const transformed = instrumentNativeChatStartModule(source);
  expect(transformed).toBeDefined();
  const context = {
    [Symbol.for("openclaw.perf.native-chat-start")]: Object.assign(
      (...args: unknown[]) => marks.push(args),
      { headers: () => {} },
    ),
  };
  expect(runInNewContext(transformed!.source, context)).toEqual({
    requestPayloadBytes: 42,
    responseStatus: 200,
  });

  expect(marks).toEqual([
    ["provider-start", "synthetic-run", "synthetic-call"],
    ["provider-serialized", "synthetic-run", "synthetic-call"],
    ["provider-headers", "synthetic-run", "synthetic-call", 200],
    ["provider-output", "synthetic-run", "synthetic-call"],
  ]);
  expect(() =>
    instrumentNativeChatStartModule(
      source.replace("observer.state.responseStatus = response.status;", ""),
    ),
  ).toThrow("Missing native chat capture anchor");
  expect(() =>
    instrumentNativeChatStartModule(`${source}\nobserver.state.requestPayloadBytes = bytes;`),
  ).toThrow("Ambiguous native chat capture anchor");
});

it("retains producer ordinals without accepting arbitrary correlation header content", () => {
  const accounting = createMockNativeChatAccounting();
  const runId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  accounting.record("responses", {
    "x-openclaw-perf-pid": "123",
    "x-openclaw-perf-run": runId,
    "x-openclaw-perf-call": `${runId}:model:1`,
  });
  accounting.record("responses", {
    "x-openclaw-perf-pid": "123",
    "x-openclaw-perf-run": "private arbitrary input",
    "x-openclaw-perf-call": "private arbitrary input",
  });
  accounting.record("embeddings", {});
  expect(accounting.snapshot()).toEqual({
    version: 1,
    dropped: 0,
    entries: [
      { route: "responses", ordinal: 1, pid: 123, runId, callId: `${runId}:model:1` },
      { route: "responses", ordinal: 2 },
      { route: "embeddings", ordinal: 1 },
    ],
  });
});

it("derives emitted provider bindings without capturing shadowed callback parameters", () => {
  const marks: unknown[] = [];
  const headers: unknown[] = [];
  const source = `
    const observer = {
      state: {},
      observeResponseChunk(_startedAt, chunk) { this.last = chunk.delta; },
    };
    const modelRequestBodyState = (options) => options.bodyState ??= {};
    const emitDiagnosticsTimelineEvent = () => {};
    const isModelOutputDelta = (chunk) => chunk.type === "text_delta" && chunk.delta.length > 0;
    function createModelLifecycle(e){const t=e.ctx.nextCallId();
      const a=e.createObserver();
      const l=Date.now();emitDiagnosticsTimelineEvent({type:\`mark\`,name:\`provider.request.started\`});
      const onResponse=(e,t)=>{a.state.responseStatus=e.status;return t};
      const g={};
      modelRequestBodyState(g).onBytes=e=>{a.state.requestPayloadBytes=e;};
      return {
        serialized(bytes) { modelRequestBodyState(g).onBytes(bytes); },
        headers: onResponse,
        chunk(e) { a.observeResponseChunk(l,e); },
      };
    }
    const lifecycle = createModelLifecycle({
      ctx: {runId: "synthetic-run", nextCallId: () => "synthetic-call"},
      createObserver: () => observer,
    });
    lifecycle.serialized(42);
    lifecycle.headers({status: 200}, "shadowed-call");
    lifecycle.chunk({type: "text_delta", delta: "private synthetic content"});
    observer.state;
  `;
  const transformed = instrumentNativeChatStartModule(source);
  const tracker = Object.assign((...args: unknown[]) => marks.push(args), {
    headers: (_options: unknown, ...args: unknown[]) => headers.push(args),
  });
  expect(
    runInNewContext(transformed!.source, {
      [Symbol.for("openclaw.perf.native-chat-start")]: tracker,
    }),
  ).toEqual({ requestPayloadBytes: 42, responseStatus: 200 });
  expect(headers).toEqual([["synthetic-run", "synthetic-call"]]);
  expect(marks).toEqual([
    ["provider-start", "synthetic-run", "synthetic-call"],
    ["provider-serialized", "synthetic-run", "synthetic-call"],
    ["provider-headers", "synthetic-run", "synthetic-call", 200],
    ["provider-output", "synthetic-run", "synthetic-call"],
  ]);
  expect(() =>
    instrumentNativeChatStartModule(source.replace("const t=e.ctx.nextCallId();", "let t=0;")),
  ).toThrow("Unsupported or ambiguous emitted native chat binding");
  expect(() =>
    instrumentNativeChatStartModule(`${source}\na.state.responseStatus=e.status;`),
  ).toThrow("Ambiguous native chat capture anchor");
});

it("derives emitted dispatch and completion identities and rejects duplicate owners", async () => {
  const marks: unknown[] = [];
  const source = `
    const T="client", D=T, Ce={runId:T}, R={finish(){}}, _={acknowledge(){}};
    const u=()=>{}, Z=()=>{}, q={onRunStarted(){}}, t={finish(){}};
    u(true,Ce,void 0,{runId:T});R?.finish();_.acknowledge();
    const onAgentRunStart=(e,n,i,s)=>{q.onRunStarted(e);t.finish();Z("agent-run-started",e!==D?{agentRunId:e}:void 0);return i};
    async function runIsolatedCompletion(e){return e.value}
    onAgentRunStart("agent", undefined, "unchanged-result");
    runIsolatedCompletion({purpose:"session-activity-summary",value:42});
  `;
  const transformed = instrumentNativeChatStartModule(source);
  expect(transformed?.anchors).toEqual(["completion-owner", "acknowledged", "run-start"]);
  const tracker = Object.assign((...args: unknown[]) => marks.push(args), {
    withOwner: (purpose: string, run: () => unknown) => {
      marks.push(["owner", purpose]);
      return run();
    },
  });
  expect(
    await runInNewContext(transformed!.source, {
      [Symbol.for("openclaw.perf.native-chat-start")]: tracker,
    }),
  ).toBe(42);
  expect(marks).toEqual([
    ["acknowledged", "client"],
    ["run-start", "client", "agent"],
    ["owner", "session-activity-summary"],
  ]);
  expect(() =>
    instrumentNativeChatStartModule(`${source}\nasync function runIsolatedCompletion(x){}`),
  ).toThrow("Ambiguous native chat capture anchor");
});

it("serves content-free accounting from the actual opt-in mock producer", async () => {
  const child = spawn(
    resolveTestNodeExecPath(),
    [path.resolve("scripts/e2e/mock-openai-server.mjs")],
    {
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        MOCK_PORT: "0",
        MOCK_BIND_HOST: "127.0.0.1",
        MOCK_NATIVE_CHAT_ACCOUNTING: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const closed = once(child, "close");
  const deadline = setTimeout(() => child.kill(), 5000);
  onTestFinished(async () => {
    clearTimeout(deadline);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
    }
    await closed;
  });
  const [ready] = await once(child.stdout!, "data");
  const port = String(ready).match(/mock-openai listening on (\d+)/u)?.[1];
  expect(port).toBeDefined();
  const url = `http://127.0.0.1:${port}`;
  const initial = await fetch(`${url}/health`).then((response) => response.json());
  const runId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const response = await fetch(`${url}/v1/responses`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-openclaw-perf-pid": "123",
      "x-openclaw-perf-run": runId,
      "x-openclaw-perf-call": `${runId}:model:1`,
    },
    body: JSON.stringify({
      model: "synthetic",
      input: "synthetic prompt not retained",
      stream: false,
    }),
  });
  expect(response.ok).toBe(true);
  await response.text();
  const final = await fetch(`${url}/health`).then((value) => value.json());
  expect(final.requests.id).toBe(initial.requests.id);
  expect(final.requests.ingress.responses).toBe(1);
  expect(final.requests.accounting).toEqual({
    version: 1,
    dropped: 0,
    entries: [{ route: "responses", ordinal: 1, pid: 123, runId, callId: `${runId}:model:1` }],
  });
  expect(JSON.stringify(final.requests.accounting)).not.toContain("prompt");
});

it("keeps explicit utility purpose across interleaved generated-completion execution", async () => {
  const owner = new AsyncLocalStorage<string>();
  const transformed = instrumentNativeChatStartModule(`
    async function runIsolatedCompletion(params) {
      await Promise.resolve();
      return {owner: readOwner(), value: params.value};
    }
    Promise.all([
      runIsolatedCompletion({purpose: "session-activity-summary", value: 1}),
      runIsolatedCompletion({purpose: "session-observer", value: 2}),
    ]);
  `);
  expect(transformed?.anchors).toEqual(["completion-owner"]);
  const result = await runInNewContext(transformed!.source, {
    readOwner: () => owner.getStore(),
    [Symbol.for("openclaw.perf.native-chat-start")]: {
      withOwner: (purpose: string, run: () => unknown) => owner.run(purpose, run),
    },
  });
  expect(result).toEqual([
    { owner: "session-activity-summary", value: 1 },
    { owner: "session-observer", value: 2 },
  ]);
});

it.each([false, true])(
  "accounts for measured and identified background requests: %s",
  (background) => {
    const ids = {
      mock: "11111111-1111-4111-8111-111111111111",
      client: "22222222-2222-4222-8222-222222222222",
      agent: "33333333-3333-4333-8333-333333333333",
      call: "44444444-4444-4444-8444-444444444444",
      background: "55555555-5555-4555-8555-555555555555",
      backgroundCall: "66666666-6666-4666-8666-666666666666",
      operation: "77777777-7777-4777-8777-777777777777",
    };
    const phases = [
      "acknowledged",
      "run-start",
      "provider-start",
      "provider-serialized",
      "provider-headers",
      "provider-output",
    ];
    const responseCount = background ? 2 : 1;
    const snapshot = (responses: number) => ({ id: ids.mock, responses, embeddings: 0 });
    const client = {
      outcome: "measured",
      mockInitial: snapshot(0),
      samples: [
        {
          sample: 0,
          runId: ids.client,
          acknowledgedMs: 90000,
          completedMs: 95000,
          mockRequests: responseCount,
          mockBefore: snapshot(0),
          mockAfter: snapshot(responseCount),
        },
      ],
    };
    const marks = phases.map((phase, index) => ({
      type: "mark",
      pid: 123,
      phase,
      atMs: [10, 30, 80, 90, 150, 170][index],
      runId: index < 2 ? ids.client : ids.agent,
      ...(index === 0 ? {} : { relatedId: index === 1 ? ids.agent : ids.call }),
      ...(phase === "provider-start" ? { owner: "agent-turn" } : {}),
      ...(phase === "provider-headers" ? { status: 200 } : {}),
    }));
    const backgroundMarks = background
      ? [
          {
            type: "mark",
            pid: 123,
            phase: "provider-start",
            atMs: 20,
            runId: ids.background,
            relatedId: ids.backgroundCall,
            owner: "session-activity-summary",
            ownerOperationId: ids.operation,
          },
          {
            type: "mark",
            pid: 123,
            phase: "provider-serialized",
            atMs: 22,
            runId: ids.background,
            relatedId: ids.backgroundCall,
          },
          {
            type: "mark",
            pid: 123,
            phase: "provider-headers",
            status: 200,
            atMs: 25,
            runId: ids.background,
            relatedId: ids.backgroundCall,
          },
        ]
      : [];
    const start = { type: "capture-start", pid: 123, architecture: "arm64", role: "gateway" };
    const end = {
      type: "capture-end",
      pid: 123,
      anchors: [...phases, "completion-owner", "request-correlation"],
      droppedEvents: 0,
      unclassifiedIdentities: 0,
      writeFailures: 0,
      exitCode: 0,
    };
    const capture = [start, ...marks, ...backgroundMarks, end];
    const entries = [
      ...(background
        ? [
            {
              route: "responses",
              ordinal: 1,
              pid: 123,
              runId: ids.background,
              callId: ids.backgroundCall,
            },
          ]
        : []),
      { route: "responses", ordinal: responseCount, pid: 123, runId: ids.agent, callId: ids.call },
    ];
    const mockFinal = {
      completion: {
        mainPid: 123,
        foregroundExitCode: 0,
        listenerClosed: true,
        observedStoppedPids: [123, 999],
      },
      mock: {
        requests: {
          id: ids.mock,
          ingress: { responses: responseCount, embeddings: 0, chatCompletions: 0, other: 0 },
          accounting: { version: 1, dropped: 0, entries },
        },
      },
    };
    const result = summarizeNativeChatStart(client, [capture], mockFinal);
    expect(result.samples).toEqual([
      expect.objectContaining({
        serverPid: 123,
        ackToRunStartMs: 20,
        runStartToProviderStartMs: 50,
        providerStartToSerializedMs: 10,
        serializedToHeadersMs: 60,
        headersToFirstSemanticOutputMs: 20,
        clientReceipt: client.samples[0],
      }),
    ]);
    expect(result.backgroundRuns).toEqual(
      background
        ? [
            expect.objectContaining({
              owner: "session-activity-summary",
              runId: ids.background,
              observedOverlap: [{ sample: 0, requestToHeadersOverlapMs: 5 }],
            }),
          ]
        : [],
    );
    expect(result.requestAccounting).toMatchObject({
      responses: responseCount,
      measured: 1,
      background: background ? 1 : 0,
    });
    for (const invalid of [
      capture.slice(0, -1),
      [start, ...marks.slice(0, -1), ...backgroundMarks, end],
      [
        start,
        ...marks.map((mark, index) => (index === 2 ? { ...mark, atMs: 0 } : mark)),
        ...backgroundMarks,
        end,
      ],
      [{ ...start, pid: 456 }, ...marks, end],
      [start, ...marks, marks[1], end],
      [start, ...marks, marks[3], end],
      [start, ...marks, { ...end, droppedEvents: 1 }],
      [start, ...marks, { ...end, exitCode: 1 }],
    ]) {
      expect(() => summarizeNativeChatStart(client, [invalid], mockFinal)).toThrow();
    }
    expect(() => summarizeNativeChatStart(client, [capture, capture], mockFinal)).toThrow(
      "exactly one server process",
    );
    const extra = structuredClone(mockFinal);
    extra.mock.requests.ingress.responses++;
    extra.mock.requests.accounting.entries.push({
      route: "responses",
      ordinal: responseCount + 1,
      pid: 123,
      runId: "88888888-8888-4888-8888-888888888888",
      callId: "99999999-9999-4999-8999-999999999999",
    });
    expect(() => summarizeNativeChatStart(client, [capture], extra)).toThrow(
      /Unattributed|unexplained/u,
    );
    const rejectFinal = (change: (value: typeof mockFinal) => void, message: string) => {
      const value = structuredClone(mockFinal);
      change(value);
      expect(() => summarizeNativeChatStart(client, [capture], value)).toThrow(message);
    };
    rejectFinal((value) => {
      value.mock.requests.accounting.dropped = 1;
    }, "lost observations");
    rejectFinal((value) => {
      value.mock.requests.accounting.entries[0]!.ordinal = 2;
    }, "producer ordinal");
    rejectFinal((value) => {
      value.mock.requests.id = ids.background;
    }, "changed mock instance");
    rejectFinal((value) => {
      Reflect.deleteProperty(value.mock.requests, "id");
    }, "valid mock instance");
    rejectFinal((value) => {
      Reflect.deleteProperty(value.mock.requests.accounting.entries[0]!, "pid");
    }, "Unattributed mock response identity");
    rejectFinal((value) => {
      value.mock.requests.accounting.entries[0]!.pid = 999;
    }, "mock response process");
    rejectFinal((value) => {
      Reflect.deleteProperty(value, "completion");
    }, "post-exit mock collection");
    rejectFinal((value) => {
      value.completion.observedStoppedPids = [];
    }, "observed stopped");
    rejectFinal((value) => {
      value.mock.requests.ingress.responses++;
      value.mock.requests.accounting.entries.push(
        Object.assign({}, entries[0]!, { ordinal: responseCount + 1 }),
      );
    }, "Retried provider call");
    expect(() => summarizeNativeChatStart(client, [capture], undefined)).toThrow(
      "retained final mock",
    );
    const missingCall = structuredClone(capture);
    Reflect.deleteProperty(missingCall[3]!, "relatedId");
    expect(() => summarizeNativeChatStart(client, [missingCall], mockFinal)).toThrow(
      "provider call identity",
    );
    const failedHeaders = capture.map((event) =>
      "phase" in event && event.phase === "provider-headers"
        ? Object.assign({}, event, { status: 401 })
        : event,
    );
    expect(() => summarizeNativeChatStart(client, [failedHeaders], mockFinal)).toThrow(
      "Provider headers reported an HTTP error",
    );
    const helper = [
      { type: "capture-start", pid: 999, ppid: 123, role: "helper", entryKind: "external-module" },
    ];
    expect(summarizeNativeChatStart(client, [capture, helper], mockFinal).helperCaptures).toEqual([
      expect.objectContaining({ pid: 999, disposition: "unjoined-noncompletion-helper" }),
    ]);
    expect(() =>
      summarizeNativeChatStart(client, [capture, [{ ...helper[0], role: "gateway" }]], mockFinal),
    ).toThrow(/Incomplete/u);
    if (background) {
      const unknown = capture.map((event) =>
        "owner" in event && event.owner === "session-activity-summary"
          ? Object.assign({}, event, { owner: "unattributed" })
          : event,
      );
      expect(() => summarizeNativeChatStart(client, [unknown], mockFinal)).toThrow(
        /background owner/u,
      );
      const retried = [
        ...capture.slice(0, -1),
        ...backgroundMarks.map((event) =>
          Object.assign({}, event, {
            runId: "88888888-8888-4888-8888-888888888888",
            relatedId: "99999999-9999-4999-8999-999999999999",
          }),
        ),
        end,
      ];
      const retriedFinal = structuredClone(extra);
      expect(() => summarizeNativeChatStart(client, [retried], retriedFinal)).toThrow(
        "Retried or unidentified background",
      );
    }
  },
);
