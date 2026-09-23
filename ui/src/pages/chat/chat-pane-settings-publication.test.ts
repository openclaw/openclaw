/* @vitest-environment jsdom */

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewaySessionRow } from "../../api/types.ts";
import { sessionsResult } from "../../lib/sessions/session-capability.test-support.ts";
import type { GatewayRequestHandler } from "../../test-helpers/gateway-client.ts";
import { createMountedPanes, refreshPane } from "./chat-pane-mounted.test-support.ts";
import {
  switchChatContextWindow,
  switchChatFastMode,
  switchChatThinkingLevel,
} from "./chat-session.ts";
import { selectedChatSessionRow } from "./chat-state-route.ts";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
} from "./components/chat-transcript.test-support.ts";

beforeEach(installTranscriptDomMocks);
afterEach(resetTranscriptTestDom);

it.each(["confirmed", "rejected"] as const)(
  "keeps a held thinking patch visible across mounted panes until it is %s",
  async (outcome) => {
    const row: GatewaySessionRow = {
      key: "agent:main:held-effort",
      agentId: "main",
      sessionId: "held-effort-session",
      kind: "direct",
      updatedAt: 1,
      thinkingLevel: "high",
    };
    const other: GatewaySessionRow = {
      ...row,
      key: "agent:main:unrelated",
      sessionId: "unrelated-session",
      thinkingLevel: "medium",
    };
    const rows = [row, other];
    const acknowledgement = createDeferred<unknown>();
    const patch = vi.fn<GatewayRequestHandler>(() => acknowledgement.promise);
    const { sessions, mount, emitGatewayEvent } = createMountedPanes(rows, "main", undefined, {
      "sessions.patch": patch,
    });
    let operation: Promise<boolean> | undefined;
    try {
      await sessions.refresh({ agentId: "main", force: true });
      const panes = [mount(row.key), mount(row.key)];
      await Promise.all(panes.map(refreshPane));
      for (const pane of panes) {
        expect(selectedChatSessionRow(pane.state)).toMatchObject(row);
      }
      operation = switchChatThinkingLevel(panes[0]!.state, "off");
      expect(patch.mock.calls[0]?.[1]).toMatchObject({ key: row.key, thinkingLevel: "off" });
      const assertThinking = (thinkingLevel: string) => {
        for (const pane of panes) {
          expect(pane.state.currentSessionId).toBe(row.sessionId);
          expect(selectedChatSessionRow(pane.state)).toMatchObject({
            key: row.key,
            sessionId: row.sessionId,
            thinkingLevel,
          });
        }
      };
      assertThinking("off");
      emitGatewayEvent("sessions.changed", {
        sessionKey: other.key,
        agentId: "main",
        reason: "label",
        session: { ...other, updatedAt: 2, label: "Unrelated publication" },
      });
      expect(sessions.state.result?.sessions.find((entry) => entry.key === other.key)?.label).toBe(
        "Unrelated publication",
      );
      assertThinking("off");
      if (outcome === "confirmed") {
        rows[0] = { ...row, thinkingLevel: "off", updatedAt: 3 };
        acknowledgement.resolve({ ok: true, key: row.key, path: "", entry: rows[0] });
      } else {
        acknowledgement.reject(new Error("Synthetic thinking patch rejection"));
      }
      await expect(operation).resolves.toBe(outcome === "confirmed");
      assertThinking(outcome === "confirmed" ? "off" : "high");
    } finally {
      acknowledgement.resolve({ ok: true, key: row.key, path: "", entry: rows[0] });
      await operation;
      await vi.dynamicImportSettled();
    }
  },
);

