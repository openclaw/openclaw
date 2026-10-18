import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getRecentDiagnosticPhases,
  resetDiagnosticPhasesForTest,
  withDiagnosticPhase,
} from "../logging/diagnostic-phase.js";
import {
  hasInternalDiagnosticEventInterest,
  hasInternalDiagnosticEventListeners,
} from "./diagnostic-event-listener-presence.js";
import {
  emitDiagnosticEvent,
  emitInternalDiagnosticEvent,
  emitTrustedDiagnosticEvent,
  emitTrustedDiagnosticEventWithPrivateData,
  emitTrustedSkillUsedDiagnosticEvent,
  emitTrustedSecurityEvent,
  hasPendingInternalDiagnosticEvent,
  isInternalDiagnosticEventMetadata,
  isDiagnosticsEnabled,
  onInternalDiagnosticEvent,
  onDiagnosticEvent,
  onTrustedInternalDiagnosticEvent,
  onTrustedToolExecutionEvent,
  resetDiagnosticEventsForTest,
  setDiagnosticsEnabledForProcess,
  waitForDiagnosticEventsDrained,
  type DiagnosticEventMetadata,
  type DiagnosticEventPrivateData,
  type DiagnosticEventPayload,
  createQueuedDiagnosticPhaseEmitter,
} from "./diagnostic-events.js";
import { markTrustedOtelDiagnosticListener } from "./diagnostic-otel-listener-provenance.js";
import { markHostPluginUsageDiagnosticEvent } from "./diagnostic-plugin-usage-provenance.js";
import { resolveCoreSemanticRunProgressDiagnosticMetadata } from "./diagnostic-semantic-run-progress.js";
import {
  createDiagnosticTraceContext,
  formatDiagnosticTraceparent,
  runWithDiagnosticTraceContext,
} from "./diagnostic-trace-context.js";
import {
  type DiagnosticTracePropagationBridge,
  formatPropagatedDiagnosticTraceparent,
  registerDiagnosticTracePropagationBridge,
} from "./diagnostic-trace-propagation.js";

function modelStartedEvent(runId = "run-1", callId = "call-1") {
  return {
    type: "model.call.started" as const,
    runId,
    callId,
    provider: "openai",
    model: "gpt-5.4",
  };
}

