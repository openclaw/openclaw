import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// @vitest-environment node
import { GatewaySessionMessageSubscriptionCoordinator } from "../../../packages/gateway-client/src/session-subscriptions.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { GatewayEventFrame } from "../api/gateway.ts";
import type { SessionCapability } from "../lib/sessions/index.ts";
import { browserVisibility, runningRow } from "../test-helpers/app-sidebar-session-narration.ts";
import {
  createSidebarNarration,
  type SidebarNarrationSyncInput,
} from "./app-sidebar-session-narration.ts";
import type { SidebarRecentSession } from "./app-sidebar-session-types.ts";
import "../test-helpers/app-sidebar-tool-activity-cases.ts";

// Mirrors the protocol throttle; asserting through timers keeps the
// constant unexported (production-only export policy).
const SIDEBAR_NARRATION_THROTTLE_MS = 2_000;
const runKey = "agent:main:run";

function gatewayEvent(eventName: string, payload: unknown): GatewayEventFrame {
  return { type: "event", event: eventName, payload };
}

function runEvent(event: string, payload: Record<string, unknown>): GatewayEventFrame {
  return gatewayEvent(event, { sessionKey: runKey, runId: "run-1", ...payload });
}

const assistant = (content: unknown) => ({ role: "assistant", content });

function chatDelta(text?: string, deltaText?: string, replace?: boolean): GatewayEventFrame {
  return runEvent("chat", {
    state: "delta",
    deltaText,
    replace,
    ...(text === undefined ? {} : { message: assistant(text) }),
  });
}

const toolEvent = (name: string, fields: Record<string, unknown> = {}) =>
  runEvent("agent", { stream: "tool", data: { name }, ...fields });
const observer = (headline: string, fields: Record<string, unknown> = {}) =>
  runEvent("session.observer", {
    revision: 1,
    updatedAt: 10_000,
    health: "on-track",
    headline,
    ...fields,
  });
const chatSnapshot = (text: string, fields: Record<string, unknown> = {}) =>
  chatFrame({
    deltaText: text,
    message: assistant(text),
    ...fields,
  });

const digest = (text: string) => runEvent("session.narration", { text });

function messageSource(subscribe = (key: string) => Promise.resolve({ key, agentId: null })) {
  return {
    subscribeMessages: vi.fn(subscribe),
    unsubscribeMessages: vi.fn(() => Promise.resolve()),
  };
}
function startNarration(
  source: SidebarNarrationSyncInput["source"],
  fields: Partial<SidebarNarrationSyncInput> = {},
) {
  const input: SidebarNarrationSyncInput = {
    enabled: true,
    connected: true,
    connectionIdentity: {},
    source,
    openSessionKey: "",
    rows: [runningRow(runKey)],
    agentId: "main",
    ...fields,
  };
  const narration = createSidebarNarration();
  narration.sync(input);
  return { narration, input, emit: narration.handleEvent };
}
const narrationFixture = () => startNarration(messageSource());

function chatFrame(payload: Record<string, unknown>): GatewayEventFrame {
  return runEvent("chat", payload);
}

