/* @vitest-environment jsdom */
import { createSignal } from "solid-js";
import { describe, expect, it } from "vitest";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { flush } from "../../../test-helpers/solid-settle.ts";
import { StreamGroup, type StreamGroupPart } from "./chat-message-stream-view.tsx";

describe("native transcript streams", () => {
  it("retains the bubble and completed markdown while replacing stream snapshots and settling", () => {
    const first: StreamGroupPart = {
      kind: "stream",
      key: "stream:answer",
      startedAt: 1,
      isStreaming: true,
      text: "A completed paragraph.\n\nA growing",
      thinking: "",
    };
    const [parts, setParts] = createSignal<StreamGroupPart[]>([first]);
    const view = mountSolid(() => <StreamGroup parts={parts()} options={{}} />);
    flush();
    const bubble = view.container.querySelector(".chat-bubble");
    const completed = view.container.querySelector(".chat-text p");
    expect(completed?.textContent).toBe("A completed paragraph.");
    for (const [suffix, isStreaming] of [
      [" reply", true],
      [" reply that settled.", false],
    ] as const) {
      setParts([{ ...first, text: first.text + suffix, isStreaming }]);
      flush();
      expect(view.container.querySelector(".chat-bubble")).toBe(bubble);
      expect(view.container.querySelector(".chat-text p")).toBe(completed);
      expect(view.container.querySelector(".chat-text")?.textContent).toContain(
        "A growing" + suffix,
      );
    }
    expect(bubble?.classList.contains("streaming")).toBe(false);
  });
});
