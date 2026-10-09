import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// @vitest-environment node
import { GatewayProtocolRequestError } from "../../../packages/gateway-client/src/protocol-request.js";
import { GatewaySessionMessageSubscriptionCoordinator } from "../../../packages/gateway-client/src/session-subscriptions.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { GatewayEventFrame } from "../api/gateway.ts";
import type { SessionCapability } from "../lib/sessions/index.ts";
import {
  browserVisibility,
  createRunningNarrationController,
  runningRow,
} from "../test-helpers/app-sidebar-session-narration.ts";
import {
  SidebarSessionNarrationController,
  type SidebarNarrationSyncInput,
} from "./app-sidebar-session-narration.ts";
import type { SidebarRecentSession, SidebarToolActivity } from "./app-sidebar-session-types.ts";
import "../test-helpers/app-sidebar-tool-activity-cases.ts";

// Mirrors the controller-internal throttle; asserting through timers keeps the
// constant unexported (production-only export policy).
const SIDEBAR_NARRATION_THROTTLE_MS = 2_000;

function gatewayEvent(eventName: string, payload: unknown): GatewayEventFrame {
  return { type: "event", event: eventName, payload };
}

function chatDelta(text?: string, deltaText?: string, replace?: boolean): GatewayEventFrame {
  return gatewayEvent("chat", {
    sessionKey: "agent:main:run",
    runId: "run-1",
    state: "delta",
    deltaText,
    replace,
    ...(text === undefined ? {} : { message: { role: "assistant", content: text } }),
  });
}

function narrationFixture() {
  return createRunningNarrationController({
    subscribeMessages: vi.fn(() => Promise.resolve({ key: "agent:main:run", agentId: null })),
    unsubscribeMessages: vi.fn(() => Promise.resolve()),
  });
}

function chatFrame(payload: Record<string, unknown>): GatewayEventFrame {
  return gatewayEvent("chat", { sessionKey: "agent:main:run", runId: "run-1", ...payload });
}

