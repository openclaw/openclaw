/* @vitest-environment jsdom */

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewaySessionRow } from "../../api/types.ts";
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

it.each(["confirmed", "rejected"] as const)(
  "keeps queued failure publication with latest intent (%s)",
  async (latestOutcome) => {
    const initial: GatewaySessionRow = {
      key: "agent:main:settings-error-owner",
      agentId: "main",
      sessionId: "settings-error-session",
      kind: "direct",
      updatedAt: 1,
      thinkingLevel: "high",
      fastMode: false,
      effectiveFastMode: false,
      contextWindow: "64k",
    };
    const rows = [initial];
    const firstReply = createDeferred<unknown>();
    const latestReply = createDeferred<unknown>();
    const latestDispatched = createDeferred();
    const patch = vi.fn<GatewayRequestHandler>(() => {
      if (patch.mock.calls.length === 1) {
        return firstReply.promise;
      }
      expect(patch.mock.calls.length).toBe(2);
      latestDispatched.resolve();
      return latestReply.promise;
    });
    const { sessions, mount } = createMountedPanes(rows, "main", undefined, {
      "sessions.patch": patch,
    });
    let first: Promise<boolean> | undefined;
    let latest: Promise<boolean> | undefined;
    try {
      await sessions.refresh({ agentId: "main", force: true });
      const pane = mount(initial.key);
      await refreshPane(pane);
      first = switchChatSetting(pane.state, { kind: "thinkingLevel", value: "off" });
      latest = switchChatSetting(pane.state, { kind: "thinkingLevel", value: "low" });
      expect(patch).toHaveBeenCalledOnce();
      expect(selectedChatSessionRow(pane.state)).toMatchObject({ thinkingLevel: "low" });

      firstReply.reject(new Error("Synthetic superseded settings rejection"));
      await expect(first).resolves.toBe(false);
      await Promise.race([latestDispatched.promise, latest]);
      expect(patch).toHaveBeenCalledTimes(2);
      // The latest choice is already visible and its RPC is still held. The older
      // failure must not describe that choice as failed, even transiently.
      expect.soft(pane.state.chatError).toBeNull();
      expect.soft(pane.state.lastError).toBeNull();
      expect(selectedChatSessionRow(pane.state)).toMatchObject({ thinkingLevel: "low" });

      if (latestOutcome === "rejected") {
        latestReply.reject(new Error("Synthetic latest settings rejection"));
      } else {
        rows[0] = { ...initial, thinkingLevel: "low", updatedAt: 3 };
        latestReply.resolve({ ok: true, key: initial.key, path: "", entry: rows[0] });
      }
      await expect(latest).resolves.toBe(latestOutcome === "confirmed");
      if (latestOutcome === "confirmed") {
        expect(pane.state.chatError).toBeNull();
        expect(pane.state.lastError).toBeNull();
        expect(selectedChatSessionRow(pane.state)).toMatchObject({ thinkingLevel: "low" });
      } else {
        expect(pane.state.chatError).toContain("Synthetic latest settings rejection");
        expect(pane.state.lastError).toBe(pane.state.chatError);
        expect(selectedChatSessionRow(pane.state)).toMatchObject(initial);
      }
    } finally {
      firstReply.resolve({ ok: true, key: initial.key, path: "", entry: initial });
      latestReply.resolve({ ok: true, key: initial.key, path: "", entry: rows[0] });
      await Promise.allSettled([first, latest]);
      await vi.dynamicImportSettled();
    }
  },
);
