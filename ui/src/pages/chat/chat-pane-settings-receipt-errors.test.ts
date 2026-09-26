/* @vitest-environment jsdom */

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewaySessionRow, SessionsPatchResult } from "../../api/types.ts";
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

it.each(["current", "replacement", "same-client reconnect", "failed readback"] as const)(
  "preserves an ACK-adopted target and publishes only owned failures (%s)",
  async (outcome) => {
    const key = "agent:main:settings-materialization-failure";
    const materialized: GatewaySessionRow = {
      key,
      agentId: "main",
      sessionId: "acknowledged-session",
      kind: "direct",
      updatedAt: 2,
      thinkingLevel: "high",
    };
    const rows: GatewaySessionRow[] = [];
    const firstReply = createDeferred<SessionsPatchResult>();
    const latestReply = createDeferred<SessionsPatchResult>();
    const latestDispatched = createDeferred();
    const readbackError = new Error("Synthetic roster read failure after settings ACK");
    let acknowledged = false;
    let failedReads = 0;
    const patch = vi.fn<GatewayRequestHandler>((_method, raw) => {
      if (patch.mock.calls.length === 1) {
        return firstReply.promise.then((result) => {
          acknowledged = true;
          return result;
        });
      }
      expect(raw).toMatchObject({
        key,
        thinkingLevel: "low",
        expectedSessionId: materialized.sessionId,
      });
      latestDispatched.resolve();
      return latestReply.promise;
    });
    const { sessions, mount, context } = createMountedPanes(rows, "main", undefined, {
      "sessions.patch": patch,
      ...(outcome === "failed readback"
        ? {
            "sessions.list": () => {
              if (acknowledged) {
                failedReads += 1;
                throw readbackError;
              }
              return sessionsResult([...rows], 1);
            },
          }
        : {}),
    });
    let first: Promise<boolean> | undefined;
    let latest: Promise<boolean> | undefined;
    const receipt = {
      ok: true,
      key,
      path: "",
      entry: { sessionId: "acknowledged-session", updatedAt: 2, thinkingLevel: "high" },
    } satisfies SessionsPatchResult;
    try {
      await sessions.refresh({ agentId: "main", force: true });
      const pane = mount(key);
      await refreshPane(pane);
      expect(selectedChatSessionRow(pane.state)).toBeUndefined();
      first = switchChatThinkingLevel(pane.state, "high");
      latest = switchChatThinkingLevel(pane.state, "low");
      expect(patch).toHaveBeenCalledOnce();
      if (outcome !== "failed readback") {
        rows.push(materialized);
      }
      firstReply.resolve(receipt);
      await expect(first).resolves.toBe(true);
      await Promise.race([latestDispatched.promise, latest]);
      expect(patch).toHaveBeenCalledTimes(2);
      if (outcome === "failed readback") {
        expect(failedReads).toBeGreaterThan(0);
        expect(selectedChatSessionRow(pane.state)).toBeUndefined();
        expect(sessions.state.error).toBe(readbackError.message);
        expect(pane.state.sessionsError).toBe(readbackError.message);
        // The roster error cannot turn an acknowledged write into a failed setting.
        latestReply.resolve({
          ...receipt,
          entry: { ...receipt.entry, thinkingLevel: "low", updatedAt: 3 },
        });
        await expect(latest).resolves.toBe(true);
        expect(sessions.state.error).toBe(readbackError.message);
        expect(pane.state.sessionsError).toBe(readbackError.message);
        expect(pane.state.chatError).toBeNull();
        expect(pane.state.lastError).toBeNull();
        return;
      }
      expect(selectedChatSessionRow(pane.state)).toMatchObject({
        sessionId: materialized.sessionId,
        thinkingLevel: "low",
      });
      if (outcome === "replacement") {
        rows[0] = { ...materialized, sessionId: "replacement-session", updatedAt: 3 };
        await sessions.refresh({ agentId: "main", force: true });
      } else if (outcome === "same-client reconnect") {
        const snapshot = context.gateway.snapshot;
        pane.applyGatewaySnapshot({ ...snapshot, phase: "reconnecting", hello: null });
        pane.applyGatewaySnapshot(snapshot);
      }
      if (outcome !== "current") {
        pane.state.chatError = "Synthetic current owner error";
        pane.state.lastError = pane.state.chatError;
      }
      latestReply.reject(new Error("Synthetic latest acknowledged-target rejection"));
      await expect(latest).resolves.toBe(false);
      expect(pane.state.chatError).toContain(
        outcome === "current"
          ? "Synthetic latest acknowledged-target rejection"
          : "Synthetic current owner error",
      );
      expect(pane.state.lastError).toBe(pane.state.chatError);
      if (outcome === "current") {
        expect(selectedChatSessionRow(pane.state)).toMatchObject({
          sessionId: materialized.sessionId,
          thinkingLevel: "high",
        });
      }
    } finally {
      firstReply.resolve(receipt);
      latestReply.resolve(receipt);
      await Promise.allSettled([first, latest]);
      await vi.dynamicImportSettled();
    }
  },
);

it("continues an unbound settings tail after predecessor rejection without inventing materialization", async () => {
  const key = "agent:main:settings-unbound-rejection";
  const firstReply = createDeferred<unknown>();
  const latestReply = createDeferred<unknown>();
  const latestDispatched = createDeferred();
  const patch = vi.fn<GatewayRequestHandler>(() => {
    if (patch.mock.calls.length === 1) {
      return firstReply.promise;
    }
    latestDispatched.resolve();
    return latestReply.promise;
  });
  const { sessions, mount } = createMountedPanes([], "main", undefined, {
    "sessions.patch": patch,
  });
  let first: Promise<boolean> | undefined;
  let latest: Promise<boolean> | undefined;
  try {
    await sessions.refresh({ agentId: "main", force: true });
    const pane = mount(key);
    await refreshPane(pane);
    first = switchChatThinkingLevel(pane.state, "high");
    latest = switchChatThinkingLevel(pane.state, "low");
    firstReply.reject(new Error("Synthetic superseded first rejection"));
    await expect(first).resolves.toBe(false);
    await Promise.race([latestDispatched.promise, latest]);
    expect(patch).toHaveBeenCalledTimes(2);
    expect(patch.mock.calls[1]?.[1]).toEqual({ key, thinkingLevel: "low" });
    expect(pane.state.chatError).toBeNull();
    latestReply.reject(new Error("Synthetic latest unbound rejection"));
    await expect(latest).resolves.toBe(false);
    expect(pane.state.chatError).toContain("Synthetic latest unbound rejection");
  } finally {
    firstReply.resolve({});
    latestReply.resolve({});
    await Promise.allSettled([first, latest]);
    await vi.dynamicImportSettled();
  }
});
