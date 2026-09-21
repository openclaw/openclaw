/* @vitest-environment jsdom */

import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { render } from "lit";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewaySessionRow } from "../../api/types.ts";
import { sessionsResult } from "../../lib/sessions/session-capability.test-support.ts";
import type {
  SessionRowEventListener,
  SessionRowObservation,
} from "../../lib/sessions/session-capability.ts";
import type { GatewayRequestHandler } from "../../test-helpers/gateway-client.ts";
import type { ChatHistoryResult } from "./chat-history-snapshot.ts";
import { getChatHistoryLoadState } from "./chat-history-state.ts";
import { loadChatHistory } from "./chat-history.ts";
import { createMountedPanes, refreshPane } from "./chat-pane-mounted.test-support.ts";
import { renderChatPaneComposerControls } from "./chat-pane-session-controls.ts";
import type { TestChatPane } from "./chat-pane.test-support.ts";
import { readChatInputRunIds } from "./chat-pending-inputs.ts";
import { refreshPageChat } from "./chat-state-refresh.ts";
import { selectedChatSessionRow } from "./chat-state-route.ts";
import { renderChatPermissionPicker } from "./components/chat-permission-picker.ts";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
} from "./components/chat-transcript.test-support.ts";
import { reduceChatSessionProjection } from "./history-merge.ts";
import { adoptStartedChatRun } from "./run-lifecycle.ts";

beforeEach(installTranscriptDomMocks);
afterEach(resetTranscriptTestDom);