describe("diagnostic-events", () => {
  beforeEach(() => {
    resetDiagnosticEventsForTest();
  });

  afterEach(() => {
    resetDiagnosticEventsForTest();
    vi.restoreAllMocks();
  });

  function expectConsoleErrorPrefix(errorSpy: { mock: { calls: unknown[][] } }, prefix: string) {
    expect(errorSpy.mock.calls).toHaveLength(1);
    const [message] = expectDefined(errorSpy.mock.calls[0], "console error call");
    expect(typeof message).toBe("string");
    expect((message as string).startsWith(prefix)).toBe(true);
  }

  it("does not read or queue payloads until a consumer accepts their trust and type", async () => {
    let payloadReads = 0;
    const event = {
      ...modelStartedEvent(),
      get provider() {
        payloadReads += 1;
        return "openai";
      },
    };
    emitTrustedDiagnosticEvent(event);
    const publicEvents: DiagnosticEventPayload[] = [];
    onDiagnosticEvent((value) => publicEvents.push(value));
    emitTrustedDiagnosticEvent(event);
    onInternalDiagnosticEvent(() => {}, { includeTrusted: ["model.call.error"] });
    emitTrustedDiagnosticEvent(event);
    expect(payloadReads).toBe(0);
    expect(hasPendingInternalDiagnosticEvent(() => true)).toBe(false);

    emitDiagnosticEvent(event);
    await waitForDiagnosticEventsDrained();
    expect(publicEvents).toMatchObject([
      { type: "model.call.started", provider: "openai", seq: 4 },
    ]);
    expect(payloadReads).toBe(1);

    const trustedEvents: DiagnosticEventPayload[] = [];
    const stop = onTrustedInternalDiagnosticEvent((value) => trustedEvents.push(value), {
      include: ["model.call.started"],
    });
    emitTrustedDiagnosticEvent(event);
    await waitForDiagnosticEventsDrained();
    expect(trustedEvents).toMatchObject([
      { type: "model.call.started", provider: "openai", seq: 5 },
    ]);
    expect(payloadReads).toBe(2);
    stop();
    emitTrustedDiagnosticEvent(event);
    expect(payloadReads).toBe(2);
    expect(hasPendingInternalDiagnosticEvent(() => true)).toBe(false);
  });

  it("keeps duplicate public subscriptions independent and passes only the event", () => {
    const listener = vi.fn();
    const stopFirst = onDiagnosticEvent(listener);
    const stopSecond = onDiagnosticEvent(listener);
    const event = { type: "message.queued" as const, source: "plugin" };
    emitDiagnosticEvent(event);
    expect(listener.mock.calls.map((args) => args.length)).toEqual([1, 1]);
    stopFirst();
    emitDiagnosticEvent(event);
    expect(listener).toHaveBeenCalledTimes(3);
    stopSecond();
    emitDiagnosticEvent(event);
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it.each([true, false])(
    "only snapshots tool audits for a consumer (diagnostics %s)",
    (enabled) => {
      setDiagnosticsEnabledForProcess(enabled);
      let payloadReads = 0;
      const event = {
        type: "tool.execution.started" as const,
        get toolName() {
          payloadReads += 1;
          return "exec";
        },
      };
      emitTrustedDiagnosticEvent(event);
      expect(payloadReads).toBe(0);
      const listener = vi.fn();
      const stop = onTrustedToolExecutionEvent(listener);
      emitTrustedDiagnosticEvent(event);
      expect(payloadReads).toBe(1);
      expect(listener).toHaveBeenCalledWith(expect.objectContaining({ toolName: "exec", seq: 2 }));
      stop();
      emitTrustedDiagnosticEvent(event);
      expect(payloadReads).toBe(1);
    },
  );

  it("marks dispatcher provenance separately from trust", async () => {
    const events: Array<{
      internal: boolean;
      metadataTrusted: boolean;
      type: string;
    }> = [];
    onInternalDiagnosticEvent((event, metadata) => {
      events.push({
        internal: isInternalDiagnosticEventMetadata(metadata),
        metadataTrusted: metadata.trusted,
        type: event.type,
      });
    });

    emitDiagnosticEvent({
      type: "message.queued",
      source: "plugin",
    });
    emitInternalDiagnosticEvent({
      type: "webhook.received",
      channel: "telegram",
    });
    emitTrustedDiagnosticEvent(modelStartedEvent());

    await yieldToEventLoop();
    expect(events).toEqual([
      { internal: false, metadataTrusted: false, type: "message.queued" },
      { internal: true, metadataTrusted: false, type: "webhook.received" },
      { internal: false, metadataTrusted: true, type: "model.call.started" },
    ]);
    expect(isInternalDiagnosticEventMetadata({ trusted: false })).toBe(false);
  });

  it("prepares trusted events synchronously without cloning private data", async () => {
    const diagnosticTrace = createDiagnosticTraceContext({
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "00f067aa0ba902b7",
      traceFlags: "01",
    });
    const exportedTrace = createDiagnosticTraceContext({
      traceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      spanId: "bbbbbbbbbbbbbbbb",
      traceFlags: "00",
    });
    const prepared: string[] = [];
    let privateDataReads = 0;
    const bridge: DiagnosticTracePropagationBridge<
      DiagnosticEventPayload,
      DiagnosticEventMetadata
    > = {
      shouldPrepareEvent(event) {
        return event.type === "model.call.started";
      },
      prepareEvent(event) {
        prepared.push(event.type);
      },
      resolveTraceContext(traceContext) {
        expect(traceContext).toBe(diagnosticTrace);
        return exportedTrace;
      },
    };
    registerDiagnosticTracePropagationBridge(bridge);

    emitTrustedDiagnosticEventWithPrivateData(
      {
        ...modelStartedEvent(),
        trace: diagnosticTrace,
      },
      {
        modelContent: {
          get inputMessages() {
            privateDataReads += 1;
            return ["secret prompt"];
          },
        },
      },
    );
    expect(privateDataReads).toBe(0);
    expect(hasPendingInternalDiagnosticEvent(() => true)).toBe(false);
    emitTrustedDiagnosticEvent({
      type: "model.call.completed",
      runId: "run-1",
      callId: "call-1",
      provider: "openai",
      model: "gpt-5.4",
      durationMs: 1,
      trace: diagnosticTrace,
    });

    expect(prepared).toEqual(["model.call.started"]);
    expect(formatDiagnosticTraceparent(diagnosticTrace)).toBe(
      `00-${diagnosticTrace.traceId}-${diagnosticTrace.spanId}-01`,
    );
    expect(formatPropagatedDiagnosticTraceparent(diagnosticTrace)).toBe(
      `00-${exportedTrace.traceId}-${exportedTrace.spanId}-00`,
    );
    await waitForDiagnosticEventsDrained();
    expect(privateDataReads).toBe(0);
  });

  it("does not fall back to diagnostic ids when an active propagation bridge misses", () => {
    const diagnosticTrace = createDiagnosticTraceContext({
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "00f067aa0ba902b7",
      traceFlags: "01",
    });
    registerDiagnosticTracePropagationBridge({
      resolveTraceContext: () => undefined,
    });

    expect(formatDiagnosticTraceparent(diagnosticTrace)).toBe(
      `00-${diagnosticTrace.traceId}-${diagnosticTrace.spanId}-01`,
    );
    expect(formatPropagatedDiagnosticTraceparent(diagnosticTrace)).toBeUndefined();
  });

  it("shares semantic provenance across duplicate module instances", async () => {
    const events: Array<{ coreSemantic: boolean; type: string }> = [];
    onInternalDiagnosticEvent((event, metadata) => {
      events.push({
        coreSemantic: resolveCoreSemanticRunProgressDiagnosticMetadata(metadata) !== undefined,
        type: event.type,
      });
    });

    vi.resetModules();
    const duplicateSemanticProgress = await import(
      /* @vite-ignore */ new URL("./diagnostic-semantic-run-progress.ts?duplicate", import.meta.url)
        .href
    );
    duplicateSemanticProgress.emitCoreSemanticRunProgressDiagnosticEvent({
      runId: "duplicate-semantic-run",
      reason: "model_call:semantic_result",
    });
    await waitForDiagnosticEventsDrained();

    expect(events).toEqual([{ coreSemantic: true, type: "run.progress" }]);
  });

  it("does not expose mutable diagnostic state on the obsolete global symbol", async () => {
    const globalStore = globalThis as Record<PropertyKey, unknown>;
    const events: boolean[] = [];
    globalStore[Symbol.for("openclaw.diagnosticEventsState")] = {
      listeners: new Set([() => events.push(true)]),
    };
    onInternalDiagnosticEvent((eventValue, metadata) => {
      events.push(metadata.trusted);
    });

    emitDiagnosticEvent(modelStartedEvent());

    await yieldToEventLoop();
    expect(events).toEqual([false]);
    delete globalStore[Symbol.for("openclaw.diagnosticEventsState")];
  });

  it.each([true, false])(
    "keeps skill file identity trusted-only when diagnostics enabled=%s",
    async (enabled) => {
      const skillFile = "/workspace/skills/daily-brief/SKILL.md";
      const publicEvents: DiagnosticEventPayload[] = [];
      const sharedEvents: DiagnosticEventPayload[] = [];
      const metadataOnly = vi.fn();
      const readSkillFile = vi.fn(() => skillFile);
      const trustedEvents: Array<{
        event: DiagnosticEventPayload;
        privateData: DiagnosticEventPrivateData;
      }> = [];
      onDiagnosticEvent((event) => publicEvents.push(event));
      onInternalDiagnosticEvent((event) => sharedEvents.push(event));
      onTrustedInternalDiagnosticEvent(metadataOnly, undefined, { includePrivateData: false });
      onTrustedInternalDiagnosticEvent((event, _metadata, privateData) => {
        trustedEvents.push({ event, privateData });
      });
      setDiagnosticsEnabledForProcess(enabled);

      emitTrustedSkillUsedDiagnosticEvent(
        {
          type: "skill.used",
          skillName: "Daily Brief",
          skillSource: "workspace",
          activation: "read",
        },
        {
          skillUsage: {
            get skillFile() {
              return readSkillFile();
            },
          },
        },
      );
      await waitForDiagnosticEventsDrained();

      expect(JSON.stringify(publicEvents)).not.toContain(skillFile);
      expect(JSON.stringify(sharedEvents)).not.toContain(skillFile);
      expect(JSON.stringify(trustedEvents[0]?.event)).not.toContain(skillFile);
      expect(trustedEvents).toHaveLength(1);
      expect(trustedEvents[0]?.event).not.toHaveProperty("skillFile");
      expect(trustedEvents[0]?.privateData.skillUsage?.skillFile).toBe(skillFile);
      expect(readSkillFile).toHaveBeenCalledOnce();
      expect(metadataOnly).toHaveBeenCalledExactlyOnceWith(
        trustedEvents[0]?.event,
        expect.objectContaining({ trusted: true }),
        {},
      );
      expect(Object.isFrozen(metadataOnly.mock.calls[0]?.[2])).toBe(true);
    },
  );

  it("emits canonical security events only through the trusted security helper", () => {
    const publicEvents: DiagnosticEventPayload[] = [];
    onDiagnosticEvent((event) => publicEvents.push(event));
    const internalEvents: Array<{
      action?: string;
      eventId?: string;
      trusted: boolean;
      type: string;
    }> = [];
    onInternalDiagnosticEvent((event, metadata) => {
      internalEvents.push({
        action: event.type === "security.event" ? event.action : undefined,
        eventId: event.type === "security.event" ? event.eventId : undefined,
        trusted: metadata.trusted,
        type: event.type,
      });
    });

    emitDiagnosticEvent({
      type: "security.event",
      eventId: "untrusted-security-event",
      category: "tool",
      action: "tool.execution.blocked",
      outcome: "denied",
      severity: "medium",
    } as unknown as Parameters<typeof emitDiagnosticEvent>[0]);
    emitTrustedDiagnosticEvent({
      type: "security.event",
      eventId: "generic-trusted-security-event",
      category: "tool",
      action: "tool.execution.blocked",
      outcome: "denied",
      severity: "medium",
    } as unknown as Parameters<typeof emitTrustedDiagnosticEvent>[0]);
    emitTrustedSecurityEvent({
      eventId: "security-event-1",
      category: "tool",
      action: "tool.execution.blocked",
      outcome: "denied",
      severity: "medium",
    });

    expect(internalEvents).toEqual([
      {
        action: "tool.execution.blocked",
        eventId: "security-event-1",
        trusted: true,
        type: "security.event",
      },
    ]);
    expect(publicEvents).toStrictEqual([]);
  });

  it("isolates diagnostic metadata from listener mutation", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const seen: boolean[] = [];
    onInternalDiagnosticEvent((eventValue, metadata) => {
      (metadata as { trusted: boolean }).trusted = true;
    });
    onInternalDiagnosticEvent((eventValue, metadata) => {
      seen.push(metadata.trusted);
    });

    emitDiagnosticEvent({
      type: "message.queued",
      source: "plugin",
    });

    expect(seen).toEqual([false]);
    expectConsoleErrorPrefix(
      errorSpy,
      "[diagnostic-events] listener error type=message.queued seq=1: TypeError",
    );
  });

  it("shares a frozen snapshot isolated from listener and producer mutation", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const usage = { total: 42 };
    const events: DiagnosticEventPayload[] = [];
    const seen: Array<{ total: number | undefined; trusted: boolean }> = [];
    onInternalDiagnosticEvent((event) => {
      events.push(event);
      usage.total = 7;
      if (event.type === "model.usage") {
        event.usage.total = 0;
      }
    });
    onInternalDiagnosticEvent((event, metadata) => {
      events.push(event);
      if (event.type === "model.usage") {
        seen.push({ total: event.usage.total, trusted: metadata.trusted });
      }
    });
    onTrustedInternalDiagnosticEvent((event) => events.push(event));

    emitTrustedDiagnosticEvent({ type: "model.usage", usage });

    expect(events).toHaveLength(3);
    expect(events[1]).toBe(events[0]);
    expect(events[2]).toBe(events[0]);
    expect(usage.total).toBe(7);
    expect(seen).toEqual([{ total: 42, trusted: true }]);
    expectConsoleErrorPrefix(
      errorSpy,
      "[diagnostic-events] listener error type=model.usage seq=1: TypeError",
    );
  });

  it("keeps opaque plugin values isolated across listeners", () => {
    const extra = {
      map: new Map([["value", 42]]),
      date: new Date(123),
      set: new Set([42]),
      array: Object.assign([1], { bytes: new Uint8Array([42]) }),
    };
    const eventInput = { type: "message.queued" as const, source: "plugin", extra };
    onDiagnosticEvent((event) => {
      const captured = (event as DiagnosticEventPayload & typeof eventInput).extra;
      captured.map.set("value", 0);
      captured.date.setTime(0);
      captured.set.clear();
      captured.array.bytes[0] = 0;
    });
    const observed: DiagnosticEventPayload[] = [];
    onTrustedInternalDiagnosticEvent((event) => observed.push(event));

    emitDiagnosticEvent(eventInput);

    expect(observed).toHaveLength(1);
    const captured = (observed[0] as DiagnosticEventPayload & typeof eventInput).extra;
    for (const value of [captured, extra]) {
      expect(value.map.get("value")).toBe(42);
      expect(value.date.getTime()).toBe(123);
      expect([...value.set]).toEqual([42]);
      expect(value.array.bytes[0]).toBe(42);
    }
  });

  it("freezes extra array properties and cyclic plugin payloads before sharing", () => {
    const children = Object.assign([1], { extra: { value: 42 } });
    const extra = { children, self: {} };
    extra.self = extra;
    const input = { type: "message.queued" as const, source: "plugin", extra };
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    onDiagnosticEvent((event) => {
      (event as DiagnosticEventPayload & typeof input).extra.children.extra.value = 0;
    });
    const observed: DiagnosticEventPayload[] = [];
    onDiagnosticEvent((event) => observed.push(event));

    emitDiagnosticEvent(input);

    const captured = (observed[0] as DiagnosticEventPayload & typeof input).extra;
    expect(captured.children.extra.value).toBe(42);
    expect(captured.self).toBe(captured);
    expect(Object.isFrozen(captured.children.extra)).toBe(true);
    expect(errors).toHaveBeenCalledOnce();
  });

  it("drops prototype-pollution keys during event enrichment", () => {
    const eventInput = Object.assign(Object.create(null), {
      type: "message.queued",
      source: "plugin",
      constructor: "blocked",
      prototype: "blocked",
    }) as Parameters<typeof emitDiagnosticEvent>[0] & Record<string, unknown>;
    Object.defineProperty(eventInput, "__proto__", {
      enumerable: true,
      value: { polluted: true },
    });
    const events: Array<Parameters<Parameters<typeof onInternalDiagnosticEvent>[0]>[0]> = [];
    onInternalDiagnosticEvent((event) => {
      events.push(event);
    });

    emitDiagnosticEvent(eventInput);

    expect(events).toHaveLength(1);
    expect(Object.hasOwn(events[0] ?? {}, "__proto__")).toBe(false);
    expect(Object.hasOwn(events[0] ?? {}, "constructor")).toBe(false);
    expect(Object.hasOwn(events[0] ?? {}, "prototype")).toBe(false);
    expect((Object.prototype as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("does not extend a drain barrier for events queued after it starts", async () => {
    const callIds: string[] = [];
    onDiagnosticEvent((event) => {
      if (event.type === "model.call.started") {
        callIds.push(event.callId);
      }
    });

    emitDiagnosticEvent(modelStartedEvent("run-before-barrier", "before-barrier"));
    const drained = waitForDiagnosticEventsDrained();
    for (let index = 0; index < 250; index += 1) {
      emitDiagnosticEvent(modelStartedEvent(`run-after-${index}`, `after-${index}`));
    }

    await drained;

    expect(callIds).toHaveLength(100);
    expect(callIds[0]).toBe("before-barrier");
    expect(
      hasPendingInternalDiagnosticEvent(
        (event) => event.type === "model.call.started" && event.callId === "after-249",
      ),
    ).toBe(true);

    await waitForDiagnosticEventsDrained();
    expect(callIds).toHaveLength(251);
  });

  it("passes immutable pending diagnostic copies to queue inspectors", async () => {
    const events: DiagnosticEventPayload[] = [];
    onInternalDiagnosticEvent((event) => {
      events.push(event);
    });

    emitTrustedDiagnosticEvent({
      type: "tool.execution.error",
      runId: "run-immutable",
      toolName: "exec",
      toolCallId: "call-immutable",
      durationMs: 1,
      errorCategory: "test",
    });

    let mutationErrors = 0;
    expect(
      hasPendingInternalDiagnosticEvent((event, metadata) => {
        try {
          (event as { type: string }).type = "model.usage";
        } catch {
          mutationErrors += 1;
        }
        try {
          (metadata as { trusted: boolean }).trusted = false;
        } catch {
          mutationErrors += 1;
        }
        return (
          metadata.trusted &&
          event.type === "tool.execution.error" &&
          event.toolCallId === "call-immutable"
        );
      }),
    ).toBe(true);
    expect(mutationErrors).toBe(2);

    await waitForDiagnosticEventsDrained();
    expect(
      hasPendingInternalDiagnosticEvent((event) => event.type === "tool.execution.error"),
    ).toBe(false);

    expect(events).toMatchObject([
      {
        type: "tool.execution.error",
        toolCallId: "call-immutable",
      },
    ]);
  });

  it("skips uncloneable pending diagnostics during queue inspection", async () => {
    onInternalDiagnosticEvent(() => {});
    emitDiagnosticEvent({
      ...modelStartedEvent("run-uncloneable", "call-uncloneable"),
      badValue: () => undefined,
    } as never);
    emitTrustedDiagnosticEvent({
      type: "tool.execution.error",
      runId: "run-cloneable",
      toolName: "exec",
      toolCallId: "call-cloneable",
      durationMs: 1,
      errorCategory: "test",
    });

    expect(
      hasPendingInternalDiagnosticEvent(
        (event, metadata) =>
          metadata.trusted &&
          event.type === "tool.execution.error" &&
          event.toolCallId === "call-cloneable",
      ),
    ).toBe(true);
  });

  it("keeps trusted private data off shared internal diagnostic listeners", async () => {
    const internalEvents: DiagnosticEventPayload[] = [];
    const trustedEvents: Array<{
      event: DiagnosticEventPayload;
      privateData: unknown;
    }> = [];
    onInternalDiagnosticEvent((event) => {
      internalEvents.push(event);
    });
    onTrustedInternalDiagnosticEvent((event, _metadata, privateData) => {
      trustedEvents.push({ event, privateData });
    });

    emitTrustedDiagnosticEventWithPrivateData(modelStartedEvent(), {
      modelContent: {
        inputMessages: ["secret prompt"],
        systemPrompt: "secret system",
      },
    });

    await waitForDiagnosticEventsDrained();

    expect(JSON.stringify(internalEvents)).not.toContain("secret");
    expect(JSON.stringify(trustedEvents[0]?.event)).not.toContain("secret");
    expect(trustedEvents[0]?.privateData).toEqual({
      modelContent: {
        inputMessages: ["secret prompt"],
        systemPrompt: "secret system",
      },
    });
  });

  it("skips event enrichment and subscribers when diagnostics are disabled", () => {
    const nowSpy = vi.spyOn(Date, "now");
    const seen: string[] = [];
    onDiagnosticEvent((event) => {
      seen.push(event.type);
    });
    setDiagnosticsEnabledForProcess(false);

    emitDiagnosticEvent({
      type: "webhook.received",
      channel: "telegram",
    });

    expect(seen).toStrictEqual([]);
    expect(nowSpy).not.toHaveBeenCalled();
  });

  it("drops recursive emissions after the guard threshold", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    let calls = 0;
    onDiagnosticEvent(() => {
      calls += 1;
      emitDiagnosticEvent({
        type: "queue.lane.enqueue",
        lane: "main",
        queueSize: calls,
      });
    });

    emitDiagnosticEvent({
      type: "queue.lane.enqueue",
      lane: "main",
      queueSize: 0,
    });

    expect(calls).toBe(101);
    expect(errorSpy).toHaveBeenCalledExactlyOnceWith(
      "[diagnostic-events] recursion guard tripped at depth=101, dropping type=queue.lane.enqueue",
    );
  });

  it("enables diagnostics unless explicitly disabled", () => {
    expect(isDiagnosticsEnabled()).toBe(true);
    expect(isDiagnosticsEnabled({} as never)).toBe(true);
    expect(isDiagnosticsEnabled({ diagnostics: {} } as never)).toBe(true);
    expect(isDiagnosticsEnabled({ diagnostics: { enabled: false } } as never)).toBe(false);
    expect(isDiagnosticsEnabled({ diagnostics: { enabled: true } } as never)).toBe(true);
  });
});

describe("diagnostic-events", () => {
  beforeEach(() => {
    resetDiagnosticEventsForTest();
  });

  afterEach(() => {
    resetDiagnosticEventsForTest();
    vi.restoreAllMocks();
  });

  it("keeps log records and runtime measurements off the public diagnostic event stream", async () => {
    const publicEvents: string[] = [];
    const internalEvents: string[] = [];
    onDiagnosticEvent((event) => {
      publicEvents.push(event.type);
    });
    onInternalDiagnosticEvent((event) => {
      internalEvents.push(event.type);
    });

    emitDiagnosticEvent({
      type: "log.record",
      level: "INFO",
      message: "private log",
    });
    emitInternalDiagnosticEvent({
      type: "gateway.event_loop.sample",
      intervalMs: 1_000,
      delayMaxMs: 1_500,
    });
    emitInternalDiagnosticEvent({ type: "diagnostic.gc", durationMs: 25 });
    emitInternalDiagnosticEvent({ type: "gateway.http.cancelled", source: "client" });
    expect(internalEvents).toStrictEqual([]);

    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(publicEvents).toStrictEqual([]);
    expect(internalEvents).toEqual([
      "log.record",
      "gateway.event_loop.sample",
      "diagnostic.gc",
      "gateway.http.cancelled",
    ]);
  });
});

const trace = { traceId: "1234567890abcdef1234567890abcdef", spanId: "1234567890abcdef" };
const phase = { name: "runtime.fixture", startedAt: 10, endedAt: 20, durationMs: 10 };

describe("queued runtime diagnostic phases", () => {
  beforeEach(() => {
    resetDiagnosticEventsForTest();
    resetDiagnosticPhasesForTest();
  });
  afterEach(async () => {
    await waitForDiagnosticEventsDrained();
    resetDiagnosticEventsForTest();
    resetDiagnosticPhasesForTest();
  });

  it("preserves synchronous startup history and queues owned runtime snapshots with their captured trace", async () => {
    const events: DiagnosticEventPayload[] = [];
    const publicEvents: DiagnosticEventPayload[] = [];
    onDiagnosticEvent((event) => publicEvents.push(event));
    onTrustedInternalDiagnosticEvent((event) => events.push(event));
    await withDiagnosticPhase("startup.fixture", () => undefined);
    expect(events.map((event) => event.type)).toEqual(["diagnostic.phase.completed"]);
    expect(getRecentDiagnosticPhases().map((entry) => entry.name)).toEqual(["startup.fixture"]);

    const bound = runWithDiagnosticTraceContext(trace, createQueuedDiagnosticPhaseEmitter)!;
    const parentless = runWithDiagnosticTraceContext(
      undefined,
      createQueuedDiagnosticPhaseEmitter,
    )!;
    const details = { threadCpuMs: 3 };
    runWithDiagnosticTraceContext(trace, () => {
      parentless({ ...phase, name: "runtime.parentless" });
      bound({ ...phase, details });
    });
    details.threadCpuMs = 999;
    expect(events).toHaveLength(1);
    await waitForDiagnosticEventsDrained();

    expect(events[1]).toMatchObject({ name: "runtime.parentless", trace: undefined });
    expect(events[2]).toMatchObject({ ...phase, trace, details: { threadCpuMs: 3 } });
    expect(publicEvents).toHaveLength(1);
    expect(getRecentDiagnosticPhases().map((entry) => entry.name)).toEqual(["startup.fixture"]);
  });

  it("requires a currently interested trusted consumer and respects disabled diagnostics", async () => {
    const events: DiagnosticEventPayload[] = [];
    onInternalDiagnosticEvent((event) => events.push(event));
    onTrustedInternalDiagnosticEvent(() => {}, { includeTrusted: ["gateway.rpc"] });
    expect(createQueuedDiagnosticPhaseEmitter()).toBeUndefined();
    const stop = onTrustedInternalDiagnosticEvent(() => {}, {
      include: ["diagnostic.phase.completed"],
    });
    setDiagnosticsEnabledForProcess(false);
    expect(createQueuedDiagnosticPhaseEmitter()).toBeUndefined();
    setDiagnosticsEnabledForProcess(true);
    const emit = createQueuedDiagnosticPhaseEmitter()!;
    setDiagnosticsEnabledForProcess(false);
    emit(phase);
    setDiagnosticsEnabledForProcess(true);
    stop();
    emit(phase);
    await waitForDiagnosticEventsDrained();
    expect(events).toEqual([]);
  });

  it("uses the bounded diagnostic queue without displacing required lifecycle terminals", async () => {
    const events: DiagnosticEventPayload[] = [];
    const publicEvents: DiagnosticEventPayload[] = [];
    onDiagnosticEvent((event) => publicEvents.push(event));
    onTrustedInternalDiagnosticEvent((event) => events.push(event));
    const emit = createQueuedDiagnosticPhaseEmitter()!;
    for (let index = 0; index < 9_999; index++) {
      emit(phase);
    }
    emitDiagnosticEvent(modelStartedEvent("queued", "queued"));
    emit(phase);
    emitDiagnosticEvent(modelStartedEvent("dropped", "dropped"));
    emitTrustedDiagnosticEvent({
      type: "tool.execution.completed",
      toolName: "exec",
      durationMs: 1,
    });
    expect(events).toHaveLength(0);
    await waitForDiagnosticEventsDrained();
    expect(events.filter((event) => event.type === "diagnostic.phase.completed")).toHaveLength(
      9_998,
    );
    expect(events).toContainEqual(expect.objectContaining({ type: "tool.execution.completed" }));
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "diagnostic.async_queue.dropped",
        droppedEvents: 3,
        droppedTrustedEvents: 2,
        droppedUntrustedEvents: 1,
        maxQueueLength: 10_000,
        drainBatchSize: 100,
      }),
    );
    expect(publicEvents.map((event) => event.type)).toEqual([
      "model.call.started",
      "diagnostic.async_queue.dropped",
    ]);
  });
});

