import { expect, it } from "vitest";
import type { ControlUiLinkReaderDocument } from "../../../src/shared/control-ui-link-reader.js";
import {
  readerUrl as url,
  readerFile,
  readerComment,
  withLinkReader,
} from "./link-reader.test-support.ts";

it("keeps check navigation, refresh, and long content usable in a narrow native reader", async () => {
  const detail: ControlUiLinkReaderDocument = {
    url,
    title: "Review a long-running build beside the conversation",
    body: "Description\n\n".repeat(30),
    checks: {
      state: "pending",
      summary: "1 passed · 1 in progress",
      total: 2,
      items: [
        { name: "Lint", state: "success", url: "https://forge.example/runs/1" },
        { name: "Integration tests", state: "pending" },
      ],
      commit: "abcdef0123456789",
    },
    files: [readerFile("src/very-long-component-name/".repeat(5) + "index.ts", 2)],
    comments: [readerComment("Review discussion.\n\n".repeat(100), "comment-1")],
  };
  await withLinkReader(
    {
      featureMethods: ["chat.startup", "chat.metadata", "forge.detail", "forge.preview"],
      methodResponses: { "forge.detail": detail },
    },
    async ({ page, gateway, panel, content, button }) => {
      await panel.getByText("Checks in progress", { exact: true }).waitFor();
      await button("Checks 2").focus();
      await page.keyboard.press("Enter");
      expect(
        await panel.locator(".lr-checks").evaluate((node) => (node as HTMLDetailsElement).open),
      ).toBe(true);
      await panel.getByText("Integration tests", { exact: true }).waitFor();
      expect(await panel.locator(".lr-check-copy a").getAttribute("href")).toBe(
        "https://forge.example/runs/1",
      );
      await button("Files 1").click();
      expect(await content.evaluate((node) => node.scrollTop)).toBeGreaterThan(100);
      const navBounds = await content.evaluate((node) => ({
        viewport: node.getBoundingClientRect().top,
        buttons: [...node.querySelectorAll(".lr-section-nav button")].map(
          (control) => control.getBoundingClientRect().top,
        ),
      }));
      expect(navBounds.buttons.every((top) => top >= navBounds.viewport)).toBe(true);
      await panel.locator(".lr-files summary").click();
      await panel.locator(".lr-files .lr-diff").waitFor();
      await button("Discussion 1").click();
      expect(await panel.locator(".lr-comments").evaluate((node) => node.matches(":focus"))).toBe(
        true,
      );
      await panel.locator(".lr-url").fill(url + "#comment-1");
      await panel.locator(".lr-url").press("Enter");
      await expect
        .poll(async () =>
          content.evaluate((node) => {
            const comment = node.querySelector(".lr-comment")!.getBoundingClientRect();
            const nav = node.querySelector(".lr-section-nav")!.getBoundingClientRect();
            return comment.top >= nav.bottom;
          }),
        )
        .toBe(true);
      for (const state of ["failure", "success", "unavailable", "neutral"] as const) {
        const empty = state === "unavailable" || state === "neutral";
        const checks: NonNullable<ControlUiLinkReaderDocument["checks"]> = {
          state,
          summary:
            state === "unavailable"
              ? "Checks could not load"
              : state === "neutral"
                ? "No checks reported"
                : "Updated checks",
          total: state === "neutral" ? 0 : 1,
          items: empty ? [] : [{ name: "Updated build", state }],
        };
        await gateway.setMethodResponse("forge.detail", { ...detail, checks });
        await button("Refresh item").click();
        await panel.locator(".lr-checks--" + state).waitFor({ state: "attached" });
        expect(await panel.locator(".lr-checks-meter").count()).toBe(empty ? 0 : 1);
      }
      expect(
        (await gateway.getRequests("forge.detail"))
          .slice(1)
          .every((request) => (request.params as { refresh?: boolean }).refresh === true),
      ).toBe(true);
      await page.setViewportSize({ width: 390, height: 844 });
      await button("Files 1").click();
      expect(await content.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
      const mobileNav = await panel.locator(".lr-section-nav").evaluate((node) => ({
        top: node.getBoundingClientRect().top,
        first: node.firstElementChild!.getBoundingClientRect().top,
        last: node.lastElementChild!.getBoundingClientRect().top,
      }));
      expect(mobileNav.first).toBe(mobileNav.last);
      expect(mobileNav.first).toBeGreaterThanOrEqual(mobileNav.top);
    },
  );
});
