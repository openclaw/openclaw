import { render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { i18n } from "../../../i18n/index.ts";
import { renderCompactAttachmentCard } from "./chat-attachment-card.ts";

let container: HTMLDivElement;
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
});

afterEach(async () => {
  await userEvent.keyboard("{Escape}");
  document.body.replaceChildren();
});

describe("attachment card file actions", () => {
  it("preserves left-click preview without activating it from inner controls", async () => {
    const onExpand = vi.fn();
    render(
      renderCompactAttachmentCard({
        kind: "document",
        label: "report.pdf",
        onExpand,
        downloadHref: "#fixture-download",
      }),
      container,
    );
    const card = document.querySelector<HTMLElement>(".chat-assistant-attachment-card")!;
    card.style.cssText = "padding: 20px; width: 400px";
    await page.getByText("report.pdf", { exact: true }).click();
    expect(onExpand).toHaveBeenCalledTimes(1);
    await userEvent.click(card, { position: { x: 2, y: 2 } });
    expect(onExpand).toHaveBeenCalledTimes(2);
    await page.getByRole("button", { name: "Open report.pdf in the side panel" }).click();
    expect(onExpand).toHaveBeenCalledTimes(3);
    // Cancel navigation after the card handler runs, without masking bubbling behavior.
    container.addEventListener("click", (event) => event.preventDefault(), { once: true });
    await page.getByRole("link", { name: "Download report.pdf" }).click();
    expect(onExpand).toHaveBeenCalledTimes(3);
    page.getByRole("button", { name: "Open report.pdf in the side panel" }).element().focus();
    await userEvent.keyboard("{Enter}");
    await userEvent.keyboard(" ");
    expect(onExpand).toHaveBeenCalledTimes(5);
  });

  it("opens the existing preview from a card without a workspace reference", async () => {
    const onExpand = vi.fn();
    render(
      renderCompactAttachmentCard({ kind: "document", label: "report.pdf", onExpand }),
      container,
    );
    const card = document.querySelector<HTMLElement>(".chat-assistant-attachment-card")!;
    await userEvent.click(card, { button: "right" });
    const menu = page.getByRole("menu", { name: "Workspace file actions" });
    await expect
      .element(menu.getByRole("menuitem", { name: "Preview", exact: true }))
      .toBeVisible();
    expect(menu.getByRole("menuitem").elements()).toHaveLength(2);
    await menu.getByRole("menuitem", { name: "Preview", exact: true }).click();
    expect(onExpand).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(
      page.getByRole("button", { name: "Workspace file actions", exact: true }).element(),
    );
    await userEvent.keyboard("{Shift>}{F10}{/Shift}");
    await expect
      .element(menu.getByRole("menuitem", { name: "Preview", exact: true }))
      .toHaveFocus();
  });

  it.each([false, true])(
    "keeps pending downloads unavailable with a custom handler: %s",
    async (customHandler) => {
      const onFileAction = customHandler ? vi.fn() : undefined;
      render(
        renderCompactAttachmentCard({
          kind: "document",
          label: "report.pdf",
          downloadHref: "https://example.test/report.pdf",
          downloadPending: true,
          onFileAction,
        }),
        container,
      );
      const download = page.getByRole("link", { name: "Download report.pdf" });
      await expect.element(download).toHaveAttribute("aria-disabled", "true");
      expect(download.element().hasAttribute("href")).toBe(false);
      await userEvent.click(
        document.querySelector<HTMLElement>(".chat-assistant-attachment-card")!,
        { button: "right" },
      );
      const menu = page.getByRole("menu", { name: "Workspace file actions" });
      await expect.element(menu).toBeVisible();
      expect(
        menu.getByRole("menuitem", { name: "Download file", exact: true }).elements(),
      ).toHaveLength(0);
      if (onFileAction) {
        expect(onFileAction).not.toHaveBeenCalled();
      }
    },
  );

  it.each(["{Enter}", " "])(
    "opens file actions through a native menu button with %s",
    async (key) => {
      render(renderCompactAttachmentCard({ kind: "document", label: "report.txt" }), container);
      const trigger = page.getByRole("button", { name: "Workspace file actions", exact: true });
      expect(trigger.elements()).toHaveLength(1);
      await expect.element(trigger).toHaveAttribute("aria-haspopup", "menu");
      expect(document.querySelector<HTMLElement>(".chat-assistant-attachment-card")!.tabIndex).toBe(
        -1,
      );
      trigger.element().focus();
      await userEvent.keyboard(key);
      const menu = page.getByRole("menu", { name: "Workspace file actions" });
      await expect
        .element(menu.getByRole("menuitem", { name: "Copy filename", exact: true }))
        .toHaveFocus();
      await userEvent.keyboard("{Escape}");
      expect(document.activeElement).toBe(trigger.element());
    },
  );

  it("omits unsupported actions and unsafe download URLs", async () => {
    render(
      renderCompactAttachmentCard({
        kind: "document",
        label: "report.txt",
        downloadHref: "javascript:void(0)",
      }),
      container,
    );
    await userEvent.click(document.querySelector<HTMLElement>(".chat-assistant-attachment-card")!, {
      button: "right",
    });
    const menu = page.getByRole("menu", { name: "Workspace file actions" });
    expect(
      menu
        .getByRole("menuitem")
        .elements()
        .map((item) => item.textContent),
    ).toEqual(["Copy filename"]);
  });
});

const originalLocale = i18n.getLocale();
beforeEach(async () => {
  await i18n.setLocale("en");
});
afterEach(async () => {
  await i18n.setLocale(originalLocale);
});
