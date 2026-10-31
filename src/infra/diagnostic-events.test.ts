import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getRecentDiagnosticPhases,
  resetDiagnosticPhasesForTest,
  withDiagnosticPhase,
} from "../logging/diagnostic-phase.js";
import {
  hasInternalDiagnosticEventInterest as hasInterest,
  hasInternalDiagnosticEventListeners as hasListeners,
} from "./diagnostic-event-listener-presence.js";
import {
  emitDiagnosticEvent as emit,
  emitInternalDiagnosticEvent as emitInternal,
  emitTrustedDiagnosticEvent as emitTrusted,
  emitTrustedDiagnosticEventWithPrivateData as emitPrivate,
  emitTrustedSkillUsedDiagnosticEvent as emitSkill,
  emitTrustedSecurityEvent as emitSecurity,
  hasPendingInternalDiagnosticEvent as hasPending,
  isInternalDiagnosticEventMetadata as isInternal,
  isDiagnosticsEnabled as isEnabled,
  onInternalDiagnosticEvent as onInternal,
  onDiagnosticEvent as onPublic,
  onTrustedInternalDiagnosticEvent as onTrusted,
  onTrustedToolExecutionEvent as onTool,
  resetDiagnosticEventsForTest as resetEvents,
  setDiagnosticsEnabledForProcess as setEnabled,
  waitForDiagnosticEventsDrained as drain,
  type DiagnosticEventMetadata as Metadata,
  type DiagnosticEventPrivateData as PrivateData,
  type DiagnosticEventPayload as Event,
  createQueuedDiagnosticPhaseEmitter as phaseEmitter,
} from "./diagnostic-events.js";
import { markTrustedOtelDiagnosticListener } from "./diagnostic-otel-listener-provenance.js";
import { markHostPluginUsageDiagnosticEvent } from "./diagnostic-plugin-usage-provenance.js";
import { resolveCoreSemanticRunProgressDiagnosticMetadata } from "./diagnostic-semantic-run-progress.js";
import {
  createDiagnosticTraceContext as createTrace,
  formatDiagnosticTraceparent as formatTraceparent,
  runWithDiagnosticTraceContext as withTrace,
} from "./diagnostic-trace-context.js";
import {
  type DiagnosticTracePropagationBridge as PropagationBridge,
  formatPropagatedDiagnosticTraceparent as propagatedTraceparent,
  registerDiagnosticTracePropagationBridge as registerBridge,
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

function collectEvents(subscribe: (listener: (event: Event) => void) => unknown) {
  const events: Event[] = [];
  subscribe((event) => events.push(event));
  return events;
}

function collectPrivateEvents() {
  const events: Array<{ event: Event; privateData: PrivateData }> = [];
  onTrusted((event, _metadata, privateData) => events.push({ event, privateData }));
  return events;
}

type Listener = (event: Event, metadata: Metadata, privateData?: PrivateData) => void;
function captureEvents(subscribe: (listener: Listener) => unknown) {
  const listener = vi.fn<Listener>();
  subscribe(listener);
  return listener;
}

function toolErrorEvent(runId: string, toolCallId: string) {
  return {
    type: "tool.execution.error" as const,
    runId,
    toolName: "exec",
    toolCallId,
    durationMs: 1,
    errorCategory: "test",
  };
}

const diagnosticTraceInput = {
  traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
  spanId: "00f067aa0ba902b7",
  traceFlags: "01",
};

beforeEach(resetEvents);
afterEach(() => {
  resetEvents();
  vi.restoreAllMocks();
});

describe("diagnostic-events", () => {
  it("does not read or queue payloads until a consumer accepts their trust and type", async () => {
    const clone = vi.spyOn(globalThis, "structuredClone");
    let payloadReads = 0;
    const event = {
      ...modelStartedEvent(),
      get provider() {
        payloadReads += 1;
        return "openai";
      },
    };
    emitTrusted(event);
    const publicEvents = collectEvents(onPublic);
    emitTrusted(event);
    onInternal(() => {}, { includeTrusted: ["model.call.error"] });
    emitTrusted(event);
    expect(payloadReads).toBe(0);
    expect(clone).not.toHaveBeenCalled();
    expect(hasPending(() => true)).toBe(false);

    emit(event);
    await drain();
    expect(publicEvents).toMatchObject([
      { type: "model.call.started", provider: "openai", seq: 4 },
    ]);
    expect(payloadReads).toBe(1);

    const trustedEvents: Event[] = [];
    const stop = onTrusted((value) => trustedEvents.push(value), {
      include: ["model.call.started"],
    });
    emitTrusted(event);
    await drain();
    expect(trustedEvents).toMatchObject([
      { type: "model.call.started", provider: "openai", seq: 5 },
    ]);
    expect(payloadReads).toBe(2);
    stop();
    emitTrusted(event);
    expect(payloadReads).toBe(2);
    expect(hasPending(() => true)).toBe(false);
  });

  it("keeps duplicate public subscriptions independent and passes only the event", () => {
    const listener = vi.fn();
    const stopFirst = onPublic(listener);
    const stopSecond = onPublic(listener);
    const event = { type: "message.queued" as const, source: "plugin" };
    emit(event);
    expect(listener.mock.calls.map((args) => args.length)).toEqual([1, 1]);
    stopFirst();
    emit(event);
    expect(listener).toHaveBeenCalledTimes(3);
    stopSecond();
    emit(event);
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it.each([true, false])(
    "only snapshots tool audits for a consumer (diagnostics %s)",
    (enabled) => {
      setEnabled(enabled);
      let payloadReads = 0;
      const event = {
        type: "tool.execution.started" as const,
        get toolName() {
          payloadReads += 1;
          return "exec";
        },
      };
      emitTrusted(event);
      expect(payloadReads).toBe(0);
      const listener = vi.fn();
      const stop = onTool(listener);
      emitTrusted(event);
      expect(payloadReads).toBe(1);
      expect(listener).toHaveBeenCalledWith(expect.objectContaining({ toolName: "exec", seq: 2 }));
      stop();
      emitTrusted(event);
      expect(payloadReads).toBe(1);
    },
  );

  it("marks dispatcher provenance separately from trust", async () => {
    const events = captureEvents(onInternal);

    emit({ type: "message.queued", source: "plugin" });
    emitInternal({ type: "webhook.received", channel: "telegram" });
    emitTrusted(modelStartedEvent());

    await yieldToEventLoop();
    expect(
      events.mock.calls.map(([event, metadata]) => ({
        internal: isInternal(metadata),
        metadataTrusted: metadata.trusted,
        type: event.type,
      })),
    ).toEqual([
      { internal: false, metadataTrusted: false, type: "message.queued" },
      { internal: true, metadataTrusted: false, type: "webhook.received" },
      { internal: false, metadataTrusted: true, type: "model.call.started" },
    ]);
    expect(isInternal({ trusted: false })).toBe(false);
  });

  it("prepares trusted events synchronously without cloning private data", async () => {
    const diagnosticTrace = createTrace(diagnosticTraceInput);
    const exportedTrace = createTrace({
      traceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      spanId: "bbbbbbbbbbbbbbbb",
      traceFlags: "00",
    });
    const prepared: string[] = [];
    let privateDataReads = 0;
    const bridge: PropagationBridge<Event, Metadata> = {
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
    registerBridge(bridge);

    emitPrivate(
      { ...modelStartedEvent(), trace: diagnosticTrace },
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
    expect(hasPending(() => true)).toBe(false);
    emitTrusted({
      ...modelStartedEvent(),
      type: "model.call.completed",
      durationMs: 1,
      trace: diagnosticTrace,
    });

    expect(prepared).toEqual(["model.call.started"]);
    expect(formatTraceparent(diagnosticTrace)).toBe(
      `00-${diagnosticTrace.traceId}-${diagnosticTrace.spanId}-01`,
    );
    expect(propagatedTraceparent(diagnosticTrace)).toBe(
      `00-${exportedTrace.traceId}-${exportedTrace.spanId}-00`,
    );
    await drain();
    expect(privateDataReads).toBe(0);
  });

  it("does not fall back to diagnostic ids when an active propagation bridge misses", () => {
    const diagnosticTrace = createTrace(diagnosticTraceInput);
    registerBridge({
      resolveTraceContext: () => undefined,
    });

    expect(formatTraceparent(diagnosticTrace)).toBe(
      `00-${diagnosticTrace.traceId}-${diagnosticTrace.spanId}-01`,
    );
    expect(propagatedTraceparent(diagnosticTrace)).toBeUndefined();
  });

  it("shares one frozen event and metadata across trace preparation, queue inspection and listeners", async () => {
    const clone = vi.spyOn(globalThis, "structuredClone");
    const freeze = vi.spyOn(Object, "freeze");
    const trace = { ...diagnosticTraceInput };
    const prepared: Event[] = [];
    const preparedMetadata: Metadata[] = [];
    registerBridge({
      prepareEvent: (event: Event, metadata: Metadata) => {
        prepared.push(event);
        preparedMetadata.push(metadata);
      },
      resolveTraceContext: () => undefined,
    });
    const received = captureEvents(onInternal);
    const trusted = captureEvents(onTrusted);

    emitTrusted({ ...modelStartedEvent(), trace });
    trace.spanId = "changed-after-emit";
    expect(
      hasPending((event, metadata) => event === prepared[0] && metadata === preparedMetadata[0]),
    ).toBe(true);
    await drain();

    expect(received.mock.calls[0]?.[0]).toBe(prepared[0]);
    expect(trusted.mock.calls[0]?.[0]).toBe(prepared[0]);
    expect(received.mock.calls[0]?.[1]).toBe(preparedMetadata[0]);
    expect(trusted.mock.calls[0]?.[1]).toBe(preparedMetadata[0]);
    expect(Object.isFrozen(preparedMetadata[0])).toBe(true);
    expect(prepared[0]?.trace?.spanId).toBe(diagnosticTraceInput.spanId);
    expect(clone).toHaveBeenCalledTimes(1);
    expect(freeze.mock.calls.filter(([value]) => value === prepared[0])).toHaveLength(1);
  });

  it("shares owned events with immutable plain leaves without cloning", async () => {
    const clone = vi.spyOn(globalThis, "structuredClone");
    const cycleTrackers = vi.spyOn(globalThis, "WeakSet");
    const trace = Object.freeze({ ...diagnosticTraceInput });
    const received = collectEvents(onInternal);
    emitTrusted(Object.freeze({ ...modelStartedEvent(), trace }));
    emitTrusted({ ...modelStartedEvent(), trace });
    await drain();

    expect(received[0]?.trace).toBe(trace);
    expect(received[1]?.trace).toBe(trace);
    expect(Object.isFrozen(received[0])).toBe(true);
    expect(clone).not.toHaveBeenCalled();
    expect(cycleTrackers).not.toHaveBeenCalled();
  });

  it("keeps cyclic frozen graphs with mutable descendants isolated", async () => {
    const leaf = { value: "original" };
    const root: { child?: object; leaf: typeof leaf } = { child: undefined, leaf };
    const child = Object.freeze({ root });
    root.child = child;
    Object.freeze(root);
    const received = collectEvents(onPublic);
    const parentEvent = { ...modelStartedEvent(), extra: root };
    const childEvent = { ...modelStartedEvent(), extra: child };
    emit(parentEvent);
    emit(childEvent);
    leaf.value = "changed";
    await drain();

    const second = received[1] as Event & { extra: typeof child };
    expect(second.extra.root.leaf.value).toBe("original");
    expect(Object.isFrozen(leaf)).toBe(false);
  });

  it("captures queued public and private payloads before the producer changes them", async () => {
    const trace = { ...diagnosticTraceInput };
    const privateData = { modelContent: { inputMessages: ["original"] } };
    const received = collectPrivateEvents();
    emitPrivate({ ...modelStartedEvent(), trace }, privateData);
    trace.spanId = "changed-after-emit";
    privateData.modelContent.inputMessages[0] = "changed-after-emit";
    await drain();

    expect(received[0]?.event.trace?.spanId).toBe(diagnosticTraceInput.spanId);
    expect(received[0]?.privateData.modelContent?.inputMessages).toEqual(["original"]);
  });

  it("shares captured tool payloads while preserving the independent audit sequence", async () => {
    const clone = vi.spyOn(globalThis, "structuredClone");
    const audit = collectEvents(onTool);
    const events = collectEvents(onInternal);
    emitTrusted(modelStartedEvent());
    emitTrusted({ ...toolErrorEvent("run", "call"), trace: { ...diagnosticTraceInput } });
    await drain();

    expect(audit[0]?.seq).toBe(1);
    expect(events[1]?.seq).toBe(2);
    expect(audit[0]?.trace).toBe(events[1]?.trace);
    expect(clone).toHaveBeenCalledTimes(1);
  });

  it("does not snapshot disabled-diagnostics skill events without an interested trusted consumer", () => {
    setEnabled(false);
    const clone = vi.spyOn(globalThis, "structuredClone");
    onInternal(() => {});
    onTrusted(() => {}, { include: ["model.usage"] });
    emitSkill({
      type: "skill.used",
      skillName: "synthetic",
      skillSource: "bundled",
      activation: "read",
      trace: { ...diagnosticTraceInput },
    });
    expect(clone).not.toHaveBeenCalled();
    expect(hasPending(() => true)).toBe(false);
  });

  it.each(["mutable leaf", "frozen getter"])(
    "snapshots a frozen %s instead of trusting its envelope",
    async (kind) => {
      const leaf = { value: "original" };
      const extra = Object.freeze(
        kind === "frozen getter"
          ? {
              get leaf() {
                return leaf;
              },
            }
          : { leaf },
      );
      const input = { ...modelStartedEvent(), extra };
      const received = collectEvents(onPublic);
      emit(input);
      leaf.value = "producer changed";
      await drain();

      expect((received[0] as Event & typeof input).extra.leaf.value).toBe("original");
      expect(Object.isFrozen(leaf)).toBe(false);
    },
  );

  it("shares semantic provenance across duplicate module instances", async () => {
    const events = captureEvents(onInternal);

    vi.resetModules();
    const duplicateSemanticProgress = await import(
      /* @vite-ignore */ new URL("./diagnostic-semantic-run-progress.ts?duplicate", import.meta.url)
        .href
    );
    duplicateSemanticProgress.emitCoreSemanticRunProgressDiagnosticEvent({
      runId: "duplicate-semantic-run",
      reason: "model_call:semantic_result",
    });
    await drain();

    expect(events).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ type: "run.progress" }),
      expect.anything(),
    );
    expect(
      resolveCoreSemanticRunProgressDiagnosticMetadata(events.mock.calls[0]![1]),
    ).toBeDefined();
  });

  it("does not expose mutable diagnostic state on the obsolete global symbol", async () => {
    const globalStore = globalThis as Record<PropertyKey, unknown>;
    const events: boolean[] = [];
    globalStore[Symbol.for("openclaw.diagnosticEventsState")] = {
      listeners: new Set([() => events.push(true)]),
    };
    onInternal((eventValue, metadata) => {
      events.push(metadata.trusted);
    });

    emit(modelStartedEvent());

    await yieldToEventLoop();
    expect(events).toEqual([false]);
    delete globalStore[Symbol.for("openclaw.diagnosticEventsState")];
  });

  it.each([true, false])(
    "keeps skill file identity trusted-only when diagnostics enabled=%s",
    async (enabled) => {
      const skillFile = "/workspace/skills/daily-brief/SKILL.md";
      const publicEvents = collectEvents(onPublic);
      const sharedEvents = collectEvents(onInternal);
      const metadataOnly = vi.fn();
      const readSkillFile = vi.fn(() => skillFile);
      onTrusted(metadataOnly, undefined, { includePrivateData: false });
      const trustedEvents = collectPrivateEvents();
      setEnabled(enabled);

      emitSkill(
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
      await drain();

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
      expect(Object.isFrozen(metadataOnly.mock.calls[0]?.[1])).toBe(true);
      expect(Object.isFrozen(metadataOnly.mock.calls[0]?.[2])).toBe(true);
    },
  );

  it("emits canonical security events only through the trusted security helper", () => {
    const publicEvents = collectEvents(onPublic);
    const internalEvents = captureEvents(onInternal);

    const security = {
      category: "tool",
      action: "tool.execution.blocked",
      outcome: "denied",
      severity: "medium",
    } as const;
    for (const send of [emit, emitTrusted]) {
      send({ ...security, type: "security.event", eventId: "forged" } as unknown as Parameters<
        typeof emit
      >[0]);
    }
    emitSecurity({ ...security, eventId: "security-event-1" });

    expect(internalEvents).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        action: "tool.execution.blocked",
        eventId: "security-event-1",
        type: "security.event",
      }),
      expect.objectContaining({ trusted: true }),
    );
    expect(publicEvents).toStrictEqual([]);
  });

  it.each([false, true])(
    "isolates shared snapshots and trust from mutation (trusted: %s)",
    (trusted) => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const usage = { total: 42 };
      const events: Event[] = [];
      const seen: Array<{ total: number | undefined; trusted: boolean }> = [];
      onInternal((event, metadata) => {
        events.push(event);
        expect(Reflect.set(metadata, "trusted", !trusted)).toBe(false);
        usage.total = 7;
        if (event.type === "model.usage") {
          event.usage.total = 0;
        }
      });
      onInternal((event, metadata) => {
        events.push(event);
        if (event.type === "model.usage") {
          seen.push({ total: event.usage.total, trusted: metadata.trusted });
        }
      });
      onTrusted((event) => events.push(event));

      (trusted ? emitTrusted : emit)({ type: "model.usage", usage });

      expect(events).toHaveLength(3);
      expect(events[1]).toBe(events[0]);
      expect(events[2]).toBe(events[0]);
      expect(usage.total).toBe(7);
      expect(seen).toEqual([{ total: 42, trusted }]);
      expect(errorSpy).toHaveBeenCalledOnce();
    },
  );

  it("keeps opaque plugin values isolated across listeners", () => {
    const extra = {
      map: new Map([["value", 42]]),
      date: new Date(123),
      set: new Set([42]),
      array: Object.assign([1], { bytes: new Uint8Array([42]) }),
    };
    const eventInput = { type: "message.queued" as const, source: "plugin", extra };
    onPublic((event) => {
      const captured = (event as Event & typeof eventInput).extra;
      captured.map.set("value", 0);
      captured.date.setTime(0);
      captured.set.clear();
      captured.array.bytes[0] = 0;
    });
    const observed: Event[] = [];
    onTrusted((event) => observed.push(event));

    emit(eventInput);

    expect(observed).toHaveLength(1);
    const captured = (observed[0] as Event & typeof eventInput).extra;
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
    onPublic((event) => {
      (event as Event & typeof input).extra.children.extra.value = 0;
    });
    const observed: Event[] = [];
    onPublic((event) => observed.push(event));

    emit(input);

    const captured = (observed[0] as Event & typeof input).extra;
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
    }) as Parameters<typeof emit>[0] & Record<string, unknown>;
    Object.defineProperty(eventInput, "__proto__", {
      enumerable: true,
      value: { polluted: true },
    });
    const events = collectEvents(onInternal);

    emit(eventInput);

    expect(events).toHaveLength(1);
    expect(Object.hasOwn(events[0] ?? {}, "__proto__")).toBe(false);
    expect(Object.hasOwn(events[0] ?? {}, "constructor")).toBe(false);
    expect(Object.hasOwn(events[0] ?? {}, "prototype")).toBe(false);
    expect((Object.prototype as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("does not extend a drain barrier for events queued after it starts", async () => {
    const callIds: string[] = [];
    onPublic((event) => {
      if (event.type === "model.call.started") {
        callIds.push(event.callId);
      }
    });

    emit(modelStartedEvent("run-before-barrier", "before-barrier"));
    const drained = drain();
    for (let index = 0; index < 250; index += 1) {
      emit(modelStartedEvent(`run-after-${index}`, `after-${index}`));
    }

    await drained;

    expect(callIds).toHaveLength(100);
    expect(callIds[0]).toBe("before-barrier");
    expect(
      hasPending((event) => event.type === "model.call.started" && event.callId === "after-249"),
    ).toBe(true);

    await drain();
    expect(callIds).toHaveLength(251);
  });

  it("passes immutable pending diagnostic copies to queue inspectors", async () => {
    const events = collectEvents(onInternal);
    emitTrusted(toolErrorEvent("run-immutable", "call-immutable"));

    let mutationErrors = 0;
    expect(
      hasPending((event, metadata) => {
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

    await drain();
    expect(hasPending((event) => event.type === "tool.execution.error")).toBe(false);

    expect(events).toMatchObject([{ type: "tool.execution.error", toolCallId: "call-immutable" }]);
  });

  it("skips uncloneable pending diagnostics during queue inspection", async () => {
    onInternal(() => {});
    emit({
      ...modelStartedEvent("run-uncloneable", "call-uncloneable"),
      badValue: () => undefined,
    } as never);
    emitTrusted(toolErrorEvent("run-cloneable", "call-cloneable"));

    expect(
      hasPending(
        (event, metadata) =>
          metadata.trusted &&
          event.type === "tool.execution.error" &&
          event.toolCallId === "call-cloneable",
      ),
    ).toBe(true);
  });

  it("keeps trusted private data off shared internal diagnostic listeners", async () => {
    const internalEvents = collectEvents(onInternal);
    const trustedEvents = collectPrivateEvents();

    emitPrivate(modelStartedEvent(), {
      modelContent: { inputMessages: ["secret prompt"], systemPrompt: "secret system" },
    });

    await drain();

    expect(JSON.stringify(internalEvents)).not.toContain("secret");
    expect(JSON.stringify(trustedEvents[0]?.event)).not.toContain("secret");
    expect(trustedEvents[0]?.privateData).toEqual({
      modelContent: { inputMessages: ["secret prompt"], systemPrompt: "secret system" },
    });
  });

  it("skips event enrichment and subscribers when diagnostics are disabled", () => {
    const nowSpy = vi.spyOn(Date, "now");
    const seen = collectEvents(onPublic);
    setEnabled(false);

    emit({ type: "webhook.received", channel: "telegram" });

    expect(seen).toStrictEqual([]);
    expect(nowSpy).not.toHaveBeenCalled();
  });

  it("drops recursive emissions after the guard threshold", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    let calls = 0;
    onPublic(() => {
      calls += 1;
      emit({ type: "queue.lane.enqueue", lane: "main", queueSize: calls });
    });

    emit({ type: "queue.lane.enqueue", lane: "main", queueSize: 0 });

    expect(calls).toBe(101);
    expect(errorSpy).toHaveBeenCalledExactlyOnceWith(
      "[diagnostic-events] recursion guard tripped at depth=101, dropping type=queue.lane.enqueue",
    );
  });

  it("enables diagnostics unless explicitly disabled", () => {
    expect(isEnabled()).toBe(true);
    expect(isEnabled({} as never)).toBe(true);
    expect(isEnabled({ diagnostics: {} } as never)).toBe(true);
    expect(isEnabled({ diagnostics: { enabled: false } } as never)).toBe(false);
    expect(isEnabled({ diagnostics: { enabled: true } } as never)).toBe(true);
  });
  it("keeps log records and runtime measurements off the public diagnostic event stream", async () => {
    const publicEvents = collectEvents(onPublic);
    const internalEvents = collectEvents(onInternal);

    emit({ type: "log.record", level: "INFO", message: "private log" });
    emitInternal({ type: "gateway.event_loop.sample", intervalMs: 1_000, delayMaxMs: 1_500 });
    emitInternal({ type: "diagnostic.gc", durationMs: 25 });
    emitInternal({ type: "gateway.http.cancelled", source: "client" });
    expect(internalEvents).toStrictEqual([]);

    await yieldToEventLoop();
    expect(publicEvents).toStrictEqual([]);
    expect(internalEvents.map((event) => event.type)).toEqual([
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
  beforeEach(resetDiagnosticPhasesForTest);
  afterEach(async () => {
    await drain();
    resetDiagnosticPhasesForTest();
  });

  it("preserves synchronous startup history and queues owned runtime snapshots with their captured trace", async () => {
    const publicEvents = collectEvents(onPublic);
    const events = collectEvents(onTrusted);
    await withDiagnosticPhase("startup.fixture", () => undefined);
    expect(events.map((event) => event.type)).toEqual(["diagnostic.phase.completed"]);
    expect(getRecentDiagnosticPhases(0).map((entry) => entry.name)).toEqual(["startup.fixture"]);

    const bound = withTrace(trace, phaseEmitter)!;
    const parentless = withTrace(undefined, phaseEmitter)!;
    const details = { threadCpuMs: 3 };
    const clone = vi.spyOn(globalThis, "structuredClone");
    withTrace(trace, () => {
      parentless({ ...phase, name: "runtime.parentless" });
      bound({ ...phase, details });
    });
    expect(
      clone.mock.calls.some(
        ([value]) =>
          value && typeof value === "object" && "details" in value && value.details === details,
      ),
    ).toBe(true);
    clone.mockRestore();
    details.threadCpuMs = 999;
    expect(events).toHaveLength(1);
    await drain();

    expect(events[1]).toMatchObject({ name: "runtime.parentless", trace: undefined });
    expect(events[2]).toMatchObject({ ...phase, trace, details: { threadCpuMs: 3 } });
    expect(publicEvents).toHaveLength(1);
    expect(getRecentDiagnosticPhases(0).map((entry) => entry.name)).toEqual(["startup.fixture"]);
  });

  it("requires a currently interested trusted consumer and respects disabled diagnostics", async () => {
    const events = collectEvents(onInternal);
    onTrusted(() => {}, { includeTrusted: ["gateway.rpc"] });
    expect(phaseEmitter()).toBeUndefined();
    const stop = onTrusted(() => {}, { include: ["diagnostic.phase.completed"] });
    setEnabled(false);
    expect(phaseEmitter()).toBeUndefined();
    setEnabled(true);
    const emitPhase = phaseEmitter()!;
    setEnabled(false);
    emitPhase(phase);
    setEnabled(true);
    stop();
    emitPhase(phase);
    await drain();
    expect(events).toEqual([]);
  });

  it("uses the bounded diagnostic queue without displacing required lifecycle terminals", async () => {
    const publicEvents = collectEvents(onPublic);
    const events = collectEvents(onTrusted);
    const dropped = captureEvents((listener) =>
      onInternal(listener, { include: ["diagnostic.async_queue.dropped"] }),
    );
    const emitPhase = phaseEmitter()!;
    for (let index = 0; index < 9_999; index++) {
      emitPhase(phase);
    }
    emit(modelStartedEvent("queued", "queued"));
    emitPhase(phase);
    emit(modelStartedEvent("dropped", "dropped"));
    emitTrusted({ type: "tool.execution.completed", toolName: "exec", durationMs: 1 });
    expect(events).toHaveLength(0);
    await drain();
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
    expect(Object.isFrozen(dropped.mock.calls[0]?.[1])).toBe(true);
  });
});

describe("diagnostic event plugin usage attribution", () => {
  function attribution([event, metadata, privateData]: Parameters<Listener>) {
    const eventPluginId: unknown = Reflect.get(event, "pluginId");
    const hostPluginId: unknown = Reflect.get(privateData ?? metadata, "hostPluginId");
    return {
      eventPluginId,
      hostPluginId,
      internal: metadata.internal,
      trusted: metadata.trusted,
    };
  }

  it("keeps host plugin attribution private and unforgeable", () => {
    const publicEvents = captureEvents(onInternal);
    const trustedEvents = captureEvents(onTrusted);
    const otelEvents = captureEvents((listener) =>
      onTrusted(markTrustedOtelDiagnosticListener(listener)),
    );

    emitTrusted({
      type: "model.usage",
      usage: { input: 1 },
      pluginId: "public-emitter-spoof",
    } as Parameters<typeof emitTrusted>[0] & { pluginId: string });
    emitPrivate({ type: "model.usage", usage: { input: 2 } }, {
      hostPluginId: "private-data-spoof",
    } as Parameters<typeof emitPrivate>[1] & {
      hostPluginId: string;
    });
    emitTrusted(
      markHostPluginUsageDiagnosticEvent({ type: "model.usage", usage: { input: 3 } }, "llm-task"),
    );

    const unattributed = {
      eventPluginId: undefined,
      hostPluginId: undefined,
      internal: undefined,
      trusted: true,
    };
    const expectedUnattributed = [
      { ...unattributed, eventPluginId: "public-emitter-spoof" },
      unattributed,
      { ...unattributed, internal: true },
    ];
    expect(publicEvents.mock.calls.map(attribution)).toEqual(expectedUnattributed);
    expect(trustedEvents.mock.calls.map(attribution)).toEqual(expectedUnattributed);
    expect(otelEvents.mock.calls.map(attribution)).toEqual([
      ...expectedUnattributed.slice(0, 2),
      { ...expectedUnattributed[2], hostPluginId: "llm-task" },
    ]);
  });

  it("scopes OTel attribution to one listener registration", () => {
    const sharedListener = vi.fn<Listener>();
    onTrusted(sharedListener);
    onTrusted(markTrustedOtelDiagnosticListener(sharedListener));

    emitTrusted(
      markHostPluginUsageDiagnosticEvent({ type: "model.usage", usage: { input: 1 } }, "llm-task"),
    );

    expect(sharedListener.mock.calls.map(attribution).map((event) => event.hostPluginId)).toEqual([
      undefined,
      "llm-task",
    ]);
  });
});

describe("private diagnostic data", () => {
  it("keeps queued delivery and trace preparation when private data cannot be cloned", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const prepared: Event[] = [];
    registerBridge({
      prepareEvent: (event: Event) => prepared.push(event),
      resolveTraceContext: () => undefined,
    });
    const internal = collectEvents(onInternal);
    const metadataOnly = collectEvents((listener) =>
      onTrusted(listener, undefined, { includePrivateData: false }),
    );
    const privateEvents = collectPrivateEvents();

    emitPrivate(modelStartedEvent(), { modelContent: { inputMessages: () => {} } });
    await drain();

    expect(prepared).toHaveLength(1);
    expect(internal).toEqual(prepared);
    expect(metadataOnly).toEqual(prepared);
    expect(privateEvents).toEqual([{ event: prepared[0], privateData: {} }]);
    expect(errors).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("private snapshot error type=model.call.started"),
    );
  });

  it("clones plain private data once per dispatch for interested trusted listeners", () => {
    const clone = vi.spyOn(globalThis, "structuredClone");
    const producer = { modelContent: { inputMessages: [{ content: "synthetic prompt" }] } };
    const received: PrivateData[] = [];
    const mutations: boolean[] = [];
    onTrusted(() => {}, undefined, { includePrivateData: false });
    onTrusted(() => {}, { include: ["log.record"] });
    for (let index = 0; index < 4; index++) {
      onTrusted((_event, _metadata, data) => {
        received.push(data);
        mutations.push(Reflect.set(data.modelContent!, "systemPrompt", "changed"));
      });
    }

    emitPrivate({ type: "model.usage", usage: { input: 1 } }, producer);

    expect(clone.mock.calls.filter(([value]) => value === producer)).toHaveLength(1);
    expect(new Set(received).size).toBe(1);
    expect(received).toHaveLength(4);
    expect(mutations).toEqual([false, false, false, false]);
    producer.modelContent.inputMessages[0]!.content = "producer changed";
    expect(received[0]).toEqual({
      modelContent: { inputMessages: [{ content: "synthetic prompt" }] },
    });
  });

  it("keeps mutable opaque private values isolated between listeners and producers", () => {
    const values = { map: new Map([["key", "original"]]), bytes: new Uint8Array([1]) };
    const producer = { toolContent: { toolInput: values } };
    onTrusted((_event, _metadata, data) => {
      const input = data.toolContent!.toolInput as typeof values;
      input.map.set("key", "listener changed");
      input.bytes[0] = 2;
    });
    const received = collectPrivateEvents();

    emitPrivate({ type: "model.usage", usage: { input: 1 } }, producer);

    expect(received[0]?.privateData).toEqual(producer);
    expect(values.map.get("key")).toBe("original");
    expect(values.bytes[0]).toBe(1);
  });

  it("removes forged OTel attribution without altering another listener's private snapshot", () => {
    const producer = { hostPluginId: "spoof", errorMessage: "synthetic error" };
    const ordinary = collectPrivateEvents();
    const otel = vi.fn<Listener>();
    onTrusted(markTrustedOtelDiagnosticListener(otel));
    const afterOtel = collectPrivateEvents();

    emitInternal({ type: "model.usage", usage: { input: 1 } }, producer);

    expect(ordinary[0]?.privateData).toEqual(producer);
    expect(afterOtel[0]?.privateData).toEqual(producer);
    expect(otel.mock.calls[0]?.[2]).toEqual({ errorMessage: "synthetic error" });
    expect(Object.isFrozen(otel.mock.calls[0]?.[2])).toBe(true);
  });

  it("shares the frozen empty private payload with OTel listeners", () => {
    const received: PrivateData[] = [];
    onTrusted((_evt, _meta, data) => received.push(data));
    onTrusted(markTrustedOtelDiagnosticListener((_evt, _meta, data) => received.push(data)));

    emitTrusted({ type: "model.usage", usage: { input: 1 } });
    emitTrusted({ type: "model.usage", usage: { input: 2 } });

    expect(received).toHaveLength(4);
    expect(received[0]).toEqual({});
    expect(Object.isFrozen(received[0])).toBe(true);
    expect(new Set(received).size).toBe(1);
  });

  it("replaces private-data policy with listener interests and clears it on reset", () => {
    const received = vi.fn();
    const readPrivateData = vi.fn(() => "synthetic private error");
    const send = () =>
      emitPrivate(
        { type: "model.usage", usage: { input: 1 } },
        {
          get errorMessage() {
            return readPrivateData();
          },
        },
      );
    const stop = onTrusted(received, { include: ["log.record"] });
    onTrusted(received, { include: ["model.usage"] }, { includePrivateData: false });
    expect(hasInterest("log.record")).toBe(false);
    expect(hasInterest("model.usage")).toBe(true);
    send();
    expect(received.mock.calls[0]?.[2]).toEqual({});
    expect(readPrivateData).not.toHaveBeenCalled();

    onTrusted(received, { include: ["model.usage"] });
    send();
    expect(received.mock.calls[1]?.[2]).toEqual({ errorMessage: "synthetic private error" });
    expect(readPrivateData).toHaveBeenCalledOnce();
    stop();
    expect(hasInterest("model.usage")).toBe(false);
    expect(hasListeners()).toBe(false);
    send();
    expect(received).toHaveBeenCalledTimes(2);

    onTrusted(received, undefined, { includePrivateData: false });
    resetEvents();
    expect(hasListeners()).toBe(false);
    const stopAfterReset = onTrusted(received);
    send();
    expect(received.mock.calls[2]?.[2]).toEqual({ errorMessage: "synthetic private error" });
    expect(readPrivateData).toHaveBeenCalledTimes(2);
    stopAfterReset();
  });
});