it.each(["qualified", "global"] as const)(
  "keeps a descriptor-only thinking preview and rollback with its caller (%s)",
  async (scope) => {
    const primary: GatewaySessionRow = {
      key: scope === "global" ? "global" : "agent:main:primary",
      agentId: "main",
      sessionId: "same-id-in-separate-agent-stores",
      kind: scope === "global" ? "global" : "direct",
      updatedAt: 1,
      thinkingLevel: "medium",
    };
    const target: GatewaySessionRow = {
      ...primary,
      key: scope === "global" ? "global" : "agent:research:held-effort",
      agentId: "research",
      thinkingLevel: "high",
    };
    const acknowledgement = createDeferred<unknown>();
    const patch = vi.fn<GatewayRequestHandler>(() => acknowledgement.promise);
    const { sessions, mount, emitGatewayEvent } = createMountedPanes(
      [primary, target],
      "main",
      undefined,
      {
        "sessions.list": () => sessionsResult([primary], 1),
        "sessions.patch": patch,
      },
    );
    let operation: Promise<boolean> | undefined;
    try {
      await sessions.refresh({ agentId: "main", force: true });
      const main = mount(primary.key, "main");
      const panes = [mount(target.key, "research"), mount(target.key, "research")];
      await Promise.all([main, ...panes].map(refreshPane));
      if (scope === "qualified") {
        // Finish history's primary projection before a shared publication projects
        // the independently observed qualified descriptor back into each pane.
        await sessions.refresh({ agentId: "main", force: true });
      }
      expect(sessions.state.agentId).toBe("main");
      expect(sessions.state.result?.sessions).toEqual([expect.objectContaining(primary)]);
      for (const pane of panes) {
        expect(selectedChatSessionRow(pane.state)).toMatchObject(target);
      }
      operation = switchChatThinkingLevel(panes[0]!.state, "off");
      expect(patch.mock.calls[0]?.[1]).toMatchObject({ key: target.key, thinkingLevel: "off" });
      const assertOwned = (thinkingLevel: string) => {
        expect(selectedChatSessionRow(main.state)).toMatchObject(primary);
        expect(sessions.state.result?.sessions).toEqual([expect.objectContaining(primary)]);
        for (const pane of panes) {
          expect(pane.state.currentSessionId).toBe(target.sessionId);
          expect(selectedChatSessionRow(pane.state)).toMatchObject({
            key: target.key,
            agentId: "research",
            sessionId: target.sessionId,
            thinkingLevel,
          });
        }
      };
      assertOwned("off");
      emitGatewayEvent("sessions.changed", {
        sessionKey: primary.key,
        agentId: "main",
        reason: "label",
        session: { ...primary, updatedAt: 2, label: "Other owner publication" },
      });
      expect(sessions.state.result?.sessions[0]?.label).toBe("Other owner publication");
      expect(selectedChatSessionRow(main.state)?.thinkingLevel).toBe("medium");
      for (const pane of panes) {
        expect(selectedChatSessionRow(pane.state)?.thinkingLevel).toBe("off");
      }
      acknowledgement.reject(new Error("Synthetic foreign-owner thinking rejection"));
      await expect(operation).resolves.toBe(false);
      expect(selectedChatSessionRow(main.state)?.thinkingLevel).toBe("medium");
      for (const pane of panes) {
        expect(selectedChatSessionRow(pane.state)).toMatchObject(target);
      }
    } finally {
      acknowledgement.resolve({ ok: true, key: target.key, path: "", entry: target });
      await operation;
      await vi.dynamicImportSettled();
    }
  },
);

it("does not roll an old thinking patch back onto a replacement physical session", async () => {
  const previous: GatewaySessionRow = {
    key: "agent:main:replaced-effort",
    agentId: "main",
    sessionId: "previous-session",
    kind: "direct",
    updatedAt: 1,
    thinkingLevel: "high",
  };
  const replacement = {
    ...previous,
    sessionId: "replacement-session",
    updatedAt: 2,
    thinkingLevel: "low",
  };
  const rows = [previous];
  const acknowledgement = createDeferred<unknown>();
  const { sessions, mount, emitGatewayEvent } = createMountedPanes(rows, "main", undefined, {
    "sessions.patch": () => acknowledgement.promise,
  });
  let operation: Promise<boolean> | undefined;
  try {
    await sessions.refresh({ agentId: "main", force: true });
    const pane = mount(previous.key);
    await refreshPane(pane);
    operation = switchChatThinkingLevel(pane.state, "off");
    expect(selectedChatSessionRow(pane.state)?.thinkingLevel).toBe("off");
    rows[0] = replacement;
    await sessions.refresh({ agentId: "main", force: true });
    emitGatewayEvent("sessions.changed", {
      sessionKey: replacement.key,
      agentId: "main",
      reason: "label",
      session: replacement,
    });
    await refreshPane(pane);
    expect(pane.state.currentSessionId).toBe(replacement.sessionId);
    expect(selectedChatSessionRow(pane.state)).toMatchObject(replacement);
    acknowledgement.reject(new Error("Synthetic previous-session patch rejection"));
    await expect(operation).resolves.toBe(false);
    expect(pane.state.currentSessionId).toBe(replacement.sessionId);
    expect(selectedChatSessionRow(pane.state)).toMatchObject(replacement);
    expect(sessions.state.result?.sessions).toEqual([expect.objectContaining(replacement)]);
  } finally {
    acknowledgement.resolve({ ok: true, key: previous.key, path: "", entry: previous });
    await operation;
    await vi.dynamicImportSettled();
  }
});

