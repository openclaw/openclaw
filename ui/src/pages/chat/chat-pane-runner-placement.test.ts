/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewaySessionRow } from "../../api/types.ts";
import type { ChatHistoryResult } from "./chat-history-snapshot.ts";
import { getChatHistoryLoadState } from "./chat-history-state.ts";
import { loadChatHistory } from "./chat-history.ts";
import { createMountedPanes } from "./chat-pane-mounted.test-support.ts";
import { offlineDeviceSession } from "./chat-pane.test-support.ts";
import { selectedChatSessionRow } from "./chat-state-route.ts";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
} from "./components/chat-transcript.test-support.ts";

beforeEach(installTranscriptDomMocks);
afterEach(resetTranscriptTestDom);

describe("mounted runner placement freshness", () => {
  it.each(["overlapping invalidation", "transient failure"] as const)(
    "refreshes runner placement while startup is held after %s",
    async (cause) => {
      const offline = { ...offlineDeviceSession(), agentId: "main", sessionId: "runner-session" };
      const available: GatewaySessionRow = {
        ...offline,
        placement: {
          ...offline.placement,
          runner: { kind: "device", status: "available" },
        },
      };
      const startup = createDeferred<ChatHistoryResult>();
      const first = createDeferred<{ session: GatewaySessionRow }>();
      const second = createDeferred<{ session: GatewaySessionRow }>();
      const secondIssued = createDeferred();
      const offlinePublished = createDeferred();
      let holding = false;
      let descriptorReads = 0;
      let startupReads = 0;
      const { sessions, mount, emitGatewayEvent } = createMountedPanes(
        [available],
        "main",
        undefined,
        {
          "chat.startup": () => {
            startupReads += 1;
            return startup.promise;
          },
          "sessions.describe": () => {
            if (!holding) {
              return { session: available };
            }
            descriptorReads += 1;
            if (descriptorReads === 1) {
              return first.promise;
            }
            secondIssued.resolve();
            return second.promise;
          },
        },
      );
      const pane = mount(available.key);
      const observation = sessions.observeRow({ key: available.key, agentId: "main" }, (row) => {
        if (row?.placement?.state === "active" && row.placement.runner?.status === "offline") {
          offlinePublished.resolve();
        }
      });
      observation.captureReconcile()(available);
      const history = loadChatHistory(pane.state, { startup: true, deferBranches: true });
      const runnerStatus = () => {
        const placement = selectedChatSessionRow(pane.state)?.placement;
        return placement?.state === "active" ? placement.runner?.status : undefined;
      };
      try {
        await vi.dynamicImportSettled();
        expect(getChatHistoryLoadState(pane.state).phase).toBe("in-flight");
        expect(runnerStatus()).toBe("available");
        holding = true;

        emitGatewayEvent("sessions.changed", { reason: "runner-availability" });
        expect(descriptorReads).toBe(1);
        if (cause === "overlapping invalidation") {
          emitGatewayEvent("sessions.changed", { reason: "runner-availability" });
          expect(descriptorReads).toBe(1);
          first.resolve({ session: available });
        } else {
          first.reject(new Error("Descriptor temporarily unavailable"));
          await vi.dynamicImportSettled();
          expect(descriptorReads).toBe(1);
          expect(runnerStatus()).toBe("available");
          pane.applyGatewaySnapshot({
            ...pane.context.gateway.snapshot,
            selfUser: { id: "viewer", name: "Updated viewer" },
          });
          expect(descriptorReads).toBe(2);
        }
        await secondIssued.promise;
        expect(descriptorReads).toBe(2);
        second.resolve({ session: offline });
        await offlinePublished.promise;
        expect(runnerStatus()).toBe("offline");
        expect(getChatHistoryLoadState(pane.state).phase).toBe("in-flight");
        expect(startupReads).toBe(1);
      } finally {
        observation.dispose();
        first.resolve({ session: available });
        second.resolve({ session: offline });
        startup.resolve({ messages: [], sessionInfo: available, sessionId: available.sessionId });
        await history;
      }
    },
  );
});