describe("diagnostic event plugin usage attribution", () => {
  beforeEach(() => {
    resetDiagnosticEventsForTest();
  });

  it("keeps host plugin attribution private and unforgeable", () => {
    const publicEvents: Array<{
      eventPluginId?: unknown;
      hostPluginId?: string;
      internal?: boolean;
      trusted: boolean;
    }> = [];
    const trustedEvents: Array<{
      eventPluginId?: unknown;
      privateHostPluginId?: unknown;
      internal?: boolean;
      trusted: boolean;
    }> = [];
    const otelEvents: Array<{
      eventPluginId?: unknown;
      hostPluginId?: string;
      internal?: boolean;
      trusted: boolean;
    }> = [];
    onInternalDiagnosticEvent((event, metadata) => {
      if (event.type === "model.usage") {
        publicEvents.push({
          eventPluginId: (event as typeof event & { pluginId?: unknown }).pluginId,
          hostPluginId: (metadata as typeof metadata & { hostPluginId?: string }).hostPluginId,
          internal: metadata.internal,
          trusted: metadata.trusted,
        });
      }
    });
    onTrustedInternalDiagnosticEvent((event, metadata, privateData) => {
      if (event.type === "model.usage") {
        trustedEvents.push({
          eventPluginId: (event as typeof event & { pluginId?: unknown }).pluginId,
          privateHostPluginId: (privateData as { hostPluginId?: unknown }).hostPluginId,
          internal: metadata.internal,
          trusted: metadata.trusted,
        });
      }
    });
    onTrustedInternalDiagnosticEvent(
      markTrustedOtelDiagnosticListener((event, metadata, privateData) => {
        if (event.type === "model.usage") {
          otelEvents.push({
            eventPluginId: (event as typeof event & { pluginId?: unknown }).pluginId,
            hostPluginId: (privateData as { hostPluginId?: string }).hostPluginId,
            internal: metadata.internal,
            trusted: metadata.trusted,
          });
        }
      }),
    );

    emitTrustedDiagnosticEvent({
      type: "model.usage",
      usage: { input: 1 },
      pluginId: "public-emitter-spoof",
    } as Parameters<typeof emitTrustedDiagnosticEvent>[0] & { pluginId: string });
    emitTrustedDiagnosticEventWithPrivateData(
      {
        type: "model.usage",
        usage: { input: 2 },
      },
      { hostPluginId: "private-data-spoof" } as Parameters<
        typeof emitTrustedDiagnosticEventWithPrivateData
      >[1] & { hostPluginId: string },
    );
    emitTrustedDiagnosticEvent(
      markHostPluginUsageDiagnosticEvent(
        {
          type: "model.usage",
          usage: { input: 3 },
        },
        "llm-task",
      ),
    );

    const expectedUnattributed = [
      {
        eventPluginId: "public-emitter-spoof",
        hostPluginId: undefined,
        internal: undefined,
        trusted: true,
      },
      {
        eventPluginId: undefined,
        hostPluginId: undefined,
        internal: undefined,
        trusted: true,
      },
      {
        eventPluginId: undefined,
        hostPluginId: undefined,
        internal: true,
        trusted: true,
      },
    ];
    expect(publicEvents).toEqual(expectedUnattributed);
    expect(trustedEvents).toEqual(
      expectedUnattributed.map(({ hostPluginId, ...event }) => ({
        ...event,
        privateHostPluginId: hostPluginId,
      })),
    );
    expect(otelEvents).toEqual([
      ...expectedUnattributed.slice(0, 2),
      { ...expectedUnattributed[2], hostPluginId: "llm-task" },
    ]);
  });

  it("scopes OTel attribution to one listener registration", () => {
    const observedHostPluginIds: Array<string | undefined> = [];
    const sharedListener = (
      event: Parameters<Parameters<typeof onTrustedInternalDiagnosticEvent>[0]>[0],
      _metadata: Parameters<Parameters<typeof onTrustedInternalDiagnosticEvent>[0]>[1],
      privateData: Parameters<Parameters<typeof onTrustedInternalDiagnosticEvent>[0]>[2],
    ) => {
      if (event.type === "model.usage") {
        observedHostPluginIds.push((privateData as { hostPluginId?: string }).hostPluginId);
      }
    };
    onTrustedInternalDiagnosticEvent(sharedListener);
    onTrustedInternalDiagnosticEvent(markTrustedOtelDiagnosticListener(sharedListener));

    emitTrustedDiagnosticEvent(
      markHostPluginUsageDiagnosticEvent(
        {
          type: "model.usage",
          usage: { input: 1 },
        },
        "llm-task",
      ),
    );

    expect(observedHostPluginIds).toEqual([undefined, "llm-task"]);
  });
});

