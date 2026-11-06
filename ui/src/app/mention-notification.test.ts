/* @vitest-environment jsdom */

import { expect, it, vi } from "vitest";
import type {
  MentionInboxItem,
  MentionsListResult,
} from "../../../packages/gateway-protocol/src/index.js";
import { flush } from "../test-helpers/solid-settle.ts";
import { showMentionNotification } from "./mention-notification.ts";
import { createMentionsCapability } from "./mentions.ts";
import { client, createGatewayHarness, type RequestFn } from "./overlays-access.test-support.ts";
import "../lib/toast-host.tsx";

it.each(["queued", "displayed"] as const)(
  "cancels only the %s card omitted by an accepted same-connection Inbox snapshot",
  async (presentation) => {
    const retained: MentionInboxItem = {
      id: "retained",
      senderProfileId: "alice",
      senderLabel: "Alice",
      sessionKey: "agent:main:retained",
      agentId: "main",
      sessionTitle: "Retained review",
      messageId: "message-retained",
      createdAt: 1_000,
      expiresAt: 60_000,
      excerpt: "Hey @Bob please review",
      excerptHighlight: { start: 4, end: 8 },
    };
    const removed: MentionInboxItem = {
      ...retained,
      id: "removed",
      sessionKey: "agent:main:removed",
      sessionTitle: "Removed review",
    };
    let snapshot: MentionsListResult = { gatewayInstanceId: "boot-a", revision: 0, items: [] };
    const request = vi.fn<RequestFn>(async () => snapshot);
    const harness = createGatewayHarness(client(request));
    harness.update({
      hello: {
        type: "hello-ok",
        protocol: 1,
        server: { bootId: "boot-a", connId: "connection-a" },
        auth: { role: "operator", scopes: ["operator.read"] },
        features: { methods: ["mentions.list", "mentions.dismiss"] },
      },
      selfUser: { id: "bob", identity: { type: "profile", id: "bob" }, name: "Bob" },
    });
    const context = { gateway: harness.gateway, basePath: "", navigate: vi.fn() };
    const capability = createMentionsCapability(harness.gateway, {
      onArrival: (item, signal) => showMentionNotification(context, item, signal),
    });
    const host = document.createElement("openclaw-toast-host");
    const settle = async () => {
      await host.updateComplete;
      await vi.dynamicImportSettled();
      flush();
    };
    const titles = () =>
      [...host.querySelectorAll(".app-toast__message")].map((element) => element.textContent);
    try {
      await capability.refresh();
      snapshot = { ...snapshot, revision: 1, items: [removed, retained] };
      harness.emitEvent("mentions.changed", { gatewayInstanceId: "boot-a", revision: 1 });
      await capability.refresh();
      if (presentation === "displayed") {
        document.body.append(host);
        await settle();
        expect(titles()).toEqual(["Alice · Retained review", "Alice · Removed review"]);
      }

      // A late older result cannot withdraw either notification.
      snapshot = { ...snapshot, revision: 0, items: [] };
      await capability.refresh();
      snapshot = { ...snapshot, revision: 2, items: [retained] };
      harness.emitEvent("mentions.changed", { gatewayInstanceId: "boot-a", revision: 2 });
      await capability.refresh();
      if (presentation === "queued") {
        document.body.append(host);
      }
      await settle();
      expect(titles()).toEqual(["Alice · Retained review"]);
      const description = host.querySelector(".app-toast__description");
      expect(description?.textContent).toBe("Hey @Bob please review");
      expect(description?.querySelector("mark.app-toast__mention")?.textContent).toBe("@Bob");
      expect(capability.snapshot.items).toEqual([retained]);
      expect(request.mock.calls.every(([method]) => method === "mentions.list")).toBe(true);
    } finally {
      capability.dispose();
      host.remove();
    }
  },
);
