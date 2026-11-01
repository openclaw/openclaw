import { expect, it } from "vitest";
import type { ControlUiLinkReaderDocument } from "../../../src/shared/control-ui-link-reader.js";
import { openChatPanels } from "../test-helpers/chat-layout-menu.ts";
import { TEST_LINK_READER } from "../test-helpers/link-reader.ts";
import {
  readerUrl as url,
  readerFile,
  readerComment,
  withLinkReader,
} from "./link-reader.test-support.ts";

it("makes the overview readable before extras and retains visible content through refresh", async () => {
  const overview: ControlUiLinkReaderDocument = {
    url,
    title: "Improve task progress header actions",
    subtitle: "example/project #42",
    badge: { label: "Merged", tone: "accent" },
    author: "contributor",
    createdAt: "2026-10-16T12:00:00Z",
    revision: "head-a",
    body: "### Progress actions\n\nClear **Step N of M** metadata and actions.\n\n".repeat(30),
    metadata: [
      { label: "Additions", value: "+224", tone: "positive" },
      { label: "Deletions", value: "−157", tone: "negative" },
      { label: "Files", value: "13" },
    ],
    deferredSections: ["checks", "files", "discussion"],
    filesTotal: 13,
    commentsTotal: 1,
  };
  await withLinkReader(
    {
      controlUiLinkReaders: [
        { ...TEST_LINK_READER, linkReader: { ...TEST_LINK_READER.linkReader, progressive: true } },
      ],
      heldMethods: ["forge.detail"],
    },
    async ({ page, gateway, panel, content, button }) => {
      await panel.locator(".lr-skeleton").waitFor();
      await gateway.waitForRequest("forge.detail", { match: { section: "overview" } });
      await gateway.resolveDeferred("forge.detail", overview, { match: { section: "overview" } });
      await panel.getByRole("heading", { name: overview.title, exact: true }).waitFor();
      await gateway.waitForRequest("forge.detail", { match: { section: "checks" } });
      await gateway.waitForRequest("forge.detail", { match: { section: "discussion" } });
      expect((await gateway.getRequests("forge.detail", { section: "files" })).length).toBe(0);
      expect(await panel.getByText("Loading Checks…", { exact: true }).count()).toBe(1);
      await gateway.rejectDeferred(
        "forge.detail",
        { code: "UNAVAILABLE", message: "Temporarily unavailable", retryable: true },
        { match: { section: "checks" } },
      );
      await panel.getByText("Could not load Checks.", { exact: true }).waitFor();
      await gateway.resolveDeferred(
        "forge.detail",
        {
          ...overview,
          comments: [readerComment("The overview stays readable.")],
        },
        { match: { section: "discussion" } },
      );
      await panel.locator(".lr-comment").waitFor({ state: "attached" });
      expect(await panel.getByRole("heading", { name: overview.title, exact: true }).count()).toBe(
        1,
      );
      await page.setViewportSize({ width: 390, height: 844 });
      await openChatPanels(page, "mobile");
      expect(await content.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
      await page.setViewportSize({ width: 1280, height: 900 });
      await button("Files 13").click();
      await gateway.waitForRequest("forge.detail", { match: { section: "files" } });
      await gateway.resolveDeferred(
        "forge.detail",
        {
          ...overview,
          files: [readerFile("src/progress-header.ts")],
          filesTruncated: true,
        },
        { match: { section: "files" } },
      );
      await panel.locator(".lr-files .lr-file").waitFor();
      expect(
        await panel
          .getByText("This view is incomplete. Open the original for the full item.", {
            exact: true,
          })
          .count(),
      ).toBe(0);
      const top = await content.evaluate((node) => node.scrollTop);
      const document = await panel.locator(".lr-document").elementHandle();
      await button("Refresh item").click();
      await panel.getByText("Showing previous details · refreshing…", { exact: true }).waitFor();
      expect(await content.evaluate((node) => node.scrollTop)).toBe(top);
      expect(await document!.evaluate((node) => node.isConnected)).toBe(true);
      await gateway.waitForRequest("forge.detail", { after: 1, match: { section: "overview" } });
      await gateway.resolveDeferred("forge.detail", overview, { match: { section: "overview" } });
      await expect.poll(() => panel.locator(".lr-files .lr-file").count()).toBe(1);
      expect(await document!.evaluate((node) => node.isConnected)).toBe(true);
      await gateway.waitForRequest("forge.detail", { after: 1, match: { section: "files" } });
    },
  );
});
