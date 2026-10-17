import { writeFileSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { expect, it } from "vitest";
import type { ControlUiLinkReaderDocument } from "../../../src/shared/control-ui-link-reader.js";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";
import { TEST_LINK_READER } from "../test-helpers/link-reader.ts";

it("makes the overview readable before extras and retains visible content through refresh", async () => {
  const server = await startControlUiE2eServer();
  const browser = await chromium.launch({
    executablePath: resolvePlaywrightChromiumExecutablePath(chromium.executablePath()),
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  try {
    const page = await context.newPage();
    const url = "https://forge.example/items/42";
    const overview: ControlUiLinkReaderDocument = {
      url,
      title: "Improve task progress header actions",
      subtitle: "example/project #42",
      badge: { label: "Merged", tone: "accent" },
      author: "contributor",
      createdAt: "2026-10-16T12:00:00Z",
      revision: "head-a",
      body: [
        "### What Problem This Solves",
        "",
        "The task-progress header gives refresh, options, hide, and disclosure equal weight, while its step count is ambiguous.",
        "",
        "### User Impact",
        "",
        "A quieter header with an options menu and explicit **Step N of M** metadata. Refresh and Hide this card remain available.",
        "",
        ...Array(8).fill(
          "### Implementation\n\nSecondary actions belong in the existing menu. Permission checks and refresh feedback remain intact.\n",
        ),
      ].join("\n"),
      metadata: [
        { label: "Additions", value: "+224", tone: "positive" },
        { label: "Deletions", value: "−157", tone: "negative" },
        { label: "Files", value: "13" },
      ],
      deferredSections: ["checks", "files", "discussion"],
      filesTotal: 13,
      commentsTotal: 1,
    };
    const gateway = await installMockGateway(page, {
      controlUiLinkReaders: [
        { ...TEST_LINK_READER, linkReader: { ...TEST_LINK_READER.linkReader, progressive: true } },
      ],
      featureMethods: ["chat.startup", "chat.metadata", "forge.detail"],
      heldMethods: ["forge.detail"],
      historyMessages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "[Review pull request](" + url + ")" }],
        },
      ],
    });
    await page.goto(server.baseUrl + "chat");
    await page.getByRole("link", { name: "Review pull request", exact: true }).click();
    const panel = page.locator("openclaw-link-reader-panel");
    const content = panel.locator(".lr-content:not([hidden])");
    await panel.locator(".lr-skeleton").waitFor();
    const dir = createControlUiE2eArtifactDir("reader-loading");
    const capture = async (name: string) => {
      const frame = await takeControlUiScreenshotFrame(
        page,
        panel,
        [panel.locator(".lr-toolbar")],
        { elements: [panel], animations: "disabled" },
      );
      writeFileSync(path.join(dir, name + ".png"), frame.elements[0]!.png);
    };
    await capture("cold");
    await gateway.waitForRequest("forge.detail", { match: { section: "overview" } });
    await gateway.resolveDeferred("forge.detail", overview, { match: { section: "overview" } });
    await panel.getByRole("heading", { name: overview.title, exact: true }).waitFor();
    await gateway.waitForRequest("forge.detail", { match: { section: "checks" } });
    await gateway.waitForRequest("forge.detail", { match: { section: "discussion" } });
    expect((await gateway.getRequests("forge.detail", { section: "files" })).length).toBe(0);
    expect(await panel.getByText("Loading Checks…", { exact: true }).count()).toBe(1);
    await capture("after");
    await page.setViewportSize({ width: 390, height: 844 });
    await capture("mobile");
    expect(await content.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
    await page.setViewportSize({ width: 1280, height: 900 });
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
        comments: [
          {
            id: "reply",
            author: "reviewer",
            url: url + "#reply",
            body: "The overview stays readable.",
          },
        ],
      },
      { match: { section: "discussion" } },
    );
    await panel.locator(".lr-comment").waitFor({ state: "attached" });
    expect(await panel.getByRole("heading", { name: overview.title, exact: true }).count()).toBe(1);
    await panel.getByRole("button", { name: "Files 13", exact: true }).click();
    await gateway.waitForRequest("forge.detail", { match: { section: "files" } });
    await gateway.resolveDeferred(
      "forge.detail",
      {
        ...overview,
        files: [
          { path: "src/progress-header.ts", additions: 1, deletions: 1, patch: "-old\n+new" },
        ],
        filesTruncated: true,
      },
      { match: { section: "files" } },
    );
    await panel.locator(".lr-files .lr-file").waitFor();
    expect(
      await panel
        .getByText("This view is incomplete. Open the original for the full item.", { exact: true })
        .count(),
    ).toBe(0);
    const top = await content.evaluate((node) => node.scrollTop);
    const document = await panel.locator(".lr-document").elementHandle();
    await panel.getByRole("button", { name: "Refresh item", exact: true }).click();
    await panel.getByText("Showing previous details · refreshing…", { exact: true }).waitFor();
    expect(await content.evaluate((node) => node.scrollTop)).toBe(top);
    expect(await document!.evaluate((node) => node.isConnected)).toBe(true);
    await gateway.waitForRequest("forge.detail", { after: 1, match: { section: "overview" } });
    await gateway.resolveDeferred("forge.detail", overview, { match: { section: "overview" } });
    await expect.poll(() => panel.locator(".lr-files .lr-file").count()).toBe(1);
    expect(await document!.evaluate((node) => node.isConnected)).toBe(true);
    await gateway.waitForRequest("forge.detail", { after: 1, match: { section: "files" } });
    await capture("refresh");
  } finally {
    await context.close();
    await browser.close();
    await server.close();
  }
});
