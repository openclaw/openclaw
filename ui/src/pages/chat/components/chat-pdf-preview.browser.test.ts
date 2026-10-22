import { expect, it, vi } from "vitest";
import "../../../styles.css";
import "../../../styles/chat.ts";
import "../../../styles/chat/side-panel.css";
import { pdfFixture } from "../../../test-helpers/pdf-fixture.ts";
import type { SidebarContent } from "./chat-sidebar-content-types.ts";
import "./chat-detail-panel.tsx";

const browserMode = "__vitest_browser__" in globalThis;
type DetailPanel = HTMLElement & { content: SidebarContent; updateComplete: Promise<unknown> };

it.skipIf(!browserMode)(
  "fills the sidebar with an accessible PDF reader and preserves page selection across ticket renewal",
  async () => {
    const nativeFetch = fetch;
    const source = "/__openclaw__/assistant-media?mediaTicket=pdf-preview";
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>((input, init) =>
        typeof input === "string" && input.startsWith("/__openclaw__/assistant-media")
          ? Promise.resolve(new Response(pdfFixture()))
          : nativeFetch(input, init),
      ),
    );
    const container = document.createElement("div");
    container.className = "side-panel__panel";
    container.style.cssText = "display:flex;width:480px;height:640px;";
    // SAFETY: the registered detail-panel custom element exposes these public properties.
    const panel = document.createElement("openclaw-chat-detail-panel") as DetailPanel;
    panel.className = "chat-sidebar";
    const content: SidebarContent = {
      kind: "attachment",
      attachmentKind: "document",
      title: "brief.pdf",
      src: source,
      sourceIdentity: "pdf:brief",
      mimeType: "application/pdf",
    };
    panel.content = content;
    container.append(panel);
    document.body.append(container);
    try {
      await panel.updateComplete;
      await expect
        .poll(() => panel.querySelector(".textLayer")?.textContent)
        .toContain("Release checklist");
      const reader = panel.querySelector<HTMLElement>(".pdf-document")!;
      const surface = panel.querySelector<HTMLElement>(".sidebar-pdf-preview__surface")!;
      for (const edge of ["top", "right", "bottom", "left"] as const) {
        expect(reader.getBoundingClientRect()[edge]).toBeCloseTo(
          surface.getBoundingClientRect()[edge],
          0,
        );
      }
      panel.querySelector<HTMLButtonElement>('[aria-label="Next page"]')!.click();
      await expect
        .poll(() => panel.querySelector(".textLayer")?.textContent)
        .toContain("Confirm the rollback owner.");
      const canvas = panel.querySelector("canvas");
      panel.content = { ...content, src: source + "-renewed" };
      await panel.updateComplete;
      await expect.poll(() => panel.querySelector(".pdf-document")).toBe(reader);
      expect(panel.querySelector("canvas")).toBe(canvas);
      expect(panel.textContent).toContain("Page 2 of 2");
      expect(panel.querySelector("iframe")).toBeNull();
      expect(panel.querySelector("object")).toBeNull();
    } finally {
      container.remove();
      vi.unstubAllGlobals();
    }
  },
);
