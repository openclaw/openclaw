/* @vitest-environment jsdom */

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewaySessionRow } from "../../api/types.ts";
import { sessionsResult } from "../../lib/sessions/session-capability.test-support.ts";
import type { GatewayRequestHandler } from "../../test-helpers/gateway-client.ts";
import { createMountedPanes, refreshPane } from "./chat-pane-mounted.test-support.ts";
import { switchChatThinkingLevel } from "./chat-session.ts";
import { selectedChatSessionRow } from "./chat-state-route.ts";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
} from "./components/chat-transcript.test-support.ts";

beforeEach(installTranscriptDomMocks);
afterEach(resetTranscriptTestDom);

const initialRow = (): GatewaySessionRow => ({
  key: "agent:main:settings-ownership",
  agentId: "main",
  sessionId: "settings-ownership-session",
  kind: "direct",
  updatedAt: 1,
  label: "Original label",
  thinkingLevel: "high",
  fastMode: false,
  effectiveFastMode: false,
  contextWindow: "64k",
});

it("rolls rejected thinking back while preserving an authoritative update to another field", async () => {
  const initial = initialRow();
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
    const assertRows = (fields: Partial<GatewaySessionRow>) => {
      const expected = { key: initial.key, sessionId: initial.sessionId, ...fields };
      expect(sessions.state.result?.sessions).toEqual([expect.objectContaining(expected)]);
      for (const pane of panes) {
        expect(pane.state.currentSessionId).toBe(initial.sessionId);
        expect(selectedChatSessionRow(pane.state)).toMatchObject(expected);
      }
    };
    assertRows(initial);
    operation = switchChatThinkingLevel(panes[0]!.state, "off");
    expect(patch).toHaveBeenCalledOnce();
    assertRows({ thinkingLevel: "off" });
    const label = "Authoritative label while settings are pending";
    rows[0] = { ...initial, updatedAt: 3, label };
    emitGatewayEvent("sessions.changed", {
      sessionKey: initial.key,
      agentId: "main",
      sessionId: initial.sessionId,
      reason: "label",
      updatedAt: 3,
      label,
    });
    assertRows({ thinkingLevel: "off", label });
    acknowledgement.reject(new Error("Synthetic rejected settings after label update"));
    await expect(operation).resolves.toBe(false);
    assertRows({ ...initial, updatedAt: 3, label });
  } finally {
    acknowledgement.resolve({ ok: true, key: initial.key, path: "", entry: rows[0] });
    await operation;
    await vi.dynamicImportSettled();
  }
});

it.each(["rejected", "older-clock ACK", "equal-clock ACK"] as const)(
  "retains settled thinking facts after an older direct capability patch returns %s",
  async (outcome) => {
    const initial = initialRow();
    const firstFields = { thinkingLevel: "off" };
    const secondFields = { thinkingLevel: "low" };
    const firstReply = createDeferred<unknown>();
    const secondReply = createDeferred<unknown>();
    const firstAcknowledgement = {
      ok: true,
      key: initial.key,
      path: "",
      entry: {
        sessionId: initial.sessionId,
        updatedAt: outcome === "equal-clock ACK" ? 3 : 2,
        ...firstFields,
      },
    };
    const secondAcknowledgement = {
      ok: true,
      key: initial.key,
      path: "",
      entry: { sessionId: initial.sessionId, updatedAt: 3, ...secondFields },
    };
    let calls = 0;
    const patch = vi.fn<GatewayRequestHandler>(() => {
      calls += 1;
      if (calls === 1) {
        return firstReply.promise;
      }
      expect(calls).toBe(2);
      return secondReply.promise;
    });
    const { sessions, mount } = createMountedPanes([initial], "main", undefined, {
      "sessions.patch": patch,
    });
    let first: ReturnType<typeof sessions.patch> | undefined;
    let second: ReturnType<typeof sessions.patch> | undefined;
    let firstSettled = false;
    try {
      await sessions.refresh({ agentId: "main", force: true });
      const panes = [mount(initial.key), mount(initial.key)];
      await Promise.all(panes.map(refreshPane));
      const assertFields = (fields: Partial<GatewaySessionRow>) => {
        const expected = { key: initial.key, sessionId: initial.sessionId, ...fields };
        expect(sessions.state.result?.sessions).toEqual([expect.objectContaining(expected)]);
        for (const pane of panes) {
          expect(pane.state.currentSessionId).toBe(initial.sessionId);
          expect(selectedChatSessionRow(pane.state)).toMatchObject(expected);
        }
      };
      assertFields(initial);
      const options = {
        agentId: "main",
        expectedSessionId: initial.sessionId,
        deferListRefresh: true,
      };
      // Direct capability callers can overlap; chat pickers serialize their RPCs separately.
      first = sessions.patch(initial.key, firstFields, options);
      const firstOutcome = Promise.allSettled([first]).then((results) => {
        firstSettled = true;
        return results;
      });
      assertFields(firstFields);
      second = sessions.patch(initial.key, secondFields, options);
      expect(patch).toHaveBeenCalledTimes(2);
      assertFields(secondFields);

      secondReply.resolve(secondAcknowledgement);
      await expect(second).resolves.toMatchObject(secondAcknowledgement);
      expect(firstSettled).toBe(false);
      assertFields(secondFields);

      const rejection = new Error("Synthetic late rejection after successor settled");
      if (outcome === "rejected") {
        firstReply.reject(rejection);
      } else {
        firstReply.resolve(firstAcknowledgement);
      }
      const [settled] = await firstOutcome;
      if (outcome === "rejected") {
        expect(settled).toEqual({ status: "rejected", reason: rejection });
      } else {
        expect(settled).toMatchObject({ status: "fulfilled", value: firstAcknowledgement });
      }
      assertFields(secondFields);
      expect(patch).toHaveBeenCalledTimes(2);
    } finally {
      firstReply.resolve(firstAcknowledgement);
      secondReply.resolve(secondAcknowledgement);
      await Promise.allSettled([first, second]);
      await vi.dynamicImportSettled();
    }
  },
);

