import { chromium } from "playwright";
import { expect, it } from "vitest";
import type { ControlUiLinkReaderDocument } from "../../../src/shared/control-ui-link-reader.js";
import {
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";
import { TEST_LINK_READER } from "../test-helpers/link-reader.ts";

it("keeps check navigation, refresh, and long content usable in a narrow native reader", async () => {
  const server = await startControlUiE2eServer();
  const browser = await chromium.launch({
    executablePath: resolvePlaywrightChromiumExecutablePath(chromium.executablePath()),
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  try {
    const page = await context.newPage();
    const url = "https://forge.example/items/42";
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
      files: [
        {
          path: "src/very-long-component-name/".repeat(5) + "index.ts",
          additions: 2,
          deletions: 1,
          patch: "-old\n+new",
        },
      ],
      comments: [
        {
          id: "comment-1",
          url: url + "#comment-1",
          author: "reviewer",
          body: "Review discussion.\n\n".repeat(100),
        },
      ],
    };
    const gateway = await installMockGateway(page, {
      controlUiLinkReaders: [TEST_LINK_READER],
      featureMethods: ["chat.startup", "chat.metadata", "forge.detail", "forge.preview"],
      historyMessages: [
        { role: "assistant", content: [{ type: "text", text: "[Review build](" + url + ")" }] },
      ],
      methodResponses: { "forge.detail": detail },
    });
    await page.goto(server.baseUrl + "chat");
    await page.getByRole("link", { name: "Review build", exact: true }).click();
    const panel = page.locator("openclaw-link-reader-panel");
    const content = panel.locator(".lr-content:not([hidden])");
    await panel.getByText("Checks in progress", { exact: true }).waitFor();
    const checksButton = panel.getByRole("button", { name: "Checks 2", exact: true });
    await checksButton.focus();
    await page.keyboard.press("Enter");
    expect(
      await panel.locator(".lr-checks").evaluate((node) => (node as HTMLDetailsElement).open),
    ).toBe(true);
    await panel.getByText("Integration tests", { exact: true }).waitFor();
    expect(await panel.locator(".lr-check-copy a").getAttribute("href")).toBe(
      "https://forge.example/runs/1",
    );
    await panel.getByRole("button", { name: "Files 1", exact: true }).click();
    expect(await content.evaluate((node) => node.scrollTop)).toBeGreaterThan(100);
    const navBounds = await content.evaluate((node) => ({
      viewport: node.getBoundingClientRect().top,
      buttons: [...node.querySelectorAll(".lr-section-nav button")].map(
        (button) => button.getBoundingClientRect().top,
      ),
    }));
    expect(navBounds.buttons.every((top) => top >= navBounds.viewport)).toBe(true);
    await panel.locator(".lr-files summary").click();
    await panel.locator(".lr-files .lr-diff").waitFor();
    await panel.getByRole("button", { name: "Discussion 1", exact: true }).click();
    expect(
      await panel
        .locator(".lr-comments")
        .evaluate(
          (node) =>
            node.getRootNode() instanceof ShadowRoot &&
            (node.getRootNode() as ShadowRoot).activeElement === node,
        ),
    ).toBe(true);
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
      const checks: NonNullable<ControlUiLinkReaderDocument["checks"]> = {
        state,
        summary:
          state === "unavailable"
            ? "Checks could not load"
            : state === "neutral"
              ? "No checks reported"
              : "Updated checks",
        total: state === "neutral" ? 0 : 1,
        items:
          state === "unavailable" || state === "neutral" ? [] : [{ name: "Updated build", state }],
      };
      await gateway.setMethodResponse("forge.detail", { ...detail, checks });
      await panel.getByRole("button", { name: "Refresh item", exact: true }).click();
      await panel.locator(".lr-checks--" + state).waitFor({ state: "attached" });
      expect(await panel.locator(".lr-checks-meter").count()).toBe(
        state === "unavailable" || state === "neutral" ? 0 : 1,
      );
    }
    expect(
      (await gateway.getRequests("forge.detail"))
        .slice(1)
        .every((request) => (request.params as { refresh?: boolean }).refresh === true),
    ).toBe(true);
    await page.setViewportSize({ width: 390, height: 844 });
    await panel.getByRole("button", { name: "Files 1", exact: true }).click();
    const geometry = await content.evaluate((node) => ({
      width: node.clientWidth,
      scroll: node.scrollWidth,
    }));
    expect(geometry.scroll).toBeLessThanOrEqual(geometry.width + 1);
    const mobileNav = await panel.locator(".lr-section-nav").evaluate((node) => ({
      top: node.getBoundingClientRect().top,
      first: node.firstElementChild!.getBoundingClientRect().top,
      last: node.lastElementChild!.getBoundingClientRect().top,
    }));
    expect(mobileNav.first).toBe(mobileNav.last);
    expect(mobileNav.first).toBeGreaterThanOrEqual(mobileNav.top);
  } finally {
    await context.close();
    await browser.close();
    await server.close();
  }
});
