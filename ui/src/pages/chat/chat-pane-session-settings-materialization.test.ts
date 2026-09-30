/* @vitest-environment jsdom */

import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { render } from "lit";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type {
  GatewaySessionRow,
  SessionsListResult,
  SessionsPatchResult,
} from "../../api/types.ts";
import { sessionsResult } from "../../lib/sessions/session-capability.test-support.ts";
import type { GatewayRequestHandler } from "../../test-helpers/gateway-client.ts";
import { createMountedPanes, refreshPane } from "./chat-pane-mounted.test-support.ts";
import {
  readChatPaneMutationAccess,
  renderChatPaneComposerControls,
} from "./chat-pane-session-controls.ts";
import {
  switchChatContextWindow,
  switchChatFastMode,
  switchChatThinkingLevel,
} from "./chat-session.ts";
import { getPendingChatPickerPatch } from "./chat-settings-patches.ts";
import { selectedChatSessionRow } from "./chat-state-route.ts";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
} from "./components/chat-transcript.test-support.ts";

beforeEach(installTranscriptDomMocks);
afterEach(resetTranscriptTestDom);

it.each(
  (["absent", "placeholder"] as const).flatMap((initialState) =>
    (["preceding write", "failed preceding write", "replacement"] as const).map((source) => ({
      initialState,
      source,
    })),
  ),
)(
  "binds queued settings only to an acknowledged materialization ($initialState / $source)",
  async ({ initialState, source }) => {
    const placeholder = {
      key: "agent:main:settings-materialization",
      agentId: "main",
      kind: "direct",
      updatedAt: 1,
    } satisfies GatewaySessionRow;
    const materialized = {
      ...placeholder,
      sessionId: "settings-created-incarnation",
      updatedAt: 2,
      thinkingLevel: "high",
    } satisfies GatewaySessionRow;
    const unrelated = {
      ...materialized,
      sessionId: "settings-unrelated-incarnation",
      updatedAt: 3,
      thinkingLevel: "off",
    } satisfies GatewaySessionRow;
    const rows: GatewaySessionRow[] = initialState === "placeholder" ? [placeholder] : [];
    const firstReply = createDeferred<SessionsPatchResult>();
    const firstReceipt = {
      ok: true,
      key: materialized.key,
      path: "",
      entry: {
        sessionId: materialized.sessionId,
        updatedAt: materialized.updatedAt,
        thinkingLevel: materialized.thinkingLevel,
      },
    } satisfies SessionsPatchResult;
    const patch = vi.fn<GatewayRequestHandler>((_method, raw) => {
      const params = asOptionalRecord(raw);
      if (params?.thinkingLevel === "high") {
        return firstReply.promise;
      }
      if (params?.thinkingLevel !== "low" || !rows[0]?.sessionId) {
        throw new Error("Unexpected settings materialization fixture patch");
      }
      const current = rows[0];
      const sessionId = current.sessionId;
      if (!sessionId) {
        throw new Error("Expected the materialized fixture session identity");
      }
      if (params.expectedSessionId !== undefined && params.expectedSessionId !== sessionId) {
        throw new Error("Session changed before queued settings dispatch");
      }
      rows[0] = { ...current, thinkingLevel: "low", updatedAt: 4 };
      return {
        ok: true,
        key: placeholder.key,
        path: "",
        entry: { sessionId, thinkingLevel: "low", updatedAt: 4 },
      } satisfies SessionsPatchResult;
    });
    const { sessions, mount } = createMountedPanes(rows, "main", undefined, {
      "sessions.patch": patch,
    });
    let first: Promise<boolean> | undefined;
    let queued: Promise<boolean> | undefined;
    try {
      await sessions.refresh({ agentId: "main", force: true });
      const pane = mount(placeholder.key);
      await refreshPane(pane);
      expect(selectedChatSessionRow(pane.state)?.sessionId).toBeUndefined();
      expect(selectedChatSessionRow(pane.state)).toEqual(
        initialState === "placeholder" ? expect.objectContaining(placeholder) : undefined,
      );
      const connection = sessions.captureConnectionScope();
      expect(connection).not.toBeNull();
      first = switchChatThinkingLevel(pane.state, "high");
      const previousTail = getPendingChatPickerPatch(pane.state, placeholder.key, "main");
      expect(previousTail).toBeDefined();
      queued = switchChatThinkingLevel(pane.state, "low");
      expect(getPendingChatPickerPatch(pane.state, placeholder.key, "main")).not.toBe(previousTail);
      expect(patch).toHaveBeenCalledOnce();
      expect(patch.mock.calls[0]?.[1]).toMatchObject({
        key: placeholder.key,
        thinkingLevel: "high",
      });
      expect(patch.mock.calls[0]?.[1]).not.toHaveProperty("expectedSessionId");

      // The first receipt can trail row publication. A failed predecessor proves
      // no identity; an acknowledged A also cannot authorize a later replacement B.
      rows.splice(0, rows.length, source === "preceding write" ? materialized : unrelated);
      await sessions.refresh({ agentId: "main", force: true });
      expect(selectedChatSessionRow(pane.state)).toMatchObject(rows[0]!);
      expect(connection && sessions.isConnectionScopeCurrent(connection)).toBe(true);
      expect(patch).toHaveBeenCalledOnce();
      if (source === "failed preceding write") {
        firstReply.reject(new Error("Synthetic first settings write rejection"));
      } else {
        firstReply.resolve(firstReceipt);
      }
      await expect(first).resolves.toBe(source !== "failed preceding write");
      const completed = await queued;
      const adoptsMaterialization = source === "preceding write";
      expect.soft(completed).toBe(adoptsMaterialization);
      expect.soft(patch).toHaveBeenCalledTimes(adoptsMaterialization ? 2 : 1);
      if (adoptsMaterialization) {
        expect(patch.mock.calls[1]?.[1]).toMatchObject({
          key: placeholder.key,
          thinkingLevel: "low",
          expectedSessionId: materialized.sessionId,
        });
        expect(selectedChatSessionRow(pane.state)).toMatchObject({
          sessionId: materialized.sessionId,
          thinkingLevel: "low",
        });
        expect(pane.state.chatThinkingLevel).toBe("low");
      } else {
        expect(rows[0]).toEqual(unrelated);
        expect(selectedChatSessionRow(pane.state)).toMatchObject(unrelated);
      }
    } finally {
      firstReply.resolve(firstReceipt);
      await Promise.allSettled([first, queued]);
      await vi.dynamicImportSettled();
    }
  },
);