it.each([
  { read: "deferred", overlap: false, observeEffective: false },
  { read: "failed", overlap: false, observeEffective: false },
  { read: "deferred", overlap: true, observeEffective: false },
  { read: "failed", overlap: true, observeEffective: false },
  { read: "deferred", overlap: true, observeEffective: true },
  { read: "fresh", overlap: true, observeEffective: false },
] as const)(
  "settles only admitted effective speed ($read read, overlap=$overlap, event=$observeEffective)",
  async ({ read, overlap, observeEffective }) => {
    const initial = initialRow();
    const firstReply = createDeferred<unknown>();
    const secondReply = createDeferred<unknown>();
    let calls = 0;
    let acknowledged = false;
    let postAckReads = 0;
    let committed = initial;
    const patch = vi.fn<GatewayRequestHandler>(() => {
      calls += 1;
      if (calls === 1) {
        return firstReply.promise;
      }
      expect(calls).toBe(2);
      return secondReply.promise;
    });
    const { sessions, mount, emitGatewayEvent } = createMountedPanes([initial], "main", undefined, {
      "sessions.patch": patch,
      "sessions.list": () => {
        if (!acknowledged) {
          return sessionsResult([initial], 1);
        }
        postAckReads += 1;
        if (read === "failed") {
          throw new Error("Synthetic unavailable effective-speed readback");
        }
        return sessionsResult(
          read === "fresh"
            ? [{ ...committed, updatedAt: (committed.updatedAt ?? 0) + 1, effectiveFastMode: true }]
            : [initial],
          (committed.updatedAt ?? 0) + 1,
        );
      },
    });
    let first: ReturnType<typeof sessions.patch> | undefined;
    let second: ReturnType<typeof sessions.patch> | undefined;
    try {
      await sessions.refresh({ agentId: "main", force: true });
      const panes = [mount(initial.key), mount(initial.key)];
      await Promise.all(panes.map(refreshPane));
      const assertModes = (
        fastMode: GatewaySessionRow["fastMode"],
        effectiveFastMode: GatewaySessionRow["effectiveFastMode"],
      ) => {
        const expected = { sessionId: initial.sessionId, fastMode, effectiveFastMode };
        expect(sessions.state.result?.sessions).toEqual([expect.objectContaining(expected)]);
        for (const pane of panes) {
          expect(pane.state.currentSessionId).toBe(initial.sessionId);
          expect(selectedChatSessionRow(pane.state)).toMatchObject(expected);
        }
      };
      const options = { agentId: "main", deferListRefresh: read === "deferred" };
      first = sessions.patch(initial.key, { fastMode: true }, options);
      expect(patch).toHaveBeenCalledOnce();
      assertModes(true, true);
      if (observeEffective) {
        emitGatewayEvent("sessions.changed", {
          sessionKey: initial.key,
          agentId: "main",
          sessionId: initial.sessionId,
          reason: "patch",
          session: { ...initial, updatedAt: 2, fastMode: true, effectiveFastMode: true },
        });
        expect(sessions.state.result?.sessions[0]?.updatedAt).toBe(2);
      }
      if (overlap) {
        second = sessions.patch(initial.key, { fastMode: "auto" }, options);
        expect(patch).toHaveBeenCalledTimes(2);
        assertModes("auto", "auto");
      }

      committed = { ...initial, updatedAt: 3, fastMode: true };
      acknowledged = true;
      firstReply.resolve({
        ok: true,
        key: initial.key,
        path: "",
        entry: { sessionId: initial.sessionId, updatedAt: 3, fastMode: true },
      });
      await expect(first).resolves.toMatchObject({ entry: { fastMode: true } });
      if (overlap) {
        assertModes("auto", "auto");
        committed = { ...initial, updatedAt: 5, fastMode: "auto" };
        secondReply.resolve({
          ok: true,
          key: initial.key,
          path: "",
          entry: { sessionId: initial.sessionId, updatedAt: 5, fastMode: "auto" },
        });
        await expect(second).resolves.toMatchObject({ entry: { fastMode: "auto" } });
      }
      if (read === "deferred") {
        expect(postAckReads).toBe(0);
      } else {
        expect(postAckReads).toBeGreaterThan(0);
      }
      assertModes(overlap ? "auto" : true, observeEffective || read === "fresh");
    } finally {
      firstReply.resolve({
        ok: true,
        key: initial.key,
        path: "",
        entry: { sessionId: initial.sessionId, updatedAt: 3, fastMode: true },
      });
      secondReply.resolve({
        ok: true,
        key: initial.key,
        path: "",
        entry: { sessionId: initial.sessionId, updatedAt: 5, fastMode: "auto" },
      });
      await Promise.allSettled([first, second]);
      await vi.dynamicImportSettled();
    }
  },
);