it.each(["thinking", "speed", "context"] as const)(
  "preserves a newer same-session %s event when the held local patch fails",
  async (setting) => {
    const initial: GatewaySessionRow = {
      key: "agent:main:concurrent-settings",
      agentId: "main",
      sessionId: "current-session",
      kind: "direct",
      updatedAt: 1,
      thinkingLevel: "high",
      fastMode: false,
      effectiveFastMode: false,
      contextWindow: "64k",
    };
    const newer: GatewaySessionRow = {
      ...initial,
      updatedAt: 3,
      ...(setting === "thinking"
        ? { thinkingLevel: "medium" }
        : setting === "speed"
          ? { fastMode: "auto" as const, effectiveFastMode: true }
          : { contextWindow: "256k" }),
    };
    const pendingFields: Partial<GatewaySessionRow> =
      setting === "thinking"
        ? { thinkingLevel: "off" }
        : setting === "speed"
          ? { fastMode: true, effectiveFastMode: true }
          : { contextWindow: "128k" };
    const rows = [initial];
    const acknowledgement = createDeferred<unknown>();
    const patch = vi.fn<GatewayRequestHandler>(() => acknowledgement.promise);
    const { sessions, mount, emitGatewayEvent } = createMountedPanes(rows, "main", undefined, {
      "sessions.patch": patch,
    });
    let operation: Promise<boolean> | undefined;
    try {
      await sessions.refresh({ agentId: "main", force: true });
      const panes = [mount(initial.key), mount(initial.key)];
      await Promise.all(panes.map(refreshPane));
      for (const pane of panes) {
        expect(selectedChatSessionRow(pane.state)).toMatchObject(initial);
      }
      const state = panes[0]!.state;
      operation =
        setting === "thinking"
          ? switchChatThinkingLevel(state, "off")
          : setting === "speed"
            ? switchChatFastMode(state, "on")
            : switchChatContextWindow(state, "128k");
      expect(patch).toHaveBeenCalledOnce();
      rows[0] = newer;
      emitGatewayEvent("sessions.changed", {
        sessionKey: initial.key,
        agentId: "main",
        sessionId: initial.sessionId,
        reason: "patch",
        session: newer,
      });
      const assertRows = (expected: GatewaySessionRow) => {
        expect(sessions.state.result?.sessions).toEqual([expect.objectContaining(expected)]);
        for (const pane of panes) {
          expect(pane.state.currentSessionId).toBe(initial.sessionId);
          expect(selectedChatSessionRow(pane.state)).toMatchObject(expected);
        }
      };
      assertRows({ ...newer, ...pendingFields });
      acknowledgement.reject(new Error("Synthetic rejected local settings patch"));
      await expect(operation).resolves.toBe(false);
      assertRows(newer);
    } finally {
      acknowledgement.resolve({ ok: true, key: initial.key, path: "", entry: rows[0] });
      await operation;
      await vi.dynamicImportSettled();
    }
  },
);

it.each(
  (["thinking", "speed", "context"] as const).flatMap((setting) =>
    (["delayed", "failed"] as const).map((read) => ({ setting, read })),
  ),
)(
  "retains a standalone $setting ACK when the canonical read is $read",
  async ({ setting, read }) => {
    const initial: GatewaySessionRow = {
      key: "agent:main:settings-ack",
      agentId: "main",
      sessionId: "settings-ack-session",
      kind: "direct",
      updatedAt: 1,
      thinkingLevel: "high",
      fastMode: false,
      effectiveFastMode: false,
      contextWindow: "64k",
    };
    const fields =
      setting === "thinking"
        ? { thinkingLevel: "off" }
        : setting === "speed"
          ? { fastMode: true }
          : { contextWindow: "128k" };
    const acknowledgement = {
      ok: true,
      key: initial.key,
      path: "",
      entry: { sessionId: initial.sessionId, updatedAt: 2, ...fields },
    };
    const readStarted = createDeferred();
    const readReply = createDeferred<ReturnType<typeof sessionsResult>>();
    let acknowledged = false;
    const patch = vi.fn<GatewayRequestHandler>(() => {
      acknowledged = true;
      return acknowledgement;
    });
    const { sessions, mount } = createMountedPanes([initial], "main", undefined, {
      "sessions.patch": patch,
      "sessions.list": () => {
        if (!acknowledged) {
          return sessionsResult([initial], 1);
        }
        readStarted.resolve();
        if (read === "failed") {
          throw new Error("Synthetic canonical read failure after committed settings");
        }
        return readReply.promise;
      },
    });
    let operation: ReturnType<typeof sessions.patch> | undefined;
    try {
      await sessions.refresh({ agentId: "main", force: true });
      const panes = [mount(initial.key), mount(initial.key)];
      await Promise.all(panes.map(refreshPane));
      operation = sessions.patch(initial.key, fields, { agentId: "main" });
      await Promise.race([
        readStarted.promise,
        operation.then(() => {
          throw new Error("Settings settled without reaching canonical readback");
        }),
      ]);
      expect(patch.mock.calls[0]?.[1]).toMatchObject({
        key: initial.key,
        expectedSessionId: initial.sessionId,
        ...fields,
      });
      const assertReceiptFields = () => {
        const expected = { key: initial.key, sessionId: initial.sessionId, ...fields };
        expect(sessions.state.result?.sessions).toEqual([expect.objectContaining(expected)]);
        for (const pane of panes) {
          expect(pane.state.currentSessionId).toBe(initial.sessionId);
          expect(selectedChatSessionRow(pane.state)).toMatchObject(expected);
        }
      };
      assertReceiptFields();
      readReply.resolve(sessionsResult([initial], 1));
      await expect(operation).resolves.toMatchObject(acknowledgement);
      assertReceiptFields();
      expect(patch).toHaveBeenCalledOnce();
    } finally {
      readReply.resolve(sessionsResult([initial], 1));
      await operation;
      await vi.dynamicImportSettled();
    }
  },
);

