import { expect, it, vi } from "vitest";
import "../../../styles.css";
import "../../../styles/chat.ts";
import "../../../styles/chat/side-panel.css";
import type { SidebarContent } from "./chat-sidebar-content-types.ts";
import "./chat-sidebar.ts";

const browserMode = "__vitest_browser__" in globalThis;

type DetailPanel = HTMLElement & {
  content: SidebarContent;
  updateComplete: Promise<unknown>;
};

it.skipIf(!browserMode)("renders a PDF in a bounded native reader surface", async () => {
  vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response("%PDF-1.7\n")));
  const container = document.createElement("div");
  container.className = "side-panel__panel";
  container.style.cssText = "display:flex;width:480px;height:640px;";
  const panel = document.createElement("openclaw-chat-detail-panel") as DetailPanel;
  panel.className = "chat-sidebar";
  panel.content = {
    kind: "attachment",
    attachmentKind: "document",
    title: "brief.pdf",
    src: "/__openclaw__/assistant-media?mediaTicket=pdf-preview",
    mimeType: "application/pdf",
    sizeBytes: 8_231,
  };
  container.append(panel);
  document.body.append(container);

  try {
    await panel.updateComplete;
    await expect.poll(() => panel.querySelector("iframe")).not.toBeNull();
    const frame = panel.querySelector<HTMLIFrameElement>("iframe")!;
    const surface = panel.querySelector<HTMLElement>(".sidebar-pdf-preview__surface")!;
    expect(frame.getAttribute("src")).toMatch(/^blob:/);
    expect(getComputedStyle(frame).display).toBe("block");
    expect(surface.getBoundingClientRect().height).toBeGreaterThan(0);
    expect(panel.querySelector("object")).toBeNull();
  } finally {
    container.remove();
    vi.unstubAllGlobals();
  }
});
