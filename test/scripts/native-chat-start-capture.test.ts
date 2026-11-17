import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";
import { instrumentNativeChatStartModule } from "../../scripts/perf/native-chat-start-preload.mjs";
import { summarizeNativeChatStart } from "../../scripts/perf/native-chat-start-report.mjs";

it("decorates measured owner callbacks without changing their results or retaining content", () => {
  const marks: unknown[] = [];
  const source = `
    const observer = {
      state: {},
      observeResponseChunk(_startedAt, chunk) { this.last = chunk.delta; },
    };
    const isModelOutputDelta = (chunk) => chunk.type === "text_delta" && chunk.delta.length > 0;
    function withDiagnosticRequestContext(observer, callId, ctx) {
      return {
        serialized(bytes) { observer.state.requestPayloadBytes = bytes; },
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
    [Symbol.for("openclaw.perf.native-chat-start")]: (...args: unknown[]) => marks.push(args),
  };
  expect(runInNewContext(transformed!.source, context)).toEqual({
    requestPayloadBytes: 42,
    responseStatus: 200,
  });
  expect(marks).toEqual([
    ["provider-start", "synthetic-run", "synthetic-call"],
    ["provider-serialized", "synthetic-run", "synthetic-call"],
    ["provider-headers", "synthetic-run", "synthetic-call"],
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

it("joins only complete same-process server anchors without subtracting client clocks", () => {
  const phases = [
    "acknowledged",
    "run-start",
    "provider-start",
    "provider-serialized",
    "provider-headers",
    "provider-output",
  ];
  const client = {
    outcome: "measured",
    samples: [
      {
        sample: 0,
        runId: "client-run",
        acknowledgedMs: 90000,
        completedMs: 95000,
        mockRequests: 1,
      },
    ],
  };
  const marks = phases.map((phase, index) => ({
    type: "mark",
    pid: 123,
    phase,
    atMs: [10, 30, 80, 90, 150, 170][index],
    runId: index < 2 ? "client-run" : "agent-run",
    ...(index === 0 ? {} : { relatedId: index === 1 ? "agent-run" : "call" }),
  }));
  const start = { type: "capture-start", pid: 123, architecture: "arm64" };
  const end = {
    type: "capture-end",
    pid: 123,
    anchors: phases,
    droppedEvents: 0,
    unclassifiedIdentities: 0,
    writeFailures: 0,
    exitCode: 0,
  };
  const capture = [start, ...marks, end];
  const result = summarizeNativeChatStart(client, [capture]);
  expect(result).toEqual([
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
  for (const invalid of [
    capture.slice(0, -1),
    [start, ...marks.slice(0, -1), end],
    [start, ...marks.map((mark, index) => (index === 2 ? { ...mark, atMs: 0 } : mark)), end],
    [{ ...start, pid: 456 }, ...marks, end],
    [start, ...marks, marks[1], end],
    [start, ...marks, marks[3], end],
    [start, ...marks, { ...end, droppedEvents: 1 }],
    [start, ...marks, { ...end, exitCode: 1 }],
  ]) {
    expect(() => summarizeNativeChatStart(client, [invalid])).toThrow();
  }
  expect(() => summarizeNativeChatStart(client, [capture, capture])).toThrow(
    "exactly one server process",
  );
});
