import { createComponent, createSignal } from "solid-js";
import { afterEach, expect, it } from "vitest";
import { cleanupSolid, mountSolid } from "../../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { GroupedMessage } from "./chat-message-bubble-view.tsx";
import { prepareChatMessageRender } from "./chat-message-markdown-view.tsx";
import { settleToolBridges } from "./chat-tool-render.test-support.ts";

afterEach(() => {
  cleanupSolid();
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
  let refresh: () => void;
  const toggledKeys: string[] = [];
  const expansion = new Map<string, boolean>();
  for (const row of rows) {
    expansion.set(`${row.key}:toolcard:0`, true);
    expansion.set(`toolmsg:${row.key}`, true);
  }
  const { container } = mountSolid(() => {
    const [revision, setRevision] = createSignal(0);
    refresh = () => setRevision((value) => value + 1);
    return rows.map((row) =>
      createComponent(GroupedMessage, {
        preparation: prepareChatMessageRender(row.message),
        messageKey: row.key,
        get options() {
          revision();
          return {
            isStreaming: false,
            showReasoning: false,
            showToolCalls: true,
            isToolExpanded: (key: string) => expansion.get(key) ?? false,
            isToolMessageExpanded: (key: string) => expansion.get(key),
            onToggleToolExpanded: toggle,
            onToggleToolMessageExpanded: toggle,
          };
        },
      }),
    );
  });
  function toggle(key: string) {
    toggledKeys.push(key);
    expansion.set(key, !expansion.get(key));
    refresh();
    flush();
  }
  return { rows, container, toggledKeys };
}

const panel = (bubble: HTMLElement, name: string) =>
  bubble.querySelector<HTMLElement>(`[role="tabpanel"][aria-labelledby$="-${name}-tab"]`)!;

it
  .skipIf(navigator.userAgent.toLowerCase().includes("jsdom"))
  .each(["inline", "standalone"] as const)(
  "preserves %s message IDs and independent Raw tabs for reused call IDs",
  async (mode) => {
    const { rows, container, toggledKeys } = fixture(mode);
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
          const body = panel(bubble, name);
          expect(tab.getAttribute("aria-controls")).toBe(body.id);
          expect(body.getAttribute("aria-labelledby")).toBe(tab.id);
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
        bubbles.map((bubble) => [panel(bubble, "diff").hidden, panel(bubble, "raw").hidden]),
      ).toEqual([
        [true, false],
        [false, true],
      ]);
    });
    expect(panel(bubbles[0]!, "raw").querySelector("code")!.textContent).toBe(rows[0]!.output);
    bubbles[1]!.querySelector<HTMLButtonElement>('[role="tab"][data-tab-value="raw"]')!.click();
    await waitForSolid(() => {
      expect(bubbles.map((bubble) => panel(bubble, "raw").hidden)).toEqual([false, false]);
      expect(
        bubbles.map((bubble) => panel(bubble, "raw").querySelector("code")!.textContent),
      ).toEqual(rows.map((row) => row.output));
    });
  },
);