it.each(["unbound", "materialized"] as const)(
  "keeps acknowledged materialization through a failed middle settings write (%s)",
  async (lastTarget) => {
    const key = "agent:main:settings-materialization-chain";
    const materialized = {
      key,
      agentId: "main",
      sessionId: "settings-chain-incarnation",
      kind: "direct",
      updatedAt: 2,
      model: "fixture-model",
      modelProvider: "fixture",
      thinkingLevel: "high",
      thinkingLevels: [
        { id: "low", label: "Low" },
        { id: "medium", label: "Medium" },
        { id: "high", label: "High" },
      ],
    } satisfies GatewaySessionRow;
    const rows: GatewaySessionRow[] = [];
    const firstReply = createDeferred<SessionsPatchResult>();
    const middleReply = createDeferred<SessionsPatchResult>();
    const middleDispatched = createDeferred();
    const primaryRead = createDeferred<SessionsListResult>();
    const primaryReadStarted = createDeferred();
    let firstAcknowledged = false;
    let holdPrimaryRead = lastTarget === "unbound";
    const firstReceipt = {
      ok: true,
      key,
      path: "",
      entry: {
        sessionId: materialized.sessionId,
        updatedAt: materialized.updatedAt,
        thinkingLevel: materialized.thinkingLevel,
      },
    } satisfies SessionsPatchResult;
    const patch = vi.fn<GatewayRequestHandler>((_method, raw) => {
      const params = asOptionalRecord(raw);
      if (params?.thinkingLevel === "high") {
        return firstReply.promise.then((receipt) => {
          firstAcknowledged = true;
          return receipt;
        });
      }
      if (params?.thinkingLevel === "low") {
        middleDispatched.resolve();
        return middleReply.promise;
      }
      if (params?.thinkingLevel !== "medium" || rows[0]?.sessionId !== materialized.sessionId) {
        throw new Error("Unexpected settings materialization chain patch");
      }
      rows[0] = { ...materialized, thinkingLevel: "medium", updatedAt: 3 };
      return {
        ok: true,
        key,
        path: "",
        entry: { sessionId: materialized.sessionId, thinkingLevel: "medium", updatedAt: 3 },
      } satisfies SessionsPatchResult;
    });
    const { sessions, mount, context } = createMountedPanes(rows, "main", undefined, {
      "sessions.patch": patch,
      "sessions.list": (_method, raw) => {
        if (firstAcknowledged && holdPrimaryRead && asOptionalRecord(raw)?.archived !== "all") {
          primaryReadStarted.resolve();
          return primaryRead.promise;
        }
        return sessionsResult([...rows], 2);
      },
    });
    let first: Promise<boolean> | undefined;
    let middle: Promise<boolean> | undefined;
    let last: Promise<boolean> | undefined;
    let managedRead: Promise<void> | undefined;
    let stopManaged: (() => void) | undefined;
    try {
      await sessions.refresh({ agentId: "main", force: true });
      const pane = mount(key);
      await refreshPane(pane);
      pane.state.chatModelCatalog = [
        { id: "fixture-model", name: "Fixture model", provider: "fixture", reasoning: true },
      ];
      expect(selectedChatSessionRow(pane.state)).toBeUndefined();
      first = switchChatThinkingLevel(pane.state, "high");
      middle = switchChatThinkingLevel(pane.state, "low");
      const middleReady = getPendingChatPickerPatch(pane.state, key, "main");
      if (lastTarget === "materialized") {
        rows.push(materialized);
        await sessions.refresh({ agentId: "main", force: true });
        expect(selectedChatSessionRow(pane.state)).toMatchObject(materialized);
      }
      last = switchChatThinkingLevel(pane.state, "medium");
      const lastReady = getPendingChatPickerPatch(pane.state, key, "main");
      expect(middleReady).toBeDefined();
      expect(lastReady).toBeDefined();
      expect(lastReady).not.toBe(middleReady);
      expect(patch).toHaveBeenCalledOnce();

      if (lastTarget === "unbound") {
        rows.push(materialized);
      }
      firstReply.resolve(firstReceipt);
      if (lastTarget === "unbound") {
        await Promise.race([primaryReadStarted.promise, first]);
        const query = { agentId: "main", archivedFilter: "all" as const };
        let managedFrame:
          | { thinkingLevel?: string; paneSessionId?: string; preview?: string }
          | undefined;
        stopManaged = sessions.subscribeList(query, (snapshot) => {
          const row = snapshot.result?.sessions.find((entry) => entry.key === key);
          if (!snapshot.loading && row && !managedFrame) {
            managedFrame = {
              thinkingLevel: row.thinkingLevel,
              paneSessionId: selectedChatSessionRow(pane.state)?.sessionId,
              preview: sessions.settingsPreview(key, "main")?.thinkingLevel,
            };
          }
        });
        managedRead = sessions.refreshList({ ...query, force: true });
        await managedRead;
        // Projecting into one list must not retire another consumer's pending preview.
        expect(managedFrame).toMatchObject({
          thinkingLevel: "medium",
          preview: "medium",
        });
        holdPrimaryRead = false;
        primaryRead.resolve(sessionsResult([...rows], 2));
      }
      await expect(first).resolves.toBe(true);
      await Promise.race([middleDispatched.promise, middle]);
      expect(patch).toHaveBeenCalledTimes(2);
      expect.soft(selectedChatSessionRow(pane.state)).toMatchObject({
        sessionId: materialized.sessionId,
        thinkingLevel: "medium",
      });
      const access = readChatPaneMutationAccess(context.gateway.snapshot, key);
      const controls = renderChatPaneComposerControls({
        state: pane.state,
        selectedSession: selectedChatSessionRow(pane.state),
        agentDefaultModel: undefined,
        modelAccess: access.model,
        effortAccess: access.effort,
        contextWindowAccess: access.contextWindow,
        permissionAccess: access.permission,
        canSelectFull: false,
        onModelSetup: vi.fn(),
      });
      const container = document.createElement("div");
      render(controls.composerControls, container);
      expect
        .soft(
          container.querySelector<HTMLElement>("[data-chat-thinking-select]")?.dataset
            .chatThinkingValue,
        )
        .toBe("medium");
      expect
        .soft(container.querySelector("[data-chat-thinking-preview-committed]")?.textContent)
        .toBe("Medium");
      middleReply.reject(new Error("Synthetic rejection of the middle settings choice"));
      await expect(Promise.all([first, middle, last])).resolves.toEqual([true, false, true]);
      await expect(middleReady).resolves.toBe(false);
      await expect(lastReady).resolves.toBe(true);
      expect(patch.mock.calls.map((call) => call[1])).toEqual([
        { key, thinkingLevel: "high" },
        { key, thinkingLevel: "low", expectedSessionId: materialized.sessionId },
        { key, thinkingLevel: "medium", expectedSessionId: materialized.sessionId },
      ]);
      expect(selectedChatSessionRow(pane.state)).toMatchObject({
        sessionId: materialized.sessionId,
        thinkingLevel: "medium",
      });
      expect(pane.state.chatThinkingLevel).toBe("medium");
      expect(getPendingChatPickerPatch(pane.state, key, "main")).toBeUndefined();
    } finally {
      stopManaged?.();
      holdPrimaryRead = false;
      primaryRead.resolve(sessionsResult([...rows], 2));
      firstReply.resolve(firstReceipt);
      middleReply.resolve(firstReceipt);
      await Promise.allSettled([first, middle, last, managedRead]);
      await vi.dynamicImportSettled();
    }
  },
);

