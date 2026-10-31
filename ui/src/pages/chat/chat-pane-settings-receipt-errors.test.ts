/* @vitest-environment jsdom */

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewaySessionRow, SessionsPatchResult } from "../../api/types.ts";
import { sessionsResult } from "../../lib/sessions/session-capability.test-support.ts";
import { withSessionMutationOperations } from "../../lib/sessions/session-mutation-operations.ts";
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
  "current",
  "replacement",
  "same-client reconnect",
  "failed readback",
  "unbound",
  "unbound confirmed",
] as const)("settles queued settings against their current owner (%s)", async (outcome) => {
  const unboundConfirmed = outcome === "unbound confirmed";
  const unbound = outcome === "unbound" || unboundConfirmed;
  const readbackFails = outcome === "failed readback" || unboundConfirmed;
  const key = "agent:main:settings";
  const entry = { sessionId: "acknowledged-session", updatedAt: 2, thinkingLevel: "high" };
  const row: GatewaySessionRow = { key, agentId: "main", kind: "direct", ...entry };
  const receipt = { ok: true, key, path: "", entry } satisfies SessionsPatchResult;
  const rows: GatewaySessionRow[] = [];
  const firstReply = createDeferred<SessionsPatchResult>();
  const latestReply = createDeferred<SessionsPatchResult>();
  const dispatched = createDeferred();
  const readbackError = new Error("Synthetic roster read failure after settings ACK");
  let acknowledged = false;
  let failedReads = 0;
  const patch = vi.fn<GatewayRequestHandler>(() => {
    if (patch.mock.calls.length === 1) {
      return firstReply.promise.then((result) => {
        acknowledged = true;
        return result;
      });
    }
    dispatched.resolve();
    return unboundConfirmed
      ? latestReply.promise.then((result) => {
          acknowledged = true;
          return result;
        })
      : latestReply.promise;
  });
  const mounted = createMountedPanes(rows, "main", undefined, {
    "sessions.patch": patch,
    ...(readbackFails
      ? {
          "sessions.list": () => {
            if (acknowledged) {
              failedReads++;
              throw readbackError;
            }
            return sessionsResult([...rows], 1);
          },
        }
      : {}),
  });
  await mounted.sessions.refresh({ agentId: "main", force: true });
  const pane = mounted.mount(key);
  await refreshPane(pane);
  const state = pane.state;
  const selected = () => selectedChatSessionRow(state);
  const owned = outcome === "current" || outcome === "unbound";
  expect(selected()).toBeUndefined();
  const first = switchChatSetting(state, { kind: "thinkingLevel", value: "high" });
  const latest = switchChatSetting(state, { kind: "thinkingLevel", value: "low" });
  try {
    expect(mounted.sessions.settingsPreview(key, "main")).toMatchObject({ thinkingLevel: "low" });
    await withSessionMutationOperations(() => undefined);
    expect(patch).toHaveBeenCalledOnce();
    if (unbound) {
      firstReply.reject(new Error("Synthetic superseded first rejection"));
    } else {
      if (outcome !== "failed readback") {
        rows.push(row);
      }
      firstReply.resolve(receipt);
    }
    await expect(first).resolves.toBe(!unbound);
    await Promise.race([dispatched.promise, latest]);
    expect(patch).toHaveBeenCalledTimes(2);
    if (unbound) {
      expect(patch.mock.calls[1]?.[1]).toEqual({ key, thinkingLevel: "low" });
      expect(state.chatError).toBeNull();
    } else {
      expect(patch.mock.calls[1]?.[1]).toMatchObject({
        key,
        thinkingLevel: "low",
        expectedSessionId: row.sessionId,
      });
    }
    if (outcome === "failed readback") {
      expect(failedReads).toBeGreaterThan(0);
      expect(selected()).toBeUndefined();
      expect(mounted.sessions.state.error).toBe(readbackError.message);
      expect(state.sessionsError).toBe(readbackError.message);
      latestReply.resolve({
        ...receipt,
        entry: { ...receipt.entry, thinkingLevel: "low", updatedAt: 3 },
      });
      await expect(latest).resolves.toBe(true);
      expect(mounted.sessions.state.error).toBe(readbackError.message);
      expect(state).toMatchObject({
        sessionsError: readbackError.message,
        chatError: null,
        lastError: null,
      });
      return;
    }
    if (unboundConfirmed) {
      rows.push(row);
      await mounted.sessions.refresh({ agentId: "main", force: true });
      expect(selected()).toMatchObject({ sessionId: row.sessionId, thinkingLevel: "high" });
      latestReply.resolve({
        ...receipt,
        entry: { ...receipt.entry, thinkingLevel: "low", updatedAt: 3 },
      });
      await expect(latest).resolves.toBe(true);
      expect(failedReads).toBeGreaterThan(0);
      expect(selected()).toMatchObject({ sessionId: row.sessionId, thinkingLevel: "low" });
      expect(state.sessionsError).toBe(readbackError.message);
      expect(state.chatError).toBeNull();
      acknowledged = false;
      await mounted.sessions.refresh({ agentId: "main", force: true });
      expect(selected()).toMatchObject({ sessionId: row.sessionId, thinkingLevel: "low" });
      return;
    }
    if (!unbound) {
      expect(selected()).toMatchObject({ sessionId: row.sessionId, thinkingLevel: "low" });
    }
    if (outcome === "replacement") {
      rows[0] = { ...row, sessionId: "replacement-session", updatedAt: 3 };
      await mounted.sessions.refresh({ agentId: "main", force: true });
    } else if (outcome === "same-client reconnect") {
      const snapshot = mounted.context.gateway.snapshot;
      pane.applyGatewaySnapshot({ ...snapshot, phase: "reconnecting", hello: null });
      pane.applyGatewaySnapshot(snapshot);
    }
    if (!owned) {
      state.lastError = state.chatError = "Synthetic current owner error";
    }
    latestReply.reject(new Error("Synthetic latest acknowledged-target rejection"));
    await expect(latest).resolves.toBe(false);
    expect(state.chatError).toContain(
      owned ? "Synthetic latest acknowledged-target rejection" : "Synthetic current owner error",
    );
    expect(state.lastError).toBe(state.chatError);
    if (outcome === "current") {
      expect(selected()).toMatchObject({ sessionId: row.sessionId, thinkingLevel: "high" });
    }
  } finally {
    firstReply.resolve(receipt);
    latestReply.resolve(receipt);
    await Promise.allSettled([first, latest]);
    await vi.dynamicImportSettled();
  }
});