describe("SidebarSessionNarrationController", () => {
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
    const source = {
      subscribeMessages: vi.fn(async (key: string) => {
        await ready.promise;
        return { key, agentId: null };
      }),
      unsubscribeMessages: vi.fn(() => Promise.resolve()),
    };
    const rows = Array.from({ length: 8 }, (_, index) => ({
      ...runningRow(`agent:main:run-${index}`),
      startedAt: undefined,
      updatedAt: index,
    }));
    const input: SidebarNarrationSyncInput = {
      enabled: true,
      connected: true,
      connectionIdentity: {},
      source,
      rows,
      openSessionKey: "",
      agentId: "main",
    };
    const controller = new SidebarSessionNarrationController(() => undefined);
    controller.sync(input);
    rows[0]!.updatedAt = 100;
    controller.sync({ ...input, rows: rows.toReversed() });
    expect(source.subscribeMessages).toHaveBeenCalledTimes(6);

    controller.sync({ ...input, openSessionKey: rows[0]!.key });
    ready.resolve();
    await Promise.all(source.subscribeMessages.mock.results.map(({ value }) => value));
    expect(source.subscribeMessages).toHaveBeenCalledTimes(7);
    expect(source.unsubscribeMessages).not.toHaveBeenCalled();

    input.openSessionKey = rows[1]!.key;
    controller.sync(input);
    await source.subscribeMessages.mock.results.at(-1)?.value;
    expect(source.subscribeMessages).toHaveBeenCalledTimes(8);
    expect(source.unsubscribeMessages).toHaveBeenCalledExactlyOnceWith({
      key: rows[2]!.key,
      agentId: null,
    });

    rows[2]!.updatedAt = 200;
    controller.sync(input);
    expect(source.subscribeMessages).toHaveBeenCalledTimes(8);
    controller.sync({ ...input, connectionIdentity: {} });
    await Promise.all(source.subscribeMessages.mock.results.map(({ value }) => value));
    expect(source.subscribeMessages).toHaveBeenCalledTimes(15);
    expect(source.subscribeMessages.mock.calls.slice(8).map(([key]) => key)).toContain(
      rows[2]!.key,
    );
    expect(source.unsubscribeMessages).toHaveBeenCalledTimes(8);
    controller.disconnect();
    expect(source.unsubscribeMessages).toHaveBeenCalledTimes(15);
  });

  it.each([
    { retirement: "hidden", late: false },
    { retirement: "hidden", late: true },
    { retirement: "disposed", late: false },
    { retirement: "disposed", late: true },
  ])(
    "retains a failed $retirement release (late acquisition: $late)",
    async ({ retirement, late }) => {
      vi.spyOn(Math, "random").mockReturnValue(0.5);
      const visibility = browserVisibility();
      const subscribed = createDeferred();
      const released = createDeferred();
      const wireKeys = new Set<string>();
      let releases = 0;
      const request = vi
        .fn()
        .mockImplementation(async (method: string, params: { key: string }) => {
          if (method === "sessions.messages.subscribe") {
            await subscribed.promise;
            wireKeys.add(params.key);
          } else {
            releases += 1;
            if (releases === 1) {
              throw new GatewayProtocolRequestError({ retryable: true });
            }
            await released.promise;
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
      const { controller } = createRunningNarrationController(source);
      const retire = () =>
        retirement === "disposed" ? controller.dispose() : visibility("hidden");
      if (late) {
        retire();
      }
      subscribed.resolve();
      const handle = await source.subscribeMessages.mock.results[0]?.value;
      retire();
      await vi.advanceTimersByTimeAsync(0);
      expect(wireKeys.size).toBe(1);

      retire();
      retire();
      expect(source.unsubscribeMessages.mock.calls).toEqual([[handle]]);
      await vi.advanceTimersByTimeAsync(250);
      expect(source.unsubscribeMessages.mock.calls).toEqual([[handle], [handle]]);
      visibility("visible");
      expect(releases).toBe(2);
      released.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(wireKeys.size).toBe(retirement === "disposed" ? 0 : 1);
      expect(source.subscribeMessages).toHaveBeenCalledTimes(retirement === "disposed" ? 1 : 2);

      controller.disconnect();
      await vi.advanceTimersByTimeAsync(0);
      expect(wireKeys.size).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

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
    const updates: Array<ReadonlyMap<string, string>> = [];
    const controller = new SidebarSessionNarrationController((lines) => updates.push(lines));
    const input: SidebarNarrationSyncInput = {
      enabled: true,
      connected: true,
      connectionIdentity: coordinator,
      source,
      agentId: "main",
      openSessionKey: selectedPane.key,
      rows: [
        runningRow(selectedPane.key),
        ...Array.from({ length: 8 }, (_, index) => runningRow(`agent:main:background-${index}`)),
      ],
    };
    const settleSubscriptions = () =>
      Promise.all(source.subscribeMessages.mock.results.map((result) => result.value));
    const snapshot = (text: string) =>
      gatewayEvent("chat", {
        sessionKey: selectedPane.key,
        runId: "run-1",
        message: { role: "assistant", content: text },
      });

    controller.sync(input);
    const handles = await settleSubscriptions();
    expect(wireKeys.size).toBe(7);
    controller.handleEvent(snapshot("Before hiding."));
    controller.handleEvent(snapshot("Queued old narration."));
    expect(vi.getTimerCount()).toBe(1);

    visibility("hidden");
    visibility("hidden");
    controller.sync(input);
    expect(source.unsubscribeMessages.mock.calls.map(([handle]) => handle)).toEqual(handles);
    expect([...wireKeys]).toEqual([selectedPane.key, outbox.key]);
    expect(vi.getTimerCount()).toBe(0);
    controller.handleEvent(snapshot("Hidden update from the selected pane."));
    expect(updates.at(-1)?.size).toBe(0);
    expect(source.subscribeMessages).toHaveBeenCalledTimes(7);

    // Rows can settle or change while this tab is hidden.
    controller.sync({
      ...input,
      rows: [runningRow(selectedPane.key), runningRow("agent:main:new")],
    });
    visibility("visible");
    visibility("visible");
    await settleSubscriptions();
    expect(source.subscribeMessages).toHaveBeenCalledTimes(9);
    expect([...wireKeys]).toEqual([selectedPane.key, outbox.key, "agent:main:new"]);
    controller.handleEvent(snapshot("Current narration after returning."));
    expect(updates.at(-1)?.get(selectedPane.key)).toBe("Current narration after returning.");

    controller.disconnect();
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
      const { controller, input } = createRunningNarrationController(source);
      if (boundary === "visibility") {
        visibility("hidden");
        visibility("visible");
      } else if (boundary === "rows") {
        controller.sync({ ...input, rows: [] });
        controller.sync(input);
      } else {
        controller.sync({
          ...input,
          rows: [],
          source: {
            subscribeMessages: vi.fn(),
            unsubscribeMessages: vi.fn(() => Promise.resolve()),
          },
        });
      }
      const current = { key: "agent:main:run", agentId: null };
      if (boundary !== "source") {
        expect(source.subscribeMessages).toHaveBeenCalledTimes(2);
        second.resolve(current);
        await second.promise;
      }
      const stale = { key: "agent:main:run", agentId: null };
      first.resolve(stale);
      await first.promise;
      expect(source.unsubscribeMessages).toHaveBeenCalledExactlyOnceWith(stale);
      expect(source.unsubscribeMessages.mock.calls[0]?.[0]).toBe(stale);
      controller.disconnect();
      expect(source.unsubscribeMessages).toHaveBeenCalledTimes(boundary === "source" ? 1 : 2);
      if (boundary !== "source") {
        expect(source.unsubscribeMessages.mock.calls[1]?.[0]).toBe(current);
      }
    },
  );

  it("defers initial hidden subscriptions and honors disabled intent on return", async () => {
    const visibility = browserVisibility("hidden");
    const source = {
      subscribeMessages: vi.fn((key: string) => Promise.resolve({ key, agentId: null })),
      unsubscribeMessages: vi.fn(() => Promise.resolve()),
    };
    const { controller } = createRunningNarrationController(source);
    expect(source.subscribeMessages).not.toHaveBeenCalled();
    visibility("visible");
    await Promise.resolve();
    expect(source.subscribeMessages).toHaveBeenCalledOnce();
    visibility("hidden");
    controller.sync({
      enabled: false,
      connected: true,
      connectionIdentity: {},
      source,
      rows: [runningRow("agent:main:run")],
      openSessionKey: "",
      agentId: "main",
    });
    visibility("visible");
    expect(source.subscribeMessages).toHaveBeenCalledOnce();
    expect(source.unsubscribeMessages).toHaveBeenCalledOnce();
    controller.disconnect();
  });

  it("subscribes only to sessions with a projected active run", async () => {
    const subscribeMessages = vi.fn((key: string) => Promise.resolve({ key, agentId: null }));
    const unsubscribeMessages = vi.fn(() => Promise.resolve());
    const source = { subscribeMessages, unsubscribeMessages };
    const controller = new SidebarSessionNarrationController(() => undefined);
    const rows: SidebarRecentSession[] = [
      { ...runningRow("agent:main:stale"), hasActiveRun: false, status: "running" },
      { ...runningRow("agent:main:failed"), hasActiveRun: false, status: "failed" },
      runningRow("agent:main:active"),
    ];

    controller.sync({
      enabled: true,
      connected: true,
      connectionIdentity: {},
      source,
      openSessionKey: "",
      rows,
      agentId: "main",
    });
    await Promise.resolve();

    expect(subscribeMessages).toHaveBeenCalledTimes(1);
    expect(subscribeMessages).toHaveBeenCalledWith("agent:main:active", {
      agentId: undefined,
      mode: "narration",
    });

    controller.disconnect();
  });

  it("renders paced digests immediately and keeps the final line after queued tool activity", async () => {
    const { controller, updates } = narrationFixture();
    const digest = (text: string) =>
      gatewayEvent("session.narration", { sessionKey: "agent:main:run", runId: "run-1", text });
    const tool = () =>
      gatewayEvent("session.tool", {
        sessionKey: "agent:main:run",
        runId: "run-1",
        stream: "tool",
        data: { phase: "start", name: "read" },
      });

    controller.handleEvent(tool());
    controller.handleEvent(digest("**Reading** the current implementation."));
    expect(updates.at(-1)?.get("agent:main:run")).toBe("Reading the current implementation.");
    await vi.advanceTimersByTimeAsync(SIDEBAR_NARRATION_THROTTLE_MS);
    controller.handleEvent(digest("Earlier paragraph.\n\nChecks are **passing**."));
    expect(updates.at(-1)?.get("agent:main:run")).toBe("Checks are passing.");

    controller.handleEvent(tool());
    await vi.advanceTimersByTimeAsync(100);
    controller.handleEvent(digest("Final result is correct."));
    controller.handleEvent(
      gatewayEvent("chat", {
        sessionKey: "agent:main:run",
        runId: "run-1",
        state: "final",
        message: { role: "assistant", content: "Final result is correct." },
      }),
    );
    expect(updates.at(-1)?.get("agent:main:run")).toBe("Final result is correct.");
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(SIDEBAR_NARRATION_THROTTLE_MS);
    expect(updates.at(-1)?.get("agent:main:run")).toBe("Final result is correct.");
    controller.disconnect();
  });

  it("scopes digest replacements and retracts hidden content across run boundaries", () => {
    const { controller, updates } = narrationFixture();
    const digest = (text: string) =>
      gatewayEvent("session.narration", { sessionKey: "agent:main:run", runId: "run-1", text });

    controller.handleEvent(digest("First visible progress."));
    controller.handleEvent(
      gatewayEvent("session.narration", {
        sessionKey: "agent:main:other",
        runId: "run-1",
        text: "An unrelated session.",
      }),
    );
    controller.handleEvent(
      gatewayEvent("session.narration", { sessionKey: "agent:main:run", text: "No run identity." }),
    );
    expect(updates.at(-1)?.get("agent:main:run")).toBe("First visible progress.");

    for (const text of ["", "REPLY_SKIP", "HEARTBEAT_OK"]) {
      controller.handleEvent(digest("Visible draft."));
      controller.handleEvent(digest(text));
      expect(updates.at(-1)?.has("agent:main:run")).toBe(false);
    }
    controller.handleEvent(digest("Previous run result."));
    controller.handleEvent(
      gatewayEvent("agent", {
        sessionKey: "agent:main:run",
        runId: "run-2",
        stream: "lifecycle",
        data: { phase: "start" },
      }),
    );
    expect(updates.at(-1)?.has("agent:main:run")).toBe(false);
    controller.handleEvent(
      gatewayEvent("session.narration", {
        sessionKey: "agent:main:run",
        runId: "run-2",
        text: "New run progress.",
      }),
    );
    expect(updates.at(-1)?.get("agent:main:run")).toBe("New run progress.");
    controller.disconnect();
  });

  it.each(["final", "aborted", "error"])(
    "settles queued full-owner narration immediately on %s",
    (state) => {
      const source = {
        subscribeMessages: vi.fn(() => Promise.resolve({ key: "agent:main:run", agentId: null })),
        unsubscribeMessages: vi.fn(() => Promise.resolve()),
      };
      const { controller, updates } = createRunningNarrationController(source);
      controller.handleEvent(chatDelta("Initial work."));
      controller.handleEvent(chatDelta("Last visible result."));
      expect(updates.at(-1)?.get("agent:main:run")).toBe("Initial work.");

      controller.handleEvent(
        gatewayEvent("chat", {
          sessionKey: "agent:main:run",
          runId: "run-1",
          state,
          ...(state === "final"
            ? { message: { role: "assistant", content: "Final corrected result." } }
            : {}),
        }),
      );
      expect(updates.at(-1)?.get("agent:main:run")).toBe(
        state === "final" ? "Final corrected result." : "Last visible result.",
      );
      expect(vi.getTimerCount()).toBe(0);
      controller.disconnect();
    },
  );

  it("hands subtitle ownership only to a run-identified digest", async () => {
    const source = {
      subscribeMessages: vi.fn(() => Promise.resolve({ key: "agent:main:run", agentId: null })),
      unsubscribeMessages: vi.fn(() => Promise.resolve()),
    };
    const lines: Array<ReadonlyMap<string, string>> = [];
    const digests: Array<ReadonlyMap<string, { headline: string }>> = [];
    const tools: Array<ReadonlyMap<string, SidebarToolActivity>> = [];
    const controller = new SidebarSessionNarrationController(
      (next) => lines.push(next),
      (next) => digests.push(next),
      (next) => tools.push(next),
    );
    controller.sync({
      enabled: true,
      connected: true,
      connectionIdentity: {},
      source,
      openSessionKey: "",
      rows: [runningRow("agent:main:run")],
      agentId: "main",
    });

    controller.handleEvent(chatDelta("Reading source"));
    controller.handleEvent(
      gatewayEvent("agent", {
        sessionKey: "agent:main:run",
        runId: "run-1",
        stream: "tool",
        data: { name: "read" },
      }),
    );
    expect(tools.at(-1)?.get("agent:main:run")?.name).toBe("read");
    expect(lines.at(-1)?.get("agent:main:run")).toBe("Reading source");

    controller.handleEvent(
      gatewayEvent("session.observer", {
        sessionKey: "agent:main:run",
        revision: 1,
        updatedAt: 10_000,
        headline: "Run-less digest",
        health: "on-track",
      }),
    );
    expect(digests).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(SIDEBAR_NARRATION_THROTTLE_MS);
    controller.handleEvent(
      gatewayEvent("agent", {
        sessionKey: "agent:main:run",
        runId: "run-1",
        stream: "tool",
        data: { name: "list" },
      }),
    );
    expect(tools.at(-1)?.get("agent:main:run")?.name).toBe("list");
    expect(lines.at(-1)?.get("agent:main:run")).toBe("Reading source");

    controller.handleEvent(
      gatewayEvent("session.observer", {
        sessionKey: "agent:main:run",
        runId: "run-1",
        revision: 1,
        updatedAt: 10_000,
        headline: "Reviewing the current implementation",
        health: "on-track",
      }),
    );
    expect(lines.at(-1)?.has("agent:main:run")).toBe(false);
    expect(digests.at(-1)?.get("agent:main:run")?.headline).toBe(
      "Reviewing the current implementation",
    );

    const digestUpdateCount = digests.length;
    controller.handleEvent(
      gatewayEvent("session.observer", {
        sessionKey: "agent:main:run",
        runId: "run-2",
        revision: 0,
        updatedAt: 10_001,
        headline: "Invalid replacement",
        health: "on-track",
      }),
    );
    expect(digests).toHaveLength(digestUpdateCount);
    expect(digests.at(-1)?.get("agent:main:run")?.headline).toBe(
      "Reviewing the current implementation",
    );

    controller.handleEvent(
      gatewayEvent("agent", {
        sessionKey: "agent:main:run",
        runId: "run-1",
        stream: "tool",
        data: { name: "test" },
      }),
    );
    controller.handleEvent(
      gatewayEvent("session.narration", {
        sessionKey: "agent:main:run",
        runId: "run-1",
        text: "Raw narration does not replace an observer headline.",
      }),
    );
    expect(lines.at(-1)?.has("agent:main:run")).toBe(false);

    controller.handleEvent(
      gatewayEvent("agent", {
        sessionKey: "agent:main:run",
        runId: "run-2",
        stream: "tool",
        data: { name: "test" },
      }),
    );
    expect(digests.at(-1)?.has("agent:main:run")).toBe(false);
    expect(tools.at(-1)?.get("agent:main:run")?.name).toBe("test");
    expect(lines.at(-1)?.get("agent:main:run")).toBeUndefined();
  });

  it("rebinds an active global session when the selected agent changes", async () => {
    const subscribeMessages = vi.fn((key: string, options?: { agentId?: string | null }) =>
      Promise.resolve({ key, agentId: options?.agentId ?? null }),
    );
    const unsubscribeMessages = vi.fn(() => Promise.resolve());
    const source = { subscribeMessages, unsubscribeMessages };
    const updates: Array<ReadonlyMap<string, string>> = [];
    const controller = new SidebarSessionNarrationController((lines) => updates.push(lines));
    const base = {
      enabled: true,
      connected: true,
      connectionIdentity: {},
      source,
      openSessionKey: "",
      rows: [runningRow("global")],
    };

    controller.sync({ ...base, agentId: "main" });
    await Promise.resolve();
    controller.handleEvent(
      gatewayEvent("chat", {
        sessionKey: "global",
        agentId: "main",
        state: "delta",
        deltaText: "Old agent work.",
        message: { role: "assistant", content: "Old agent work." },
      }),
    );
    expect(updates.at(-1)?.get("global")).toBe("Old agent work.");

    controller.sync({ ...base, agentId: "research" });
    await Promise.resolve();

    expect(unsubscribeMessages).toHaveBeenCalledWith({ key: "global", agentId: "main" });
    expect(subscribeMessages).toHaveBeenLastCalledWith("global", {
      agentId: "research",
      mode: "narration",
    });
    expect(updates.at(-1)?.has("global")).toBe(false);
  });

  const internal = "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>";
  const internalEnd = "<<<END_OPENCLAW_INTERNAL_CONTEXT>>>";
  const preamble = `Preamble ${"x".repeat(20_000)}`;
  it.each<
    [
      string,
      Array<
        [
          event: GatewayEventFrame,
          expected?: string | false | ((line: string) => void),
          advance?: true,
        ]
      >,
    ]
  >([
    [
      "last prose paragraph",
      [
        [
          chatDelta(
            "# Plan\n\nFirst **check** finished.\n\n```ts\nconst answer = 1;\n```\nFinal _verification_ is running.",
          ),
          "Final verification is running.",
        ],
      ],
    ],
    [
      "whitespace and ellipsis",
      [
        [
          chatDelta(`Earlier.\n\n- ${"result ".repeat(30)}`),
          (line) => {
            expect(line).toHaveLength(120);
            expect(line.endsWith("…")).toBe(true);
            expect(line).not.toContain("  ");
          },
        ],
      ],
    ],
    [
      "mid-run cumulative snapshot",
      [
        [
          chatFrame({
            state: "delta",
            deltaText: "les now.",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "Reading files now." }],
            },
          }),
          "Reading files now.",
        ],
      ],
    ],
    [
      "overlapping agent and chat deltas",
      [
        [chatDelta("Reading"), undefined],
        [
          gatewayEvent("agent", {
            sessionKey: "agent:main:run",
            runId: "run-1",
            stream: "assistant",
            data: { delta: " files" },
          }),
          undefined,
        ],
        [chatDelta(undefined, " files"), "Reading files", true],
      ],
    ],
    [
      "snapshot display normalization",
      [
        [
          chatDelta(
            [
              "Visible work is complete.",
              "<think>private reasoning</think>",
              internal,
              "private runtime details",
              internalEnd,
              "[[audio_as_voice]]",
              "REPLY_SKIP",
            ].join("\n"),
          ),
          "Visible work is complete.",
        ],
      ],
    ],
    [
      "trailing heartbeat token",
      [
        [
          chatDelta(
            `${"Visible progress continues. ".repeat(16)}Final visible status. HEARTBEAT_OK`,
          ),
          (line: string) => {
            expect(line).toBe("Final visible status.");
            expect(line).not.toContain("HEARTBEAT_OK");
          },
        ],
      ],
    ],
    [
      "truncated internal block",
      [
        [
          chatDelta(`Visible setup.\n${internal}\n${"private runtime detail ".repeat(1_000)}`),
          "Visible setup.",
        ],
        [
          chatDelta(undefined, `\n${internalEnd}\nFinal bounded line.`),
          "Final bounded line.",
          true,
        ],
      ],
    ],
    [
      "partial internal delimiter",
      [
        [chatDelta("Visible setup.\n<<<BEGIN_OPENCLAW_INTERNAL_CONT"), "Visible setup."],
        [chatDelta(undefined, "EXT>>>\nprivate runtime detail"), "Visible setup."],
      ],
    ],
    [
      "replacement resets internal streaming state",
      [
        [
          chatDelta(`${internal}\nprivate runtime text`, `${internal}\nprivate runtime text`),
          undefined,
        ],
        [chatDelta(undefined, "Replacement", true), undefined],
        [chatDelta(undefined, " now."), "Replacement now.", true],
      ],
    ],
    [
      "nested internal block outlives the raw buffer",
      [
        [
          chatDelta(
            [
              "Visible setup.",
              internal,
              "private outer runtime detail ".repeat(1_000),
              internal,
              "private nested runtime detail ".repeat(1_000),
              internalEnd,
            ].join("\n"),
          ),
          "Visible setup.",
        ],
        [chatDelta(undefined, "\nStill private after the nested block."), "Visible setup.", true],
        [chatDelta(undefined, `\n${internalEnd}\nFinal public line.`), "Final public line.", true],
      ],
    ],
    [
      "corrected replacement",
      [
        [chatDelta("Draft answer."), undefined],
        [chatDelta("Corrected answer.", "Corrected answer.", true), "Corrected answer.", true],
      ],
    ],
    [
      "silent join until cumulative alignment",
      [
        [chatFrame({ deltaText: "secret internal continuation." }), false, true],
        [
          chatFrame({
            deltaText: " Visible update.",
            message: { role: "assistant", content: "Public progress line. Visible update." },
          }),
          "Visible update.",
          true,
        ],
      ],
    ],
    [
      "empty replacement retracts shown text",
      [
        [
          chatFrame({
            deltaText: "Queued draft that gets withdrawn.",
            message: { role: "assistant", content: "Queued draft that gets withdrawn." },
          }),
          "Queued draft that gets withdrawn.",
          true,
        ],
        [chatFrame({ deltaText: "", replace: true }), false, true],
      ],
    ],
    [
      "suppressed replacement retracts shown text",
      [
        [chatDelta("Draft that gets withdrawn."), "Draft that gets withdrawn.", true],
        [chatDelta("HEARTBEAT_OK", "HEARTBEAT_OK", true), undefined],
        [chatDelta("", "", true), false, true],
      ],
    ],
    [
      "new run discards accumulated deltas",
      [
        [
          chatFrame({
            runId: "first",
            state: "delta",
            deltaText: "Unfinished old work",
            message: { role: "assistant", content: "Unfinished old work" },
          }),
          undefined,
        ],
        [
          chatFrame({
            runId: "second",
            state: "delta",
            deltaText: "New run work.",
            message: { role: "assistant", content: "New run work." },
          }),
          "New run work.",
        ],
      ],
    ],
    [
      "newest sentence beyond the retained tail",
      [
        [
          chatFrame({
            runId: "long",
            state: "delta",
            deltaText: preamble,
            message: { role: "assistant", content: preamble },
          }),
          undefined,
          true,
        ],
        [
          chatFrame({
            runId: "long",
            state: "delta",
            deltaText: ". Final bounded line.",
            message: { role: "assistant", content: `${preamble}. Final bounded line.` },
          }),
          "Final bounded line.",
        ],
      ],
    ],
  ])("publishes narration for %s", async (_name, steps) => {
    const { controller, updates } = narrationFixture();
    for (const [event, expected, advance] of steps) {
      controller.handleEvent(event);
      if (advance) {
        await vi.advanceTimersByTimeAsync(SIDEBAR_NARRATION_THROTTLE_MS);
      }
      const lines = updates.at(-1);
      if (expected === false) {
        expect(lines?.has("agent:main:run") ?? false).toBe(false);
      } else if (typeof expected === "string") {
        expect(lines?.get("agent:main:run")).toBe(expected);
      }
      if (typeof expected === "function") {
        const line = lines?.get("agent:main:run");
        expect(line).toBeDefined();
        expected(line!);
      }
    }
    controller.disconnect();
  });
});
