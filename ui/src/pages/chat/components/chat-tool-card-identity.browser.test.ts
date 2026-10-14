import { html, nothing, render } from "lit";
import { afterEach, describe, expect, it } from "vitest";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { renderGroupedMessage } from "./chat-message-bubble.ts";
import { prepareChatMessageRender } from "./chat-message-markdown.ts";
import { settleToolBridges } from "./chat-tool-render.test-support.ts";

const containers: HTMLElement[] = [];
afterEach(() => {
  for (const container of containers.splice(0)) {
    render(nothing, container);
    container.remove();
  }
  window.getSelection()?.removeAllRanges();
});

function fixture(mode: "inline" | "standalone") {
  const rows = ["a", "b"].map((suffix) => {
    const output = `Applied ${suffix}`;
    const args = JSON.stringify({
      changes: [
        { path: `src/${suffix}.ts`, kind: { type: "update" }, diff: "@@ -1 +1 @@\n-old\n+new\n" },
      ],
    });
    return {
      key: `message:${suffix}`,
      output,
      message: {
        role: "assistant",
        timestamp: 1_700_000_000_000,
        ...(mode === "standalone" ? { toolCallId: "shared-call", toolName: "apply_patch" } : {}),
        content: [
          ...(mode === "standalone" ? [{ type: "text", text: output }] : []),
          { type: "toolcall", id: "shared-call", name: "apply_patch", arguments: args },
          { type: "toolresult", id: "shared-call", name: "apply_patch", text: output },
        ],
      },
    };
  });
  const container = document.body.appendChild(document.createElement("div"));
  containers.push(container);
  const toggledKeys: string[] = [];
  const expansion = new Map<string, boolean>();
  for (const row of rows) {
    expansion.set(`${row.key}:toolcard:0`, true);
    expansion.set(`toolmsg:${row.key}`, true);
  }
  const draw = () =>
    render(
      html`${rows.map((row) =>
        renderGroupedMessage(prepareChatMessageRender(row.message), row.key, {
          isStreaming: false,
          showReasoning: false,
          showToolCalls: true,
          isToolExpanded: (key) => expansion.get(key) ?? false,
          isToolMessageExpanded: (key) => expansion.get(key),
          onToggleToolExpanded: toggle,
          onToggleToolMessageExpanded: toggle,
        }),
      )}`,
      container,
    );
  function toggle(key: string) {
    toggledKeys.push(key);
    expansion.set(key, !expansion.get(key));
    draw();
  }
  return { rows, container, draw, toggledKeys };
}

describe
  .skipIf(navigator.userAgent.toLowerCase().includes("jsdom"))
  .each(["inline", "standalone"] as const)("%s tool message disclosures", (mode) => {
  it("preserves message-scoped IDs and independent Raw tabs for reused call IDs", async () => {
    const { rows, container, draw, toggledKeys } = fixture(mode);
    draw();
    await settleToolBridges(container);
    const bubbles = Array.from(container.querySelectorAll<HTMLElement>(".chat-bubble"));
    expect(bubbles.map((bubble) => bubble.dataset.messageId)).toEqual(rows.map((row) => row.key));
    expect(container.querySelectorAll(".chat-tools-inline")).toHaveLength(
      mode === "inline" ? 2 : 0,
    );
    expect(container.querySelectorAll(".chat-tool-card__modes")).toHaveLength(2);
    const ids = Array.from(
      container.querySelectorAll('[role="tab"], [role="tabpanel"]'),
      (element) => element.id,
    );
    expect(ids).toEqual(
      rows.flatMap(({ key }) =>
        ["diff-tab", "raw-tab", "diff-panel", "raw-panel"].map(
          (suffix) => `${key}:shared-call-${suffix}`,
        ),
      ),
    );
    expect(new Set(ids).size).toBe(8);

    await waitForSolid(() => {
      for (const bubble of bubbles) {
        for (const name of ["diff", "raw"]) {
          const tab = bubble.querySelector(`[role="tab"][data-tab-value="${name}"]`)!;
          const panel = bubble.querySelector(`[role="tabpanel"][aria-labelledby$="-${name}-tab"]`)!;
          expect(tab.getAttribute("aria-controls")).toBe(panel.id);
          expect(panel.getAttribute("aria-labelledby")).toBe(tab.id);
        }
      }
    });

    const toggleSelector =
      mode === "inline" ? ".chat-tool-row__toggle" : "button.chat-tool-msg-summary";
    const disclosureKey =
      mode === "inline" ? `${rows[0]!.key}:toolcard:0` : `toolmsg:${rows[0]!.key}`;
    bubbles[0]!.querySelector<HTMLButtonElement>(toggleSelector)!.click();
    await settleToolBridges(container);
    expect(toggledKeys).toEqual([disclosureKey]);
    expect(bubbles[0]!.querySelector(".chat-tool-card__modes")).toBeNull();
    expect(bubbles[1]!.querySelector(".chat-tool-card__modes")).not.toBeNull();
    bubbles[0]!.querySelector<HTMLButtonElement>(toggleSelector)!.click();
    await settleToolBridges(container);
    expect(toggledKeys).toEqual([disclosureKey, disclosureKey]);
    bubbles[0]!.querySelector<HTMLButtonElement>('[role="tab"][data-tab-value="raw"]')!.click();
    await waitForSolid(() => {
      expect(
        bubbles[0]!.querySelector<HTMLElement>('[role="tabpanel"][aria-labelledby$="-raw-tab"]')!
          .hidden,
      ).toBe(false);
      expect(
        bubbles[0]!.querySelector<HTMLElement>('[role="tabpanel"][aria-labelledby$="-diff-tab"]')!
          .hidden,
      ).toBe(true);
      expect(
        bubbles[1]!.querySelector<HTMLElement>('[role="tabpanel"][aria-labelledby$="-diff-tab"]')!
          .hidden,
      ).toBe(false);
      expect(
        bubbles[1]!.querySelector<HTMLElement>('[role="tabpanel"][aria-labelledby$="-raw-tab"]')!
          .hidden,
      ).toBe(true);
    });
    expect(
      bubbles.map(
        (bubble) =>
          bubble.querySelector('[role="tabpanel"][aria-labelledby$="-raw-tab"] code')!.textContent,
      ),
    ).toEqual(rows.map((row) => row.output));
  });
});