describe("private diagnostic data", () => {
  beforeEach(resetDiagnosticEventsForTest);
  afterEach(resetDiagnosticEventsForTest);

  it("replaces private-data policy with listener interests and clears it on reset", () => {
    const received = vi.fn();
    const readPrivateData = vi.fn(() => "synthetic private error");
    const emit = () =>
      emitTrustedDiagnosticEventWithPrivateData(
        { type: "model.usage", usage: { input: 1 } },
        {
          get errorMessage() {
            return readPrivateData();
          },
        },
      );
    const stop = onTrustedInternalDiagnosticEvent(received, { include: ["log.record"] });
    onTrustedInternalDiagnosticEvent(
      received,
      { include: ["model.usage"] },
      { includePrivateData: false },
    );
    expect(hasInternalDiagnosticEventInterest("log.record")).toBe(false);
    expect(hasInternalDiagnosticEventInterest("model.usage")).toBe(true);
    emit();
    expect(received.mock.calls[0]?.[2]).toEqual({});
    expect(readPrivateData).not.toHaveBeenCalled();

    onTrustedInternalDiagnosticEvent(received, { include: ["model.usage"] });
    emit();
    expect(received.mock.calls[1]?.[2]).toEqual({ errorMessage: "synthetic private error" });
    expect(readPrivateData).toHaveBeenCalledOnce();
    stop();
    expect(hasInternalDiagnosticEventInterest("model.usage")).toBe(false);
    expect(hasInternalDiagnosticEventListeners()).toBe(false);
    emit();
    expect(received).toHaveBeenCalledTimes(2);

    onTrustedInternalDiagnosticEvent(received, undefined, { includePrivateData: false });
    resetDiagnosticEventsForTest();
    expect(hasInternalDiagnosticEventListeners()).toBe(false);
    const stopAfterReset = onTrustedInternalDiagnosticEvent(received);
    emit();
    expect(received.mock.calls[2]?.[2]).toEqual({ errorMessage: "synthetic private error" });
    expect(readPrivateData).toHaveBeenCalledTimes(2);
    stopAfterReset();
  });
});
