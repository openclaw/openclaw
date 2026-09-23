import type WaTooltip from "@awesome.me/webawesome/dist/components/tooltip/tooltip.js";
import { render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installTitleTooltips } from "../../../components/tooltip-title.ts";
import { i18n } from "../../../i18n/index.ts";
import "../../../styles.css";
import "../../../styles/chat/startup-layout.css";
import "../../../styles/chat/split-view.css";
import { chatPaneHeaderSessionRow, mountChatPaneHeader } from "./chat-pane-header.test-support.ts";
import { renderChatSidebarEditorMenu } from "./chat-sidebar-editor-menu.ts";

describe.skipIf(typeof HTMLElement.prototype.checkVisibility !== "function")(
  "chat pane branch tooltip positioning",
  () => {
    const containers: HTMLElement[] = [];
    let dispose: () => void;
    let page: (typeof import("vitest/browser"))["page"];

    beforeEach(async () => {
      ({ page } = await import("vitest/browser"));
      await page.viewport(1200, 800);
      await i18n.setLocale("en");
      dispose = installTitleTooltips(document);
    });

    afterEach(() => {
      dispose();
      containers.splice(0).forEach((container) => container.remove());
    });

    it("keeps the owner name and assignment reachable before participant faces at narrow widths", async () => {
      const onAssignOwner = vi.fn();
      const { container } = mountChatPaneHeader(containers, {
        narrow: true,
        showOwnerChip: true,
        onAssignOwner,
        session: chatPaneHeaderSessionRow({
          owner: { actor: { type: "human", id: "gideon", label: "Gideon" } },
          participants: [{ identity: { type: "profile", id: "ada" }, label: "Ada" }],
          participantCount: 1,
        }),
      });
      container.style.width = "390px";
      await container.querySelector("openclaw-viewer-facepile")?.updateComplete;
      const owner = container.querySelector<HTMLButtonElement>(".chat-pane__owner")!;
      const header = container.querySelector<HTMLElement>(".chat-pane__header")!;
      expect(
        container.querySelector(".chat-pane__participants .viewer-facepile")?.checkVisibility(),
      ).toBe(false);
      expect(owner.checkVisibility()).toBe(true);
      expect(owner.textContent).toContain("Gideon");
      expect(owner.getBoundingClientRect().right).toBeLessThanOrEqual(
        header.getBoundingClientRect().right,
      );
      await page.elementLocator(owner).click();
      expect(onAssignOwner).toHaveBeenCalledOnce();
    });

    it.each(["idle", "busy", "editor"] as const)(
      "anchors the %s hint to its menu button",
      async (state) => {
        const busy = state === "busy";
        const editor = state === "editor";
        const onOpenEditor = vi.fn();
        const reason = "Branch switch is unavailable while the agent is working.";
        const { container, props } = mountChatPaneHeader(containers, {
          branchSwitchDisabledReason: busy ? reason : null,
          onClosePane: state === "idle" ? vi.fn() : undefined,
          branches: [
            { leafEntryId: "active", headline: "Current work", messageCount: 4, active: true },
            { leafEntryId: "other", headline: "Earlier idea", messageCount: 2, active: false },
          ],
        });
        if (editor) {
          render(
            renderChatSidebarEditorMenu({
              absolutePath: "/repo/example.ts",
              open: false,
              onOpenChange: () => undefined,
              onOpenEditor,
            }),
            container,
          );
        }
        container.style.cssText =
          state === "idle"
            ? "position: fixed; top: 80px; left: 80px; width: 1000px"
            : "position: fixed; top: 80px; left: 500px; width: 650px";
        const trigger = container.querySelector<HTMLButtonElement>(
          editor ? ".sidebar-file-view__action" : ".chat-pane__branches-trigger",
        )!;
        await page.elementLocator(trigger).hover();
        const tooltip = () =>
          [...document.querySelectorAll("openclaw-tooltip")]
            .map((element) => element.shadowRoot?.querySelector<WaTooltip>("wa-tooltip"))
            .find((element) => element?.open);
        await expect
          .poll(() => tooltip()?.textContent)
          .toContain(editor ? "Open in editor" : busy ? reason : "Session branches");
        await expect
          .poll(() => {
            const body = tooltip()?.shadowRoot?.querySelector<HTMLElement>('[part="body"]');
            if (!body) {
              return false;
            }
            const hint = body.getBoundingClientRect();
            const button = trigger.getBoundingClientRect();
            return (
              hint.width > 0 &&
              hint.left < button.right &&
              hint.right > button.left &&
              Math.min(Math.abs(hint.bottom - button.top), Math.abs(hint.top - button.bottom)) < 24
            );
          })
          .toBe(true);

        if (!busy) {
          await page.elementLocator(trigger).click();
          await expect.poll(() => tooltip()).toBeUndefined();
          await page.getByRole("menuitem", { name: editor ? "VS Code" : /Earlier idea/ }).click();
          expect(editor ? onOpenEditor : props.onBranchSelect).toHaveBeenCalledWith(
            editor ? "vscode" : "other",
          );
        }

        if (state === "idle") {
          const header = container.querySelector<HTMLElement>(".chat-pane__header")!;
          const close = container.querySelector<HTMLButtonElement>(".chat-pane__close-pane")!;
          for (const width of [320, 693]) {
            container.style.width = `${width}px`;
            expect(trigger.checkVisibility()).toBe(true);
            const bounds = header.getBoundingClientRect();
            const branchBounds = trigger.getBoundingClientRect();
            const closeBounds = close.getBoundingClientRect();
            expect(branchBounds.left).toBeGreaterThanOrEqual(bounds.left);
            expect(branchBounds.right).toBeLessThanOrEqual(closeBounds.left);
            expect(closeBounds.right).toBeLessThanOrEqual(bounds.right);
            expect(header.scrollWidth).toBeLessThanOrEqual(header.clientWidth);
            vi.mocked(props.onBranchSelect).mockClear();
            await page.elementLocator(trigger).click();
            await page.getByRole("menuitem", { name: /Earlier idea/ }).click();
            expect(props.onBranchSelect).toHaveBeenCalledExactlyOnceWith("other");
          }
          await page.elementLocator(close).click();
          expect(props.onClosePane).toHaveBeenCalledExactlyOnceWith("pane-1");
        }
      },
    );
  },
);