describe("createSidebarNarration", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
  });

  afterEach(() => {
    // isolate:false shares the worker clock: a leaked fake timer deterministically
    // times out unrelated later files.
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("retains pending interests while switching foreground and resets the window on reconnect", async () => {
    const ready = createDeferred();
    const source = messageSource(async (key) => {
      await ready.promise;
      return { key, agentId: null };
    });
    const rows = Array.from({ length: 8 }, (_, index) => ({
      ...runningRow(`agent:main:run-${index}`),
      startedAt: undefined,
      updatedAt: index,
    }));
    const { narration, input } = startNarration(source, { rows });
    rows[0]!.updatedAt = 100;
    narration.sync({ ...input, rows: rows.toReversed() });
    expect(source.subscribeMessages).toHaveBeenCalledTimes(6);

    narration.sync({ ...input, openSessionKey: rows[0]!.key });
    ready.resolve();
    await Promise.all(source.subscribeMessages.mock.results.map(({ value }) => value));
    expect(source.subscribeMessages).toHaveBeenCalledTimes(7);
    expect(source.unsubscribeMessages).not.toHaveBeenCalled();

    input.openSessionKey = rows[1]!.key;
    narration.sync(input);
    await source.subscribeMessages.mock.results.at(-1)?.value;
    expect(source.subscribeMessages).toHaveBeenCalledTimes(8);
    expect(source.unsubscribeMessages).toHaveBeenCalledExactlyOnceWith({
      key: rows[2]!.key,
      agentId: null,
    });

    rows[2]!.updatedAt = 200;
    narration.sync(input);
    expect(source.subscribeMessages).toHaveBeenCalledTimes(8);
    narration.sync({ ...input, connectionIdentity: {} });
    await Promise.all(source.subscribeMessages.mock.results.map(({ value }) => value));
    expect(source.subscribeMessages).toHaveBeenCalledTimes(15);
    expect(source.subscribeMessages.mock.calls.slice(8).map(([key]) => key)).toContain(
      rows[2]!.key,
    );
    expect(source.unsubscribeMessages).toHaveBeenCalledTimes(8);
    narration.disconnect();
    expect(source.unsubscribeMessages).toHaveBeenCalledTimes(15);
  });

  it("releases hidden narration interests while preserving selected-pane and outbox owners", async () => {
    const visibility = browserVisibility();
    const wireKeys = new Set<string>();
    const request = vi.fn().mockImplementation(async (method: string, params: { key: string }) => {
      if (method === "sessions.messages.subscribe") {
        wireKeys.add(params.key);
      } else if (method === "sessions.messages.unsubscribe") {
        wireKeys.delete(params.key);
      }
      return { key: params.key };
    });
    const coordinator = new GatewaySessionMessageSubscriptionCoordinator({ request });
    const source = {
      subscribeMessages: vi.fn<SessionCapability["subscribeMessages"]>((key, options) =>
        coordinator.acquire(key, options),
      ),
      unsubscribeMessages: vi.fn<SessionCapability["unsubscribeMessages"]>((handle) =>
        coordinator.release(handle),
      ),
    };
    const selectedPane = await coordinator.acquire("agent:main:open");
    const outbox = await coordinator.acquire("agent:main:background-0");
    const { narration, input, emit } = startNarration(source, {
      connectionIdentity: coordinator,
      openSessionKey: selectedPane.key,
      rows: [
        runningRow(selectedPane.key),
        ...Array.from({ length: 8 }, (_, index) => runningRow(`agent:main:background-${index}`)),
      ],
    });
    const settleSubscriptions = () =>
      Promise.all(source.subscribeMessages.mock.results.map((result) => result.value));
    const snapshot = (text: string) =>
      gatewayEvent("chat", {
        sessionKey: selectedPane.key,
        runId: "run-1",
        message: assistant(text),
      });

    const handles = await settleSubscriptions();
    expect(wireKeys.size).toBe(7);
    emit(snapshot("Before hiding."));
    emit(snapshot("Queued old narration."));
    expect(vi.getTimerCount()).toBe(1);

    visibility("hidden");
    visibility("hidden");
    narration.sync(input);
    expect(source.unsubscribeMessages.mock.calls.map(([handle]) => handle)).toEqual(handles);
    expect([...wireKeys]).toEqual([selectedPane.key, outbox.key]);
    expect(vi.getTimerCount()).toBe(0);
    emit(snapshot("Hidden update."));
    expect(narration.read().lines.size).toBe(0);
    expect(source.subscribeMessages).toHaveBeenCalledTimes(7);

    // Rows can settle or change while this tab is hidden.
    narration.sync({
      ...input,
      rows: [runningRow(selectedPane.key), runningRow("agent:main:new")],
    });
    visibility("visible");
    visibility("visible");
    await settleSubscriptions();
    expect(source.subscribeMessages).toHaveBeenCalledTimes(9);
    expect([...wireKeys]).toEqual([selectedPane.key, outbox.key, "agent:main:new"]);
    emit(snapshot("Back in view."));
    expect(narration.read().lines.get(selectedPane.key)).toBe("Back in view.");

    narration.disconnect();
    visibility("hidden");
    visibility("visible");
    expect(source.subscribeMessages).toHaveBeenCalledTimes(9);
    expect(source.unsubscribeMessages).toHaveBeenCalledTimes(9);
    expect([...wireKeys]).toEqual([selectedPane.key, outbox.key]);
    await coordinator.release(selectedPane);
    await coordinator.release(outbox);
    expect(wireKeys.size).toBe(0);
  });

  it.each(["visibility", "rows", "source"] as const)(
    "releases late subscription handles through their original owner after %s changes",
    async (boundary) => {
      const visibility = browserVisibility();
      const first = createDeferred<{ key: string; agentId: null }>();
      const second = createDeferred<{ key: string; agentId: null }>();
      const source = {
        subscribeMessages: vi
          .fn()
          .mockReturnValueOnce(first.promise)
          .mockReturnValueOnce(second.promise),
        unsubscribeMessages: vi.fn<SessionCapability["unsubscribeMessages"]>(() =>
          Promise.resolve(),
        ),
      };
      const { narration, input } = startNarration(source);
      if (boundary === "visibility") {
        visibility("hidden");
        visibility("visible");
      } else if (boundary === "rows") {
        narration.sync({ ...input, rows: [] });
        narration.sync(input);
      } else {
        narration.sync({
          ...input,
          rows: [],
          source: {
            subscribeMessages: vi.fn(),
            unsubscribeMessages: vi.fn(() => Promise.resolve()),
          },
        });
      }
      const current = { key: runKey, agentId: null };
      if (boundary !== "source") {
        expect(source.subscribeMessages).toHaveBeenCalledTimes(2);
        second.resolve(current);
        await second.promise;
      }
      const stale = { key: runKey, agentId: null };
      first.resolve(stale);
      await first.promise;
      expect(source.unsubscribeMessages).toHaveBeenCalledExactlyOnceWith(stale);
      expect(source.unsubscribeMessages.mock.calls[0]?.[0]).toBe(stale);
      narration.disconnect();
      expect(source.unsubscribeMessages).toHaveBeenCalledTimes(boundary === "source" ? 1 : 2);
      if (boundary !== "source") {
        expect(source.unsubscribeMessages.mock.calls[1]?.[0]).toBe(current);
      }
    },
  );

  it("defers initial hidden subscriptions and honors disabled intent on return", async () => {
    const visibility = browserVisibility("hidden");
    const source = messageSource();
    const { narration, input } = startNarration(source);
    expect(source.subscribeMessages).not.toHaveBeenCalled();
    visibility("visible");
    await Promise.resolve();
    expect(source.subscribeMessages).toHaveBeenCalledOnce();
    visibility("hidden");
    narration.sync({ ...input, enabled: false, connectionIdentity: {} });
    visibility("visible");
    expect(source.subscribeMessages).toHaveBeenCalledOnce();
    expect(source.unsubscribeMessages).toHaveBeenCalledOnce();
    narration.disconnect();
  });

  it("subscribes only to sessions with a projected active run", async () => {
    const source = messageSource();
    const { subscribeMessages } = source;
    const rows: SidebarRecentSession[] = [
      { ...runningRow("agent:main:stale"), hasActiveRun: false, status: "running" },
      { ...runningRow("agent:main:failed"), hasActiveRun: false, status: "failed" },
      runningRow("agent:main:active"),
    ];

    const { narration } = startNarration(source, { rows });
    await Promise.resolve();

    expect(subscribeMessages).toHaveBeenCalledTimes(1);
    expect(subscribeMessages).toHaveBeenCalledWith("agent:main:active", {
      agentId: undefined,
      mode: "narration",
    });

    narration.disconnect();
  });

  it("renders paced digests immediately and keeps the final line after queued tool activity", async () => {
    const { narration, emit } = narrationFixture();
    const tool = () =>
      runEvent("session.tool", {
        stream: "tool",
        data: { phase: "start", name: "read" },
      });

    emit(tool());
    emit(digest("**Reading** source."));
    expect(narration.read().lines.get(runKey)).toBe("Reading source.");
    await vi.advanceTimersByTimeAsync(SIDEBAR_NARRATION_THROTTLE_MS);
    emit(digest("Earlier.\n\nChecks are **passing**."));
    expect(narration.read().lines.get(runKey)).toBe("Checks are passing.");

    emit(tool());
    await vi.advanceTimersByTimeAsync(100);
    emit(digest("Final result."));
    emit(
      runEvent("chat", {
        state: "final",
        message: assistant("Final result."),
      }),
    );
    expect(narration.read().lines.get(runKey)).toBe("Final result.");
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(SIDEBAR_NARRATION_THROTTLE_MS);
    expect(narration.read().lines.get(runKey)).toBe("Final result.");
    narration.disconnect();
  });

  it("scopes digest replacements and retracts hidden content across run boundaries", () => {
    const { narration, emit } = narrationFixture();

    emit(digest("Visible progress."));
    emit(
      gatewayEvent("session.narration", {
        sessionKey: "agent:main:other",
        runId: "run-1",
        text: "An unrelated session.",
      }),
    );
    emit(gatewayEvent("session.narration", { sessionKey: runKey, text: "No run identity." }));
    expect(narration.read().lines.get(runKey)).toBe("Visible progress.");

    for (const text of ["", "HEARTBEAT_OK"]) {
      emit(digest("Visible draft."));
      emit(digest(text));
      expect(narration.read().lines.has(runKey)).toBe(false);
    }
    emit(digest("Previous run result."));
    emit(
      gatewayEvent("agent", {
        sessionKey: runKey,
        runId: "run-2",
        stream: "lifecycle",
        data: { phase: "start" },
      }),
    );
    expect(narration.read().lines.has(runKey)).toBe(false);
    emit(
      gatewayEvent("session.narration", {
        sessionKey: runKey,
        runId: "run-2",
        text: "New run progress.",
      }),
    );
    expect(narration.read().lines.get(runKey)).toBe("New run progress.");
    narration.disconnect();
  });

  it.each(["final", "aborted", "error"])(
    "settles queued full-owner narration immediately on %s",
    (state) => {
      const { narration, emit } = narrationFixture();
      emit(chatDelta("Initial work."));
      emit(chatDelta("Last visible result."));
      expect(narration.read().lines.get(runKey)).toBe("Initial work.");

      emit(
        runEvent("chat", {
          state,
          ...(state === "final" ? { message: assistant("Final corrected result.") } : {}),
        }),
      );
      expect(narration.read().lines.get(runKey)).toBe(
        state === "final" ? "Final corrected result." : "Last visible result.",
      );
      expect(vi.getTimerCount()).toBe(0);
      narration.disconnect();
    },
  );

  it("hands subtitle ownership only to a run-identified digest", async () => {
    const { narration, emit } = narrationFixture();

    emit(chatDelta("Reading source"));
    emit(toolEvent("read"));
    expect(narration.read().tools.get(runKey)?.name).toBe("read");
    expect(narration.read().lines.get(runKey)).toBe("Reading source");

    emit(
      gatewayEvent("session.observer", {
        sessionKey: runKey,
        revision: 1,
        updatedAt: 10_000,
        headline: "Run-less digest",
        health: "on-track",
      }),
    );
    expect(narration.read().observerDigests.size).toBe(0);
    await vi.advanceTimersByTimeAsync(SIDEBAR_NARRATION_THROTTLE_MS);
    emit(toolEvent("list"));
    expect(narration.read().tools.get(runKey)?.name).toBe("list");
    expect(narration.read().lines.get(runKey)).toBe("Reading source");

    emit(observer("Reviewing source"));
    expect(narration.read().lines.has(runKey)).toBe(false);
    expect(narration.read().observerDigests.get(runKey)?.headline).toBe("Reviewing source");

    const previousDigests = narration.read().observerDigests;
    emit(observer("Invalid replacement", { runId: "run-2", revision: 0, updatedAt: 10_001 }));
    expect(narration.read().observerDigests).toBe(previousDigests);
    expect(narration.read().observerDigests.get(runKey)?.headline).toBe("Reviewing source");

    emit(toolEvent("test"));
    emit(digest("Raw narration."));
    expect(narration.read().lines.has(runKey)).toBe(false);

    emit(toolEvent("test", { runId: "run-2" }));
    expect(narration.read().observerDigests.has(runKey)).toBe(false);
    expect(narration.read().tools.get(runKey)?.name).toBe("test");
    expect(narration.read().lines.get(runKey)).toBeUndefined();
  });

  it("rebinds an active global session when the selected agent changes", async () => {
    const subscribeMessages = vi.fn((key: string, options?: { agentId?: string | null }) =>
      Promise.resolve({ key, agentId: options?.agentId ?? null }),
    );
    const unsubscribeMessages = vi.fn(() => Promise.resolve());
    const source = { subscribeMessages, unsubscribeMessages };
    const { narration, input, emit } = startNarration(source, {
      rows: [runningRow("global")],
    });
    await Promise.resolve();
    emit(
      gatewayEvent("chat", {
        sessionKey: "global",
        agentId: "main",
        state: "delta",
        deltaText: "Old agent work.",
        message: assistant("Old agent work."),
      }),
    );
    expect(narration.read().lines.get("global")).toBe("Old agent work.");

    narration.sync({ ...input, agentId: "research" });
    await Promise.resolve();

    expect(unsubscribeMessages).toHaveBeenCalledWith({ key: "global", agentId: "main" });
    expect(subscribeMessages).toHaveBeenLastCalledWith("global", {
      agentId: "research",
      mode: "narration",
    });
    expect(narration.read().lines.has("global")).toBe(false);
  });

  type Step = [
    event: GatewayEventFrame,
    expected?: string | false | ((line: string) => void),
    advance?: true,
  ];
  const scenario = (name: string, ...steps: Step[]): [string, Step[]] => [name, steps];
  const internal = "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>";
  const internalEnd = "<<<END_OPENCLAW_INTERNAL_CONTEXT>>>";
  const preamble = `Preamble ${"x".repeat(20_000)}`;
  it.each([
    scenario("last prose paragraph", [
      chatDelta(
        "# Plan\n\nFirst **check** finished.\n\n```ts\nconst answer = 1;\n```\nFinal _verification_ is running.",
      ),
      "Final verification is running.",
    ]),
    scenario("whitespace and ellipsis", [
      chatDelta(`Earlier.\n\n- ${"result ".repeat(30)}`),
      (line) => {
        expect(line).toHaveLength(120);
        expect(line.endsWith("…")).toBe(true);
        expect(line).not.toContain("  ");
      },
    ]),
    scenario("mid-run cumulative snapshot", [
      chatFrame({
        state: "delta",
        deltaText: "les now.",
        message: assistant([{ type: "text", text: "Reading files now." }]),
      }),
      "Reading files now.",
    ]),
    scenario(
      "overlapping agent and chat deltas",
      [chatDelta("Reading"), undefined],
      [
        runEvent("agent", {
          stream: "assistant",
          data: { delta: " files" },
        }),
        undefined,
      ],
      [chatDelta(undefined, " files"), "Reading files", true],
    ),
    scenario("snapshot display normalization", [
      chatDelta(
        `Visible work is complete.\n<think>private reasoning</think>\n${internal}\nprivate runtime details\n${internalEnd}\n[[audio_as_voice]]\nREPLY_SKIP`,
      ),
      "REPLY_SKIP",
    ]),
    scenario("trailing heartbeat token", [
      chatDelta(`${"Visible progress continues. ".repeat(16)}Final visible status. HEARTBEAT_OK`),
      (line: string) => {
        expect(line).toBe("Final visible status.");
        expect(line).not.toContain("HEARTBEAT_OK");
      },
    ]),
    scenario(
      "truncated internal block",
      [
        chatDelta(`Visible setup.\n${internal}\n${"private runtime detail ".repeat(1_000)}`),
        "Visible setup.",
      ],
      [chatDelta(undefined, `\n${internalEnd}\nFinal bounded line.`), "Final bounded line.", true],
    ),
    scenario(
      "partial internal delimiter",
      [chatDelta("Visible setup.\n<<<BEGIN_OPENCLAW_INTERNAL_CONT"), "Visible setup."],
      [chatDelta(undefined, "EXT>>>\nprivate runtime detail"), "Visible setup."],
    ),
    scenario(
      "replacement resets internal streaming state",
      [
        chatDelta(`${internal}\nprivate runtime text`, `${internal}\nprivate runtime text`),
        undefined,
      ],
      [chatDelta(undefined, "Replacement", true), undefined],
      [chatDelta(undefined, " now."), "Replacement now.", true],
    ),
    scenario(
      "nested internal block outlives the raw buffer",
      [
        chatDelta(
          `Visible setup.\n${internal}\n${"private outer runtime detail ".repeat(1_000)}\n${internal}\n${"private nested runtime detail ".repeat(1_000)}\n${internalEnd}`,
        ),
        "Visible setup.",
      ],
      [chatDelta(undefined, "\nStill private after the nested block."), "Visible setup.", true],
      [chatDelta(undefined, `\n${internalEnd}\nFinal public line.`), "Final public line.", true],
    ),
    scenario(
      "corrected replacement",
      [chatDelta("Draft answer."), undefined],
      [chatDelta("Corrected answer.", "Corrected answer.", true), "Corrected answer.", true],
    ),
    scenario(
      "silent join until cumulative alignment",
      [chatFrame({ deltaText: "secret internal continuation." }), false, true],
      [
        chatSnapshot("Public progress line. Visible update.", { deltaText: " Visible update." }),
        "Visible update.",
        true,
      ],
    ),
    scenario(
      "empty replacement retracts shown text",
      [chatSnapshot("Withdrawn draft."), "Withdrawn draft.", true],
      [chatFrame({ deltaText: "", replace: true }), false, true],
    ),
    scenario(
      "suppressed replacement retracts shown text",
      [chatDelta("Draft that gets withdrawn."), "Draft that gets withdrawn.", true],
      [chatDelta("HEARTBEAT_OK", "HEARTBEAT_OK", true), undefined],
      [chatDelta("", "", true), false, true],
    ),
    scenario(
      "new run discards accumulated deltas",
      [chatSnapshot("Unfinished old work", { state: "delta", runId: "first" }), undefined],
      [chatSnapshot("New run work.", { state: "delta", runId: "second" }), "New run work."],
    ),
    scenario(
      "newest sentence beyond the retained tail",
      [chatSnapshot(preamble, { state: "delta", runId: "long" }), undefined, true],
      [
        chatSnapshot(`${preamble}. Final bounded line.`, {
          runId: "long",
          state: "delta",
          deltaText: ". Final bounded line.",
        }),
        "Final bounded line.",
      ],
    ),
  ])("publishes narration for %s", async (_name, steps) => {
    const { narration, emit } = narrationFixture();
    for (const [event, expected, advance] of steps) {
      emit(event);
      if (advance) {
        await vi.advanceTimersByTimeAsync(SIDEBAR_NARRATION_THROTTLE_MS);
      }
      const lines = narration.read().lines;
      if (expected === false) {
        expect(lines?.has(runKey) ?? false).toBe(false);
      } else if (typeof expected === "string") {
        expect(lines?.get(runKey)).toBe(expected);
      }
      if (typeof expected === "function") {
        const line = lines?.get(runKey);
        expect(line).toBeDefined();
        expected(line!);
      }
    }
    narration.disconnect();
  });
});
