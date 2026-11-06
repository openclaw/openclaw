// @vitest-environment jsdom
import { createComponent, createSignal } from "solid-js";
import { afterEach, expect, it } from "vitest";
import { cleanupSolid, mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import { createState } from "./chat-gateway.test-support.ts";
import { handleChatGatewayEvent } from "./chat-gateway.ts";
import { groupMessages } from "./chat-thread-grouping.ts";
import type { readChatInputDelivery } from "./chat-thread-items.ts";
import { ChatInputDeliveryStatus } from "./components/chat-input-delivery-status-view.tsx";
import { MessageGroup } from "./components/chat-message-group-view.tsx";

afterEach(cleanupSolid);

it("updates an accessible receipt in place and offers no unsafe retry action", () => {
  const [delivery, setDelivery] = createSignal<ReturnType<typeof readChatInputDelivery>>(null);
  const container = document.createElement("div");
  document.body.append(container);
  mountSolid(
    () =>
      createComponent(ChatInputDeliveryStatus, {
        get delivery() {
          return delivery();
        },
      }),
    { container },
  );
  expect(container.textContent).toBe("");
  setDelivery("unconfirmed");
  flush();
  expect(container.querySelector("[role=status]")?.textContent).toBe("Delivery unconfirmed");
  expect(container.querySelector("[role=status]")?.getAttribute("data-delivery")).toBe(
    "unconfirmed",
  );
  expect(container.querySelector("button")).toBeNull();
  setDelivery("not-steered");
  flush();
  expect(container.textContent).toBe("Not read by active run");
  setDelivery("read");
  flush();
  expect(container.textContent).toBe("Read");
  expect(container.querySelector("[role=status]")?.getAttribute("data-delivery")).toBe("read");
  expect(container.querySelector("[role=status]")?.getAttribute("aria-label")).toContain(
    "does not confirm that it followed the instruction",
  );
  setDelivery(null);
  flush();
  expect(container.querySelector("[role=status]")).toBeNull();
  container.remove();
});

it("keeps consecutive same-target steering receipts independently attributable", () => {
  const state = createState({
    chatRunId: "active",
    chatMessages: ["a", "b"].map((id, index) => ({
      role: "user",
      content: [{ type: "text", text: "Correction " + id }],
      timestamp: 1000 + index,
      __openclaw: { id, seq: index + 1, idempotencyKey: id + ":user", steerTargetRunId: "active" },
    })),
  });
  const [messages, setMessages] = createSignal(state.chatMessages);
  const group = () => {
    const groups = groupMessages(
      messages().map((message, index) => ({
        kind: "message" as const,
        key: "source-" + index,
        message,
      })),
      {},
    );
    expect(groups).toHaveLength(1);
    const grouped = groups[0];
    if (!grouped || grouped.kind !== "group") {
      throw new Error("Expected the real grouped steering messages");
    }
    expect(grouped.messages).toHaveLength(2);
    return grouped;
  };
  const container = document.createElement("div");
  document.body.append(container);
  mountSolid(
    () =>
      createComponent(MessageGroup, {
        get group() {
          return group();
        },
        options: {
          showReasoning: true,
          showToolCalls: true,
          assistantName: "OpenClaw",
          assistantAvatar: null,
        },
      }),
    { container },
  );
  const deliver = (runId: string, delivery: "read" | "unconfirmed", seq: number) => {
    handleChatGatewayEvent(state, {
      state: "input",
      runId,
      delivery,
      seq,
      sessionKey: "main",
      targetRunId: "active",
    });
    setMessages(state.chatMessages);
  };
  deliver("a", "unconfirmed", 1);
  deliver("b", "unconfirmed", 1);
  flush();
  expect(container.querySelectorAll(".chat-group")).toHaveLength(1);
  expect(container.querySelectorAll(".chat-input-delivery")).toHaveLength(2);
  deliver("a", "read", 2);
  flush();
  const receipts = container.querySelectorAll(".chat-input-delivery");
  expect(Array.from(receipts, (element) => element.textContent)).toEqual([
    "Read",
    "Delivery unconfirmed",
  ]);
  const sources = container.querySelectorAll(".chat-bubble");
  expect(Array.from(sources, (element) => element.textContent)).toEqual([
    expect.stringContaining("Correction a"),
    expect.stringContaining("Correction b"),
  ]);
  // Toolbars may sit between a source and its receipt; another source must not.
  expect(Array.from(container.querySelectorAll(".chat-bubble, .chat-input-delivery"))).toEqual([
    sources[0],
    receipts[0],
    sources[1],
    receipts[1],
  ]);
  for (const receipt of receipts) {
    expect(
      receipt.closest(".chat-message-actions-row, .chat-message-footer, .chat-group-footer"),
    ).not.toBeNull();
  }
  expect(container.querySelectorAll(".chat-group-messages > .chat-input-delivery")).toHaveLength(0);
  const firstReceipt = receipts[0];
  deliver("b", "read", 2);
  flush();
  expect(container.querySelectorAll(".chat-input-delivery")[0]).toBe(firstReceipt);
  expect(
    Array.from(
      container.querySelectorAll(".chat-input-delivery"),
      (element) => element.textContent,
    ),
  ).toEqual(["Read", "Read"]);
  expect(container.querySelectorAll(".chat-group")).toHaveLength(1);
  container.remove();
});
