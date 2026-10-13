/* @vitest-environment jsdom */

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewaySessionRow } from "../../api/types.ts";
import { sessionsResult } from "../../lib/sessions/session-capability.test-support.ts";
import type { GatewayRequestHandler } from "../../test-helpers/gateway-client.ts";
import { createMountedPanes, refreshPane } from "./chat-pane-mounted.test-support.ts";
import { switchChatSetting } from "./chat-session.ts";
import { selectedChatSessionRow } from "./chat-state-route.ts";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
} from "./components/chat-transcript.test-support.ts";

beforeEach(installTranscriptDomMocks);
afterEach(resetTranscriptTestDom);

it.each([
  "unrelated confirmed",
  "unrelated rejected",
  "replacement",
  "thinking",
  "speed",
  "label",
] as const)(
  "reconciles a held settings preview with authoritative publication: %s",
  async (change) => {
    const initial: GatewaySessionRow = {
      key: "agent:main:settings-publication",
      agentId: "main",
      sessionId: "current-session",
      kind: "direct",
      updatedAt: 1,
      label: "Original label",
      thinkingLevel: "high",
      fastMode: false,
      effectiveFastMode: false,
      contextWindow: "64k",
    };
    const other: GatewaySessionRow = {
      ...initial,
      key: "agent:main:unrelated",
      sessionId: "unrelated-session",
      thinkingLevel: "medium",
    };
    const unrelated = change.startsWith("unrelated");
    const confirmed = change === "unrelated confirmed";
    const rows = unrelated ? [initial, other] : [initial];
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
      const assertRows = (expected: GatewaySessionRow) => {
        expect(sessions.state.result?.sessions.filter((row) => row.key === initial.key)).toEqual([
          expect.objectContaining(expected),
        ]);
        for (const pane of panes) {
          expect(pane.state.currentSessionId).toBe(expected.sessionId);
          expect(selectedChatSessionRow(pane.state)).toMatchObject(expected);
        }
      };
      assertRows(initial);
      const pendingFields: Partial<GatewaySessionRow> =
        change === "speed" ? { fastMode: true, effectiveFastMode: true } : { thinkingLevel: "off" };
      operation =
        change === "speed"
          ? switchChatSetting(panes[0]!.state, { kind: "fastMode", value: "on" })
          : switchChatSetting(panes[0]!.state, { kind: "thinkingLevel", value: "off" });
      expect(patch).toHaveBeenCalledOnce();
      expect(patch.mock.calls[0]?.[1]).toMatchObject({
        key: initial.key,
        ...(change === "speed" ? { fastMode: true } : { thinkingLevel: "off" }),
      });
      assertRows({ ...initial, ...pendingFields });
      let authoritative = initial;
      if (unrelated) {
        rows[1] = { ...other, updatedAt: 2, label: "Unrelated publication" };
        emitGatewayEvent("sessions.changed", {
          sessionKey: other.key,
          agentId: "main",
          reason: "label",
          session: rows[1],
        });
        expect(sessions.state.result?.sessions.find((row) => row.key === other.key)?.label).toBe(
          "Unrelated publication",
        );
        assertRows({ ...initial, ...pendingFields });
      } else {
        authoritative = {
          ...initial,
          updatedAt: 3,
          ...(change === "replacement"
            ? { sessionId: "replacement-session", thinkingLevel: "low" }
            : change === "thinking"
              ? { thinkingLevel: "medium" }
              : change === "speed"
                ? { fastMode: "auto", effectiveFastMode: true }
                : { label: "Authoritative label while settings are pending" }),
        };
        rows[0] = authoritative;
        if (change === "replacement") {
          await sessions.refresh({ agentId: "main", force: true });
        }
        emitGatewayEvent("sessions.changed", {
          sessionKey: initial.key,
          agentId: "main",
          ...(change === "replacement" ? {} : { sessionId: authoritative.sessionId }),
          reason: change === "label" || change === "replacement" ? "label" : "patch",
          ...(change === "label"
            ? { updatedAt: 3, label: authoritative.label }
            : { session: authoritative }),
        });
        if (change === "replacement") {
          await Promise.all(panes.map(refreshPane));
          assertRows(authoritative);
        } else {
          assertRows({ ...authoritative, ...pendingFields });
        }
      }
      if (confirmed) {
        authoritative = { ...initial, thinkingLevel: "off", updatedAt: 3 };
        rows[0] = authoritative;
        acknowledgement.resolve({ ok: true, key: initial.key, path: "", entry: authoritative });
      } else {
        acknowledgement.reject(new Error("Synthetic settings rejection after publication"));
      }
      await expect(operation).resolves.toBe(confirmed);
      assertRows(authoritative);
    } finally {
      acknowledgement.resolve({ ok: true, key: initial.key, path: "", entry: rows[0] });
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
      operation = switchChatSetting(panes[0]!.state, { kind: "thinkingLevel", value: "off" });
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

it.each(["delayed", "failed"] as const)(
  "retains a standalone thinking ACK when the canonical read is %s",
  async (read) => {
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
    const fields = { thinkingLevel: "off" };
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
      first = switchChatSetting(panes[0]!.state, { kind: "thinkingLevel", value: "off" });
      expect(patch).toHaveBeenCalledOnce();
      assertThinking("off");
      second = switchChatSetting(panes[1]!.state, { kind: "thinkingLevel", value: "low" });
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