it.each([
  ...(["absent", "placeholder"] as const).flatMap((initialState) =>
    (["success", "reasoning rejection", "rejection"] as const).map((outcome) => ({
      initialState,
      outcome,
    })),
  ),
  { initialState: "published placeholder", outcome: "reasoning rejection" },
])(
  "settles each queued preview when its ACK-adopted row stays unobserved ($initialState / $outcome)",
  async ({ initialState, outcome }) => {
    const key = "agent:main:settings-unobserved-adoption";
    const placeholder: GatewaySessionRow = {
      key,
      agentId: "main",
      kind: "direct",
      updatedAt: 1,
    };
    // The Gateway acknowledges a physical row that is still outside the UI's
    // observed roster. Neither history nor list reads invent its publication.
    const rows: GatewaySessionRow[] = initialState === "placeholder" ? [placeholder] : [];
    const firstReceipt = {
      ok: true,
      key,
      path: "",
      entry: { sessionId: "unobserved-ack-session", updatedAt: 2, thinkingLevel: "high" },
    } satisfies SessionsPatchResult;
    const firstReply = createDeferred<SessionsPatchResult>();
    const replies = Array.from({ length: 3 }, () => createDeferred<SessionsPatchResult>());
    const dispatched = Array.from({ length: 3 }, () => createDeferred());
    const requested = [
      { thinkingLevel: "low" },
      { fastMode: true },
      { contextWindow: "128k" },
    ] as const;
    const remainingPreviews = [
      { fastMode: true, effectiveFastMode: true, contextWindow: "128k" },
      { contextWindow: "128k" },
      undefined,
    ];
    const patch = vi.fn<GatewayRequestHandler>((_method, raw): Promise<SessionsPatchResult> => {
      if (patch.mock.calls.length === 1) {
        return firstReply.promise;
      }
      const index = patch.mock.calls.length - 2;
      const reply = replies[index];
      const started = dispatched[index];
      if (!reply || !started) {
        throw new Error("Unexpected unobserved settings request");
      }
      expect(raw).toEqual({
        key,
        ...requested[index],
        expectedSessionId: firstReceipt.entry.sessionId,
      });
      started.resolve();
      return reply.promise;
    });
    const { sessions, mount } = createMountedPanes(rows, "main", undefined, {
      "sessions.patch": patch,
    });
    let first: Promise<boolean> | undefined;
    const queued: Promise<boolean>[] = [];
    try {
      await sessions.refresh({ agentId: "main", force: true });
      const pane = mount(key);
      await refreshPane(pane);
      expect(selectedChatSessionRow(pane.state)?.sessionId).toBeUndefined();
      first = switchChatThinkingLevel(pane.state, "high");
      queued.push(switchChatThinkingLevel(pane.state, "low"));
      queued.push(switchChatFastMode(pane.state, "on"));
      queued.push(switchChatContextWindow(pane.state, "128k"));
      expect(patch).toHaveBeenCalledOnce();
      expect(patch.mock.calls[0]?.[1]).toEqual({ key, thinkingLevel: "high" });
      const pendingPreview = {
        thinkingLevel: "low",
        fastMode: true,
        effectiveFastMode: true,
        contextWindow: "128k",
      };
      expect(sessions.settingsPreview(key, "main")).toEqual(pendingPreview);

      if (initialState === "published placeholder") {
        rows.push(placeholder);
        await sessions.refresh({ agentId: "main", force: true });
        expect(selectedChatSessionRow(pane.state)).toMatchObject(placeholder);
        expect(patch).toHaveBeenCalledOnce();
      }

      firstReply.resolve(firstReceipt);
      await expect(first).resolves.toBe(true);
      for (const [index, reply] of replies.entries()) {
        const started = dispatched[index];
        const operation = queued[index];
        if (!started || !operation) {
          throw new Error("Expected each queued settings operation");
        }
        await Promise.race([started.promise, operation]);
        expect(patch).toHaveBeenCalledTimes(index + 2);
        if (index === 0) {
          expect(sessions.settingsPreview(key, "main")).toEqual(pendingPreview);
        }
        const rejected =
          outcome === "rejection" || (outcome === "reasoning rejection" && index === 0);
        if (rejected) {
          reply.reject(new Error(`Synthetic queued setting ${index} rejection`));
        } else {
          reply.resolve({
            ...firstReceipt,
            entry: {
              sessionId: firstReceipt.entry.sessionId,
              ...requested[index],
              updatedAt: index + 3,
            },
          });
        }
        await expect(operation).resolves.toBe(!rejected);
        // Releasing one field must retain the independently queued fields.
        expect.soft(sessions.settingsPreview(key, "main")).toEqual(remainingPreviews[index]);
        expect(selectedChatSessionRow(pane.state)?.sessionId).toBeUndefined();
        if (outcome === "success") {
          expect(pane.state.chatError).toBeNull();
        } else {
          // A later speed or context choice does not supersede the rejected reasoning choice.
          const failedIndex = outcome === "reasoning rejection" ? 0 : index;
          expect(pane.state.chatError).toContain(
            `Synthetic queued setting ${failedIndex} rejection`,
          );
          expect(pane.state.lastError).toBe(pane.state.chatError);
        }
      }
      expect(getPendingChatPickerPatch(pane.state, key, "main")).toBeUndefined();
      if (outcome !== "success") {
        expect(pane.state.chatError).toContain(
          outcome === "reasoning rejection"
            ? "Synthetic queued setting 0 rejection"
            : "Synthetic queued setting 2 rejection",
        );
        expect(pane.state.lastError).toBe(pane.state.chatError);
      } else {
        expect(pane.state.chatError).toBeNull();
      }
    } finally {
      firstReply.resolve(firstReceipt);
      for (const reply of replies) {
        reply.resolve(firstReceipt);
      }
      await Promise.allSettled([first, ...queued]);
      await vi.dynamicImportSettled();
    }
  },
);