it.each(["confirmed", "rejected", "both-rejected"] as const)(
  "settles overlapping settings without retiring the latest pending choice (%s)",
  async (outcome) => {
    const initial: GatewaySessionRow = {
      key: "agent:main:settings-own-event",
      agentId: "main",
      sessionId: "settings-own-event-session",
      kind: "direct",
      updatedAt: 1,
      thinkingLevel: "high",
    };
    const firstCommitted = { ...initial, updatedAt: 2, thinkingLevel: "off" };
    const secondCommitted = { ...initial, updatedAt: 3, thinkingLevel: "low" };
    const rows = [initial];
    const firstReply = createDeferred<unknown>();
    const secondReply = createDeferred<unknown>();
    const secondDispatched = createDeferred();
    let calls = 0;
    const patch = vi.fn<GatewayRequestHandler>(() => {
      calls += 1;
      if (calls === 1) {
        return firstReply.promise;
      }
      expect(calls).toBe(2);
      secondDispatched.resolve();
      return secondReply.promise;
    });
    const { sessions, mount, emitGatewayEvent } = createMountedPanes(rows, "main", undefined, {
      "sessions.patch": patch,
    });
    let first: Promise<boolean> | undefined;
    let second: Promise<boolean> | undefined;
    let secondSettled = false;
    try {
      await sessions.refresh({ agentId: "main", force: true });
      const panes = [mount(initial.key), mount(initial.key)];
      await Promise.all(panes.map(refreshPane));
      const assertThinking = (thinkingLevel: string) => {
        const expected = { key: initial.key, sessionId: initial.sessionId, thinkingLevel };
        expect(sessions.state.result?.sessions).toEqual([expect.objectContaining(expected)]);
        for (const pane of panes) {
          expect(pane.state.currentSessionId).toBe(initial.sessionId);
          expect(selectedChatSessionRow(pane.state)).toMatchObject(expected);
        }
      };
      assertThinking("high");
      first = switchChatThinkingLevel(panes[0]!.state, "off");
      expect(patch).toHaveBeenCalledOnce();
      assertThinking("off");
      second = switchChatThinkingLevel(panes[1]!.state, "low");
      void second.then(
        () => {
          secondSettled = true;
        },
        () => {
          secondSettled = true;
        },
      );
      expect(patch).toHaveBeenCalledOnce();
      assertThinking("low");
      if (outcome === "both-rejected") {
        firstReply.reject(new Error("Synthetic first settings rejection"));
      } else {
        rows[0] = firstCommitted;
        emitGatewayEvent("sessions.changed", {
          sessionKey: initial.key,
          agentId: "main",
          sessionId: initial.sessionId,
          reason: "patch",
          session: firstCommitted,
        });
        assertThinking("low");
        firstReply.resolve({ ok: true, key: initial.key, path: "", entry: firstCommitted });
      }
      await expect(first).resolves.toBe(outcome !== "both-rejected");
      await Promise.race([secondDispatched.promise, second]);
      expect(patch).toHaveBeenCalledTimes(2);
      expect(secondSettled).toBe(false);
      assertThinking("low");
      if (outcome === "confirmed") {
        rows[0] = secondCommitted;
        secondReply.resolve({ ok: true, key: initial.key, path: "", entry: secondCommitted });
      } else {
        secondReply.reject(new Error("Synthetic latest settings rejection"));
      }
      await expect(second).resolves.toBe(outcome === "confirmed");
      assertThinking(
        outcome === "confirmed" ? "low" : outcome === "both-rejected" ? "high" : "off",
      );
    } finally {
      firstReply.resolve({ ok: true, key: initial.key, path: "", entry: rows[0] });
      secondReply.resolve({ ok: true, key: initial.key, path: "", entry: rows[0] });
      await Promise.allSettled([first, second]);
      await vi.dynamicImportSettled();
    }
  },
);
