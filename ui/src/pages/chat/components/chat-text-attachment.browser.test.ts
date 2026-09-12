import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import "../../../styles.css";
import "../../../styles/chat.ts";
import "../../../styles/chat/side-panel.css";
import type { SidebarContent } from "./chat-sidebar-content-types.ts";
import "./chat-sidebar.ts";

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe.runIf("__vitest_browser__" in globalThis)("Markdown attachment controls", () => {
  it("initializes overflow and disclosure after a deferred body without a parent render", async () => {
    const response = createDeferred<Response>();
    const fetchMock = vi.fn<typeof fetch>().mockReturnValue(response.promise);
    vi.stubGlobal("fetch", fetchMock);
    const container = document.createElement("div");
    container.className = "side-panel__panel";
    container.style.cssText = "display:flex;width:480px;height:600px;";
    const panel = document.createElement("openclaw-chat-detail-panel") as HTMLElement & {
      content: SidebarContent;
      updateComplete: Promise<unknown>;
    };
    panel.className = "chat-sidebar";
    panel.content = {
      kind: "attachment",
      title: "notes.md",
      mimeType: "text/markdown",
      src: "/notes.md",
    };
    container.append(panel);
    document.body.append(container);
    await panel.updateComplete;
    await expect.poll(() => fetchMock.mock.calls.length).toBe(1);
    expect(panel.querySelector(".code-block-wrapper")).toBeNull();

    const text = [
      "```ts",
      `const longLine = "${"notes ".repeat(80)}";`,
      ...Array(20).fill("// another line"),
      "```",
    ].join("\n");
    response.resolve(new Response(text));
    await expect
      .poll(() => panel.querySelector(".code-block-wrapper.has-horizontal-overflow"))
      .not.toBeNull();
    const viewport = expectDefined(
      panel.querySelector<HTMLElement>(".code-block-viewport"),
      "Code viewport",
    );
    const expand = expectDefined(
      panel.querySelector<HTMLButtonElement>(".code-block-expand"),
      "Expand control",
    );
    const wrap = expectDefined(
      panel.querySelector<HTMLButtonElement>(".code-block-wrap"),
      "Wrap control",
    );
    expect(viewport.id).not.toBe("");
    expect(expand.getAttribute("aria-controls")).toBe(viewport.id);
    expand.click();
    expect(expand.getAttribute("aria-expanded")).toBe("true");
    expect(getComputedStyle(wrap).display).not.toBe("none");
    wrap.click();
    expect(wrap.getAttribute("aria-pressed")).toBe("true");
    expect(panel.querySelector(".code-block-wrapper.is-wrapped")).not.toBeNull();
  });
});