describe("mounted pane session event ownership", () => {
  it("publishes one shared event and applies its message to every mounted pane", async () => {
    const row: GatewaySessionRow = {
      key: "agent:main:shared",
      agentId: "main",
      sessionId: "shared",
      kind: "direct",
      updatedAt: 1,
      hasActiveRun: true,
      status: "running",
    };
    const { sessions, mount, emitGatewayEvent } = createMountedPanes([row]);
    await sessions.refresh({ agentId: "main", force: true });
    const panes = [mount(row.key), mount(row.key)];
    await Promise.all(panes.map(refreshPane));
    const published = vi.fn();
    const unsubscribe = sessions.subscribe(published);
    onTestFinished(unsubscribe);
    published.mockClear();
    for (const pane of panes) {
      pane.state.chatRunId = "active-run";
    }
    emitGatewayEvent("session.message", {
      sessionKey: row.key,
      agentId: "main",
      sessionId: row.sessionId,
      runId: "active-run",
      hasActiveRun: true,
      messageId: "reply-one",
      messageSeq: 1,
      message: {
        role: "assistant",
        content: "Shared reply",
        __openclaw: { id: "reply-one", seq: 1 },
      },
      session: { ...row, updatedAt: 2, lastMessagePreview: "Shared reply" },
    });
    expect(published).toHaveBeenCalledTimes(1);
    for (const pane of panes) {
      expect(selectedChatSessionRow(pane.state)).toMatchObject({
        updatedAt: 2,
        lastMessagePreview: "Shared reply",
      });
      expect(pane.state.chatMessages).toHaveLength(1);
      expect(pane.state.chatMessages[0]).toMatchObject({
        role: "assistant",
        content: "Shared reply",
      });
      expect(pane.state.chatRunId).toBe("active-run");
    }
  });

  it.each([
    { key: "global", kind: "global", archived: true },
    { key: "agent:research:qualified-refresh", kind: "direct", archived: false },
    { key: "agent:research:qualified-refresh", kind: "direct", archived: true },
  ] as const)(
    "keeps a foreign $key descriptor after history refresh without changing primary membership (archived: $archived)",
    async ({ key, kind, archived }) => {
      const primary: GatewaySessionRow = {
        key: "global",
        agentId: "main",
        sessionId: "main-global",
        kind: "global",
        updatedAt: 1,
      };
      const selected: GatewaySessionRow = {
        key,
        agentId: "research",
        sessionId: "research-session",
        kind,
        updatedAt: 1,
        archived,
        label: "Research before",
      };
      const { sessions, mount, emitGatewayEvent } = createMountedPanes(
        [primary, selected],
        "research",
      );
      await sessions.refresh({ agentId: "main", force: true });
      const pane = mount(key);
      await refreshPane(pane);
      expect(selectedChatSessionRow(pane.state)).toMatchObject(selected);
      expect(pane.state.sessionsResultAgentId).toBe("research");
      expect(sessions.state.agentId).toBe("main");
      expect(sessions.state.result?.sessions).toEqual([expect.objectContaining(primary)]);
      emitGatewayEvent("sessions.changed", {
        sessionKey: key,
        agentId: "research",
        sessionId: selected.sessionId,
        reason: "update",
        session: { ...selected, updatedAt: 2, label: "Research after" },
      });
      expect(selectedChatSessionRow(pane.state)).toMatchObject({
        sessionId: selected.sessionId,
        label: "Research after",
        archived,
      });
      expect(sessions.state.agentId).toBe("main");
      expect(sessions.state.result?.sessions).toEqual([expect.objectContaining(primary)]);

      emitGatewayEvent("sessions.changed", {
        sessionKey: key,
        agentId: "research",
        sessionId: selected.sessionId,
        reason: "delete",
      });
      expect(selectedChatSessionRow(pane.state)).toBeUndefined();
      expect(sessions.state.result?.sessions).toEqual([expect.objectContaining(primary)]);
    },
  );

  it.each([false, true])(
    "keeps a same-key successor and its first message after retirement (reentrant publication: %s)",
    async (reentrant) => {
      const previous: GatewaySessionRow = {
        key: "agent:main:replaced",
        agentId: "main",
        sessionId: "old-session",
        kind: "direct",
        updatedAt: 1,
        label: "Previous session",
      };
      const next = { ...previous, sessionId: "next-session", updatedAt: 2, label: "Next session" };
      const newest = {
        ...next,
        updatedAt: 3,
        label: "Newest session",
      };
      const listed = [previous];
      const { sessions, mount, emitGatewayEvent } = createMountedPanes(listed);
      let armed = false;
      const unsubscribe = sessions.subscribe((state) => {
        if (armed && state.result?.sessions.some((row) => row.sessionId === next.sessionId)) {
          armed = false;
          sessions.captureReconcile()(newest, undefined, { resultAgentId: "main" });
        }
      });
      onTestFinished(unsubscribe);
      await sessions.refresh({ agentId: "main", force: true });
      const pane = mount(previous.key);
      await refreshPane(pane);
      expect(selectedChatSessionRow(pane.state)).toMatchObject(previous);

      armed = reentrant;
      listed.splice(0, 1, next);
      await sessions.refresh({ agentId: "main", force: true });
      expect(selectedChatSessionRow(pane.state)).toMatchObject(reentrant ? newest : next);
      await pane.updateComplete;

      emitGatewayEvent("session.message", {
        sessionKey: next.key,
        agentId: "main",
        sessionId: next.sessionId,
        hasActiveRun: true,
        messageId: "successor-user",
        messageSeq: 1,
        message: {
          role: "user",
          content: "First successor prompt",
          __openclaw: { id: "successor-user", seq: 1 },
        },
        session: { ...next, updatedAt: 4, hasActiveRun: true, status: "running" },
      });
      expect(pane.state.chatMessages).toContainEqual(
        expect.objectContaining({ role: "user", content: "First successor prompt" }),
      );
    },
  );

  it("does not admit fenced hidden history and hydrates its foreign descriptor when presented", async () => {
    const primary: GatewaySessionRow = {
      key: "global",
      agentId: "main",
      sessionId: "main-global",
      kind: "global",
      updatedAt: 1,
    };
    const original: GatewaySessionRow = {
      key: "global",
      agentId: "research",
      sessionId: "research-global",
      kind: "global",
      archived: true,
      updatedAt: 1,
      label: "Earlier history",
    };
    const latest = { ...original, updatedAt: 2, label: "Current research session" };
    const oldHistory = createDeferred<ChatHistoryResult>();
    const freshHistory = createDeferred<ChatHistoryResult>();
    const oldDescribe = createDeferred<{ session: GatewaySessionRow | null }>();
    const freshDescribe = createDeferred<{ session: GatewaySessionRow | null }>();
    const initialHistoryStarted = createDeferred();
    const freshReadStarted = createDeferred();
    const oldHistoryReconciled = createDeferred();
    const freshRowObserved = createDeferred();
    let eventDelivered = false;
    const reads: Array<{ method: string; params: unknown; afterEvent: boolean }> = [];
    const read: GatewayRequestHandler = (method, params) => {
      reads.push({ method, params, afterEvent: eventDelivered });
      if (eventDelivered) {
        freshReadStarted.resolve();
      } else if (method !== "sessions.describe") {
        initialHistoryStarted.resolve();
      }
      if (method === "sessions.describe") {
        return eventDelivered ? freshDescribe.promise : oldDescribe.promise;
      }
      return eventDelivered ? freshHistory.promise : oldHistory.promise;
    };
    const {
      pane: initialPane,
      context,
      sessions,
      mount,
      emitGatewayEvent,
    } = createMountedPanes([primary, original], "research", undefined, {
      "chat.history": read,
      "chat.startup": read,
      "sessions.describe": read,
    });
    initialPane.presented = false;
    context.connectionBootstrap.setForegroundRoute(null);
    const observations: SessionRowObservation[] = [];
    const observeRow = sessions.observeRow;
    vi.spyOn(sessions, "observeRow").mockImplementation((target, listener, options) => {
      const observation = observeRow(
        target,
        (row) => {
          listener(row);
          if (
            options?.onEvent &&
            row !== null &&
            row.sessionId === latest.sessionId &&
            row.updatedAt === latest.updatedAt
          ) {
            freshRowObserved.resolve();
          }
        },
        options,
      );
      if (options?.onEvent) {
        observations.push(observation);
      }
      return observation;
    });
    const oldOutcomes: Array<boolean | "defaults-only"> = [];
    const captureReconcile = sessions.captureReconcile;
    vi.spyOn(sessions, "captureReconcile").mockImplementation(() => {
      const reconcile = captureReconcile();
      const beforeEvent = !eventDelivered;
      return (...args) => {
        const outcome = reconcile(...args);
        if (beforeEvent && args[0]?.agentId === "research") {
          oldOutcomes.push(outcome);
          oldHistoryReconciled.resolve();
        }
        return outcome;
      };
    });
    let initialHistory: ReturnType<typeof loadChatHistory> | undefined;
    let initialRefresh: Promise<void> | undefined;
    try {
      await sessions.refresh({ agentId: "main", force: true });
      const pane = mount("global");
      const state = pane.state;
      const observation = observations[0];
      if (!observation) {
        throw new Error("Expected the hidden pane's session observation");
      }
      const pending = getChatHistoryLoadState(state);
      if (pending.phase === "in-flight") {
        initialHistory = pending.promise;
      } else {
        initialHistory = loadChatHistory(state, { deferBranches: true });
        initialRefresh = refreshPageChat(state, {
          historyLoad: initialHistory,
          awaitHistory: true,
          scheduleScroll: false,
        });
      }
      await initialHistoryStarted.promise;
      expect(reads.some(({ method }) => method !== "sessions.describe")).toBe(true);
      expect(pane.presented).toBe(false);
      expect(observation.hasObserved).toBe(false);

      eventDelivered = true;
      emitGatewayEvent("sessions.changed", {
        sessionKey: "global",
        agentId: "research",
        sessionId: original.sessionId,
        reason: "update",
        session: latest,
      });
      oldHistory.resolve({ messages: [], sessionInfo: original, sessionId: original.sessionId });
      await initialHistory;
      await initialRefresh;
      expect(observation.hasObserved).toBe(false);
      await oldHistoryReconciled.promise;
      expect(oldOutcomes.length).toBeGreaterThan(0);
      expect.soft(oldOutcomes).not.toContain(true);
      expect(pane.presented).toBe(false);
      pane.presented = true;
      await freshReadStarted.promise;
      expect(reads.filter(({ afterEvent }) => afterEvent).length).toBeGreaterThan(0);
      for (const { method, params } of reads.filter(({ afterEvent }) => afterEvent)) {
        expect(params).toMatchObject({
          [method === "sessions.describe" ? "key" : "sessionKey"]: "global",
          agentId: "research",
        });
      }
      freshHistory.resolve({ messages: [], sessionInfo: latest, sessionId: latest.sessionId });
      freshDescribe.resolve({ session: latest });
      await freshRowObserved.promise;
      expect(observations.at(-1)?.hasObserved).toBe(true);
      expect(observations.at(-1)?.row).toMatchObject(latest);
      expect(selectedChatSessionRow(state)).toMatchObject(latest);
      expect(pane.presented).toBe(true);
      expect(sessions.state.agentId).toBe("main");
      expect(sessions.state.result?.sessions).toEqual([expect.objectContaining(primary)]);
    } finally {
      oldHistory.resolve({ messages: [], sessionInfo: original });
      freshHistory.resolve({ messages: [], sessionInfo: latest });
      oldDescribe.resolve({ session: null });
      freshDescribe.resolve({ session: latest });
      await Promise.allSettled([initialHistory, initialRefresh]);
      await vi.dynamicImportSettled();
    }
  });

  it("preserves provisional presentation until the row owner confirms an outcome", async () => {
    const row: GatewaySessionRow = {
      key: "agent:main:provisional",
      agentId: "main",
      sessionId: "provisional",
      kind: "direct",
      updatedAt: 1,
      label: "Cached presentation",
    };
    const reads = createDeferred();
    const { sessions, mount, emitGatewayEvent } = createMountedPanes([row], "main", reads.promise);
    const observations: SessionRowObservation[] = [];
    const observeRow = sessions.observeRow;
    vi.spyOn(sessions, "observeRow").mockImplementation((target, listener, options) => {
      const observation = observeRow(target, listener, options);
      if (options?.onEvent) {
        observations.push(observation);
      }
      return observation;
    });
    try {
      sessions.reconcile(row, undefined, { resultAgentId: "main" });
      const pane = mount(row.key);
      const observation = observations[0];
      expect(observation).toBeDefined();
      if (!observation) {
        throw new Error("Expected the mounted pane's session observation");
      }
      expect(observation.hasObserved).toBe(false);
      pane.applySessionsState(sessions.state);
      expect(selectedChatSessionRow(pane.state)).toMatchObject(row);

      emitGatewayEvent("sessions.changed", {
        sessionKey: row.key,
        agentId: "main",
        reason: "runner-availability",
      });
      expect(observation.hasObserved).toBe(false);
      expect(selectedChatSessionRow(pane.state)).toMatchObject(row);

      expect(observation.captureReconcile()(undefined)).toEqual({ status: "current", row: null });
      expect(observation.hasObserved).toBe(true);
      expect(selectedChatSessionRow(pane.state)).toBeUndefined();
      pane.applySessionsState(sessions.state);
      expect(selectedChatSessionRow(pane.state)).toBeUndefined();
    } finally {
      reads.resolve();
      await vi.dynamicImportSettled();
    }
  });

  it.each([false, true])(
    "shows the admitted run's model before provisional descriptor reads settle (reentrant publication: %s)",
    async (reentrant) => {
      const row: GatewaySessionRow = {
        key: "agent:main:provisional-model",
        agentId: "main",
        sessionId: "provisional-model",
        kind: "direct",
        updatedAt: 1,
        hasActiveRun: true,
        model: "primary",
        modelProvider: "example",
        activeModel: "primary",
        activeModelProvider: "example",
      };
      const reads = createDeferred();
      const { sessions, mount, emitGatewayEvent } = createMountedPanes(
        [row],
        "main",
        reads.promise,
      );
      let pendingHistory: ReturnType<typeof loadChatHistory> | undefined;
      let reenter = false;
      const unsubscribe = sessions.subscribe((snapshot) => {
        if (reenter && snapshot.result?.sessions[0]?.activeModel === "fallback") {
          reenter = false;
          emitGatewayEvent("sessions.changed", {
            sessionKey: row.key,
            agentId: "main",
            runId: "current-run",
            phase: "model",
            session: { ...row, updatedAt: 3, activeModel: "primary" },
          });
        }
      });
      onTestFinished(unsubscribe);
      try {
        sessions.reconcile(row, undefined, { resultAgentId: "main" });
        const pane = mount(row.key);
        const state = pane.state;
        const descriptor = sessions.observeRow({ key: row.key, agentId: "main" }, () => {});
        onTestFinished(descriptor.dispose);
        pendingHistory = loadChatHistory(state, { deferBranches: true });
        state.chatModelCatalog = [
          { id: "primary", name: "Primary", provider: "example" },
          { id: "fallback", name: "Fallback", provider: "example" },
        ];
        adoptStartedChatRun(state, "current-run", 2);
        const container = document.createElement("div");
        const draw = () => {
          const controls = renderChatPaneComposerControls({
            state,
            selectedSession: selectedChatSessionRow(state),
            agentDefaultModel: "example/primary",
            modelAccess: { allowed: true, requiredScope: "operator.write" },
            effortAccess: { allowed: true, requiredScope: "operator.write" },
            contextWindowAccess: { allowed: true, requiredScope: "operator.write" },
            permissionAccess: { allowed: true, requiredScope: "operator.write" },
            canSelectFull: true,
            onModelSetup: vi.fn(),
          });
          render(controls.composerControls, container);
          return container.querySelector<HTMLElement>("[data-chat-model-select]");
        };
        const initialModel = draw();
        expect(initialModel?.textContent).toContain("Primary");
        expect(initialModel?.getAttribute("aria-busy")).toBe("true");

        reenter = reentrant;
        emitGatewayEvent("sessions.changed", {
          sessionKey: row.key,
          agentId: "main",
          runId: "current-run",
          phase: "model",
          session: { ...row, updatedAt: 3, activeModel: "fallback" },
        });

        expect(sessions.state.result?.sessions[0]?.activeModel).toBe(
          reentrant ? "primary" : "fallback",
        );
        expect(descriptor.row).toBeNull();
        expect(descriptor.hasObserved).toBe(false);
        expect(state.chatLoading).toBe(true);
        const model = draw();
        expect(model?.textContent).toContain(reentrant ? "Primary" : "Fallback");
        expect(model?.getAttribute("aria-busy")).toBe("false");
      } finally {
        reads.resolve();
        await pendingHistory;
        await vi.dynamicImportSettled();
      }
    },
  );

  it("projects an admitted equal-clock terminal descriptor while a newer local run continues", async () => {
    const primary: GatewaySessionRow = {
      key: "global",
      agentId: "main",
      sessionId: "main-global",
      kind: "global",
      updatedAt: 100,
    };
    const running: GatewaySessionRow = {
      key: "global",
      agentId: "research",
      sessionId: "research-global",
      kind: "global",
      updatedAt: 100,
      startedAt: 50,
      hasActiveRun: true,
      status: "running",
      activeRunIds: ["completed-run"],
      lastRunId: "completed-run",
    };
    const terminal = {
      key: running.key,
      agentId: running.agentId,
      sessionId: running.sessionId,
      updatedAt: running.updatedAt,
      hasActiveRun: false,
      status: "done" as const,
      activeRunIds: [],
      lastRunId: "completed-run",
    };
    const laterHistory = createDeferred<ChatHistoryResult>();
    const laterDescribe = createDeferred<{ session: GatewaySessionRow | null }>();
    let holdLaterReads = false;
    const history: GatewayRequestHandler = () =>
      holdLaterReads
        ? laterHistory.promise
        : { messages: [], sessionInfo: running, sessionId: running.sessionId };
    const { sessions, mount, emitGatewayEvent } = createMountedPanes(
      [primary, running],
      "research",
      undefined,
      {
        "chat.history": history,
        "chat.startup": history,
        "sessions.describe": () => (holdLaterReads ? laterDescribe.promise : { session: running }),
      },
    );
    try {
      await sessions.refresh({ agentId: "main", force: true });
      const completing = mount("global");
      const continuing = mount("global");
      await Promise.all([refreshPane(completing), refreshPane(continuing)]);
      const terminalObserved = createDeferred();
      const descriptor = sessions.observeRow({ key: "global", agentId: "research" }, (row) => {
        if (row?.lastRunId === "completed-run" && row.hasActiveRun === false) {
          terminalObserved.resolve();
        }
      });
      onTestFinished(descriptor.dispose);
      expect(descriptor.row).toMatchObject(running);
      expect(selectedChatSessionRow(continuing.state)).toMatchObject(running);
      expect(sessions.state.agentId).toBe("main");
      expect(sessions.state.result?.sessions).toEqual([expect.objectContaining(primary)]);

      adoptStartedChatRun(completing.state, "completed-run", 50);
      adoptStartedChatRun(continuing.state, "newer-run", 150);
      emitGatewayEvent("chat", {
        sessionKey: "global",
        agentId: "research",
        runId: "newer-run",
        state: "delta",
        deltaText: "The newer run continues.",
      });
      expect(continuing.state.chatStream).toBe("The newer run continues.");
      holdLaterReads = true;
      emitGatewayEvent("chat", {
        sessionKey: "global",
        agentId: "research",
        runId: "completed-run",
        state: "final",
        message: { role: "assistant", content: "The earlier run completed." },
      });

      await terminalObserved.promise;
      expect(descriptor.row).toMatchObject(terminal);
      expect(completing.state.chatRunId).toBeNull();
      expect.soft(selectedChatSessionRow(continuing.state)).toMatchObject(terminal);
      expect(continuing.state.chatRunId).toBe("newer-run");
      expect(continuing.state.chatStream).toBe("The newer run continues.");
      expect(sessions.state.result?.sessions).toEqual([expect.objectContaining(primary)]);

      await sessions.refresh({ agentId: "main", force: true });
      expect(descriptor.row).toMatchObject(terminal);
      expect.soft(selectedChatSessionRow(continuing.state)).toMatchObject(terminal);
      expect(continuing.state.chatRunId).toBe("newer-run");
      expect(continuing.state.chatStream).toBe("The newer run continues.");
      expect(sessions.state.agentId).toBe("main");
      expect(sessions.state.result?.sessions).toEqual([expect.objectContaining(primary)]);
    } finally {
      const settled = { ...running, ...terminal };
      laterHistory.resolve({ messages: [], sessionInfo: settled, sessionId: running.sessionId });
      laterDescribe.resolve({ session: settled });
      await vi.dynamicImportSettled();
    }
  });

  it("recovers a foreign pane's permission picker from history after scoped readback fails", async () => {
    const primary: GatewaySessionRow = {
      key: "global",
      agentId: "main",
      sessionId: "main-global",
      kind: "global",
      updatedAt: 1,
    };
    const selected: GatewaySessionRow = {
      key: "global",
      agentId: "research",
      sessionId: "research-global",
      kind: "global",
      updatedAt: 1,
      permissionMode: "workspace",
      label: "Initial research session",
    };
    const observed = { ...selected, label: "Observed research session" };
    const recovered = { ...observed, label: "Recovered through history" };
    const historyReply = createDeferred<ChatHistoryResult>();
    const descriptorReply = createDeferred<{ session: GatewaySessionRow | null }>();
    const recoveryHistoryStarted = createDeferred();
    let recovering = false;
    let listsUnavailable = false;
    const history = vi.fn<GatewayRequestHandler>(() => {
      if (recovering) {
        recoveryHistoryStarted.resolve();
        return historyReply.promise;
      }
      return { messages: [], sessionInfo: selected, sessionId: selected.sessionId };
    });
    const patch = vi.fn<GatewayRequestHandler>(() => {
      listsUnavailable = true;
      throw new Error("Permission application unavailable");
    });
    const list = vi.fn<GatewayRequestHandler>(() => {
      if (listsUnavailable) {
        throw new Error("Permission readback unavailable");
      }
      return sessionsResult([primary], 1);
    });
    const { sessions, mount, emitGatewayEvent } = createMountedPanes(
      [primary, selected],
      "research",
      undefined,
      {
        "chat.history": history,
        "chat.startup": history,
        "sessions.describe": () => descriptorReply.promise,
        "sessions.patch": patch,
        "sessions.list": list,
      },
    );
    let recovery: Promise<void> | undefined;
    try {
      await sessions.refresh({ agentId: "main", force: true });
      const pane = mount("global");
      await refreshPane(pane);
      const state = pane.state;
      const descriptor = sessions.observeRow({ key: "global", agentId: "research" }, () => {});
      onTestFinished(descriptor.dispose);
      emitGatewayEvent("sessions.changed", {
        sessionKey: "global",
        agentId: "research",
        reason: "update",
        session: observed,
      });
      expect(descriptor.row).toMatchObject(observed);
      expect(selectedChatSessionRow(state)).toMatchObject(observed);
      const controls = () =>
        renderChatPaneComposerControls({
          state,
          selectedSession: selectedChatSessionRow(state),
          agentDefaultModel: undefined,
          modelAccess: { allowed: true, requiredScope: "operator.write" },
          effortAccess: { allowed: true, requiredScope: "operator.write" },
          contextWindowAccess: { allowed: true, requiredScope: "operator.write" },
          permissionAccess: { allowed: true, requiredScope: "operator.write" },
          canSelectFull: true,
          onModelSetup: vi.fn(),
        });
      const container = document.createElement("div");
      const draw = () => {
        render(renderChatPermissionPicker(controls().permissionPicker), container);
        return container.querySelector<HTMLButtonElement>("[data-chat-permission-select]");
      };
      expect(draw()?.dataset.chatSelectValue).toBe("workspace");

      await controls().permissionPicker.onSelect("full");
      expect(patch.mock.calls[0]?.[1]).toMatchObject({
        key: "global",
        agentId: "research",
        expectedSessionId: selected.sessionId,
        permissionMode: "full",
      });
      expect(
        list.mock.calls.some(([, params]) => asOptionalRecord(params)?.agentId === "research"),
      ).toBe(true);
      expect(state.chatError).toContain("Permission application unavailable");
      const failedChoice = draw();
      expect(failedChoice?.dataset.chatSelectValue).toBe("full");
      expect(failedChoice?.disabled).toBe(false);
      expect(descriptor.row).toMatchObject(observed);
      expect(sessions.state.agentId).toBe("main");
      expect(sessions.state.result?.sessions).toEqual([expect.objectContaining(primary)]);

      recovering = true;
      const historyReads = history.mock.calls.length;
      recovery = refreshPane(pane);
      await recoveryHistoryStarted.promise;
      expect(history.mock.calls.length).toBeGreaterThan(historyReads);
      expect(history.mock.calls.at(-1)?.[0]).toBe("chat.history");
      expect(history.mock.calls.at(-1)?.[1]).toMatchObject({
        sessionKey: "global",
        agentId: "research",
      });
      expect(draw()?.dataset.chatSelectValue).toBe("full");
      historyReply.resolve({ messages: [], sessionInfo: recovered, sessionId: selected.sessionId });
      await recovery;

      expect(descriptor.row).toMatchObject(recovered);
      expect(selectedChatSessionRow(state)).toMatchObject(recovered);
      const recoveredChoice = draw();
      expect(recoveredChoice?.dataset.chatSelectValue).toBe("workspace");
      expect(recoveredChoice?.disabled).toBe(false);
      expect(sessions.state.agentId).toBe("main");
      expect(sessions.state.result?.sessions).toEqual([expect.objectContaining(primary)]);
    } finally {
      historyReply.resolve({ messages: [], sessionInfo: recovered, sessionId: selected.sessionId });
      descriptorReply.resolve({ session: recovered });
      await recovery;
      await vi.dynamicImportSettled();
    }
  });
  it.each(["stale", "current", "rowless", "reentrant"] as const)(
    "keeps lifecycle reset delivery within its admitted incarnation (%s)",
    async (generation) => {
      const reentrant = generation === "reentrant";
      const preservesSuccessor = generation === "stale" || reentrant;
      const row: GatewaySessionRow = {
        key: "agent:main:incarnation-reset",
        agentId: "main",
        sessionId: "successor-session",
        kind: "direct",
        updatedAt: reentrant ? 3 : 2,
        activeLeafEntryId: "successor-leaf",
        label: "Successor session",
      };
      const initialRow = reentrant
        ? { ...row, sessionId: "predecessor-session", updatedAt: 1 }
        : row;
      const persisted = {
        role: "assistant",
        content: "Successor transcript",
        __openclaw: { id: "successor-message", seq: 1 },
      };
      const initial: ChatHistoryResult = {
        messages: [persisted],
        sessionId: row.sessionId,
        // The transcript can reveal its physical successor before its row metadata arrives.
        ...(generation === "rowless" || reentrant ? {} : { sessionInfo: row }),
      };
      const laterHistory = createDeferred<ChatHistoryResult>();
      const postResetHistory = createDeferred<ChatHistoryResult>();
      const laterHistoryStarted = createDeferred();
      const postResetHistoryStarted = createDeferred();
      let holdHistory = false;
      let heldHistoryReads = 0;
      const history = vi.fn<GatewayRequestHandler>(() => {
        if (!holdHistory) {
          return initial;
        }
        heldHistoryReads += 1;
        if (heldHistoryReads === 1) {
          laterHistoryStarted.resolve();
          return laterHistory.promise;
        }
        postResetHistoryStarted.resolve();
        return postResetHistory.promise;
      });
      const { sessions, mount, emitGatewayEvent } = createMountedPanes(
        generation === "rowless" ? [] : [initialRow],
        "main",
        undefined,
        {
          "chat.history": history,
          "chat.startup": history,
          ...(reentrant ? { "sessions.list": () => sessionsResult([], 1) } : {}),
        },
      );
      let admitSuccessor = false;
      let successorAdmitted = false;
      let successorAdmissionAttempts = 0;
      let refresh: Promise<void> | undefined;
      let pane: TestChatPane | undefined;
      try {
        await sessions.refresh({ agentId: "main", force: true });
        if (reentrant) {
          // A history-only row can be superseded by a scoped read; a canonical list
          // incarnation deliberately requires another list to establish its successor.
          expect(sessions.state.result?.sessions).toEqual([]);
          expect(
            sessions.captureReconcile()(initialRow, undefined, { resultAgentId: "main" }),
          ).toBe(true);
          const earlier = sessions.observeRow({ key: row.key, agentId: "main" }, () => {}, {
            onEvent: () => {
              if (admitSuccessor) {
                admitSuccessor = false;
                successorAdmissionAttempts += 1;
                successorAdmitted =
                  sessions.captureReconcile()(row, undefined, { resultAgentId: "main" }) === true;
              }
            },
          });
          onTestFinished(earlier.dispose);
          expect(earlier.row).toMatchObject(initialRow);
        }
        pane = mount(row.key);
        await refreshPane(pane);
        const state = pane.state;
        pane.presented = false;
        expect(state.currentSessionId).toBe(row.sessionId);
        expect(state.chatMessages).toEqual([persisted]);
        expect(selectedChatSessionRow(state)).toEqual(
          generation === "rowless" ? undefined : expect.objectContaining(initialRow),
        );
        reduceChatSessionProjection(state, {
          type: "sendPending",
          runId: "successor-pending",
          message: {
            role: "user",
            content: "Pending successor prompt",
            __openclaw: { idempotencyKey: "successor-pending:user" },
          },
        });
        expect(readChatInputRunIds(state)).toContain("successor-pending");
        const messages = state.chatMessages;
        const branches = [
          {
            leafEntryId: "successor-leaf",
            headline: "Successor branch",
            messageCount: 1,
            active: true,
          },
        ];
        state.chatBranches = branches;
        state.chatBranchesSessionKey = row.key;
        state.chatBranchesConnectionEpoch = state.connectionEpoch;
        const notice = { runId: "successor-run", seq: 1, state: "buffering" as const };
        state.providerPolicyNotice = notice;
        const delivered = vi.fn<SessionRowEventListener>();
        const observation = sessions.observeRow({ key: row.key, agentId: "main" }, () => {}, {
          onEvent: delivered,
        });
        onTestFinished(observation.dispose);
        holdHistory = true;
        const previousReads = history.mock.calls.length;
        refresh = refreshPane(pane);
        await laterHistoryStarted.promise;
        expect(history.mock.calls.length).toBeGreaterThan(previousReads);
        expect(history.mock.calls.at(-1)?.[0]).toBe("chat.history");
        expect(history.mock.calls.at(-1)?.[1]).toMatchObject({
          sessionKey: row.key,
          inputRunIds: ["successor-pending"],
        });

        admitSuccessor = reentrant;
        emitGatewayEvent("sessions.changed", {
          sessionKey: row.key,
          agentId: "main",
          ...(reentrant
            ? { updatedAt: 2, ts: 2 }
            : { sessionId: generation === "stale" ? "predecessor-session" : row.sessionId }),
          reason: "reset",
        });
        if (reentrant) {
          expect(successorAdmissionAttempts).toBe(1);
          expect(successorAdmitted).toBe(true);
        }
        const assertProjection = () => {
          expect(state.currentSessionId).toBe(row.sessionId);
          if (preservesSuccessor) {
            expect(selectedChatSessionRow(state)).toMatchObject(row);
            expect(state.chatMessages).toBe(messages);
            expect(readChatInputRunIds(state)).toContain("successor-pending");
            expect(state.chatBranches).toBe(branches);
            expect(state.chatBranchesSessionKey).toBe(row.key);
            expect(state.providerPolicyNotice).toBe(notice);
          } else {
            expect(state.chatMessages).toEqual([]);
            expect(readChatInputRunIds(state)).not.toContain("successor-pending");
            expect(state.chatBranches).toEqual([]);
            expect(state.chatBranchesSessionKey).toBeNull();
            expect(state.providerPolicyNotice).toBeNull();
          }
        };
        assertProjection();
        if (generation === "stale") {
          expect(delivered).not.toHaveBeenCalled();
        } else {
          expect(delivered).toHaveBeenCalledOnce();
          if (generation === "rowless" || reentrant) {
            expect(delivered.mock.calls[0]?.[1]).toEqual({ applied: false });
          }
        }
        laterHistory.reject(new Error("Incarnation history temporarily unavailable"));
        await refresh;
        if (preservesSuccessor) {
          expect(getChatHistoryLoadState(state)).toMatchObject({
            phase: "failed",
            sessionKey: row.key,
            message: "Incarnation history temporarily unavailable",
          });
          expect(heldHistoryReads).toBe(1);
        } else {
          await postResetHistoryStarted.promise;
          expect(heldHistoryReads).toBe(2);
          expect(history.mock.calls.at(-1)?.[0]).toBe("chat.history");
          expect(history.mock.calls.at(-1)?.[1]).not.toHaveProperty("inputRunIds");
          expect(getChatHistoryLoadState(state)).toMatchObject({
            phase: "in-flight",
            sessionKey: row.key,
          });
          expect(state.chatError).toBeNull();
        }
        assertProjection();
      } finally {
        const outstanding = pane && getChatHistoryLoadState(pane.state);
        laterHistory.resolve(initial);
        postResetHistory.resolve({ ...initial, messages: [] });
        await refresh;
        if (outstanding?.phase === "in-flight") {
          await outstanding.promise;
          await outstanding.refresh?.promise;
        }
        await vi.dynamicImportSettled();
      }
    },
  );
});
