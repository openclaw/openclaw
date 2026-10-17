import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import {
  defaultControlUiFeatureMethods,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import {
  meetingEntry,
  meetingPage,
  meetingStatus,
} from "../test-helpers/transcripts.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Meeting transcript library mocked Gateway E2E" });
const methods = [
  ...defaultControlUiFeatureMethods,
  "transcripts.list",
  "transcripts.get",
  "transcripts.export",
  "transcripts.status",
];
function pageOptions(mobile = false, record = true) {
  const viewport = mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 };
  return {
    viewport,
    locale: "en-US",
    serviceWorkers: "block" as const,
    ...(mobile ? { colorScheme: "dark" as const } : {}),
    ...(record ? { recordVideo: { dir: suite.artifactDir, size: viewport } } : {}),
  };
}
function configResponse(config: unknown, hash: string) {
  return {
    config,
    hash,
    appliedConfigHash: hash,
    raw: JSON.stringify(config),
    valid: true,
    issues: [],
  };
}
function exportResponse(contents: string, extension: string, mimeType: string) {
  return {
    selector: meetingEntry.selector,
    filename: `design-review.${extension}`,
    mimeType,
    encoding: "base64",
    data: Buffer.from(contents).toString("base64"),
    sizeBytes: Buffer.byteLength(contents),
  };
}
const screenshot = (page: Page, name: string) =>
  page.screenshot({ path: path.join(suite.artifactDir, `${name}.png`), animations: "disabled" });
async function expectDownload(
  page: Page,
  reader: Locator,
  format: string,
  extension: string,
  contents: string,
) {
  const event = page.waitForEvent("download");
  await reader.getByRole("button", { name: `Download ${format}` }).click();
  const download = await event;
  expect(download.suggestedFilename()).toBe(`design-review.${extension}`);
  const file = await download.path();
  expect(file).not.toBeNull();
  expect(await readFile(file!, "utf8")).toBe(contents);
}

suite.define(() => {
  it("renders provider locators after native selection and saves a new capture source", async () => {
    await suite.withPage(pageOptions(false, false), async ({ page }) => {
      const config = { transcripts: { enabled: false, autoStart: [] } };
      const gateway = await installMockGateway(page, {
        featureMethods: methods,
        methodResponses: {
          "config.get": configResponse(config, "empty-sources"),
          "transcripts.status": { ...meetingStatus, enabled: false, configuredSources: [] },
        },
      });
      await page.goto(
        `${suite.server.baseUrl}settings/advanced?section=transcripts#config-section-transcripts`,
      );
      const capture = page.locator("openclaw-meeting-capture-settings");
      await capture.getByRole("button", { name: "Add source", exact: true }).click();
      const redirected = new URL(page.url());
      expect(redirected.pathname).toBe("/settings/communications");
      expect(redirected.searchParams.get("advanced")).toBe("1");
      expect(redirected.hash).toBe("#config-section-transcripts");
      const save = capture.getByRole("button", { name: "Save source", exact: true });
      expect(await save.isDisabled()).toBe(true);
      expect(await capture.getByRole("textbox", { name: "Guild ID", exact: true }).count()).toBe(0);

      await capture
        .getByRole("combobox", { name: "Provider", exact: true })
        .selectOption("test-voice");
      const guild = capture.getByRole("textbox", { name: "Guild ID", exact: true });
      const channel = capture.getByRole("textbox", { name: "Channel ID", exact: true });
      await guild.waitFor();
      expect(await guild.getAttribute("required")).not.toBeNull();
      expect(await channel.getAttribute("required")).not.toBeNull();
      await expect.poll(() => save.isEnabled()).toBe(true);
      await guild.fill("synthetic-guild");
      await channel.fill("synthetic-room");
      await capture.getByRole("textbox", { name: "Title", exact: true }).fill("New capture source");
      await save.scrollIntoViewIfNeeded();
      await screenshot(page, "meeting-capture-new-source");
      await save.click();
      await expect
        .poll(async () => (await gateway.getRequests("config.set")).at(-1)?.params)
        .toMatchObject({ raw: expect.stringContaining("New capture source") });
      const write = (await gateway.getRequests("config.set")).at(-1)?.params as { raw: string };
      expect(JSON.parse(write.raw).transcripts.autoStart).toEqual([
        {
          providerId: "test-voice",
          title: "New capture source",
          guildId: "synthetic-guild",
          channelId: "synthetic-room",
        },
      ]);
    });
  });

  it("reads, searches, extracts, downloads and edits capture through normal navigation", async () => {
    await suite.withPage(pageOptions(), async ({ page }) => {
      const source = {
        providerId: "test-voice",
        title: "Design review",
        accountId: "team",
        guildId: "guild",
        channelId: "room",
        sessionId: "custom-session",
      };
      const config = { transcripts: { enabled: true, autoStart: [source] } };
      const markdown = "# Design review\n\nAvery: Keep the reader quiet and readable.\n";
      const gateway = await installMockGateway(page, {
        featureMethods: methods,
        deferredMethods: ["transcripts.list"],
        methodResponses: {
          "config.get": configResponse(config, "initial"),
          "transcripts.list": { sessions: [meetingEntry], nextCursor: "list-next" },
          "transcripts.get": {
            cases: [
              { match: { query: "quiet" }, response: { ...meetingPage, nextCursor: null } },
              {
                match: { cursor: "reader-page-2" },
                response: {
                  ...meetingPage,
                  utterances: [
                    {
                      sequence: 1,
                      speakerLabel: "Blair",
                      text: "The next page is readable too.",
                    },
                  ],
                  nextCursor: null,
                },
              },
              { match: {}, response: meetingPage },
            ],
          },
          "transcripts.status": meetingStatus,
          "transcripts.export": exportResponse(markdown, "md", "text/markdown"),
        },
      });
      await page.goto(`${suite.server.baseUrl}meetings`);
      const library = page.locator(".transcripts-library");
      await library.getByRole("status").getByText("Loading meetings…").waitFor();
      expect(await library.getAttribute("aria-busy")).toBe("true");
      await gateway.resolveDeferred("transcripts.list");
      await library.getByRole("link", { name: /Design review/ }).waitFor();
      expect(await library.getAttribute("aria-busy")).toBe("false");
      await library.getByRole("searchbox", { name: "Search meetings" }).fill("design");
      await library.getByRole("button", { name: "Filter", exact: true }).click();
      await expect
        .poll(async () => (await gateway.getRequests("transcripts.list")).at(-1)?.params)
        .toMatchObject({ query: "design", limit: 50 });
      await library.getByRole("button", { name: "Next page" }).click();
      await expect
        .poll(async () => (await gateway.getRequests("transcripts.list")).at(-1)?.params)
        .toMatchObject({ cursor: "list-next", query: "design" });
      await gateway.deferNext("transcripts.get", { selector: meetingEntry.selector });
      await library.getByRole("link", { name: /Design review/ }).click();
      const reader = page.getByRole("article", { name: "Transcript reader" });
      await reader.getByRole("status").getByText("Loading summary…").waitFor();
      expect(await reader.getAttribute("aria-busy")).toBe("true");
      await gateway.resolveDeferred("transcripts.get");
      await reader.getByText("Reader layout discussed.", { exact: true }).waitFor();
      expect(await reader.getAttribute("aria-busy")).toBe("false");
      await reader.getByRole("tab", { name: "Transcript", exact: true }).click();
      await reader.getByText("Keep the reader quiet and readable.", { exact: true }).waitFor();
      await reader.getByText("The next page is readable too.", { exact: true }).waitFor();
      await screenshot(page, "meetings-transcript-desktop");
      await reader.getByRole("searchbox", { name: "Search within this transcript" }).fill("quiet");
      await reader.getByRole("button", { name: "Search", exact: true }).click();
      await expect
        .poll(async () => (await gateway.getRequests("transcripts.get")).at(-1)?.params)
        .toMatchObject({ selector: meetingEntry.selector, query: "quiet", limit: 50 });
      await reader.getByRole("tab", { name: "Summary" }).click();
      await reader.getByText("Reader layout discussed.", { exact: true }).waitFor();
      await expect
        .poll(() => reader.textContent())
        .toContain("Notes extracted using text heuristics");
      await expectDownload(page, reader, "Markdown", "md", markdown);
      const jsonl = `${JSON.stringify(meetingPage.utterances![0])}\n`;
      await gateway.setMethodResponse(
        "transcripts.export",
        exportResponse(jsonl, "jsonl", "application/x-ndjson"),
      );
      await expectDownload(page, reader, "JSONL", "jsonl", jsonl);
      await gateway.setMethodResponse("transcripts.export", {
        __mockError: { code: "INVALID_REQUEST", message: "Transcript export exceeds 4 MiB" },
      });
      await reader.getByRole("button", { name: "Download JSONL" }).click();
      await reader.getByRole("alert").filter({ hasText: "Download failed" }).waitFor();
      await page.getByRole("link", { name: "Meeting capture", exact: true }).click();
      const capture = page.locator("openclaw-meeting-capture-settings");
      await capture.getByText("Not active", { exact: true }).waitFor();
      await screenshot(page, "meeting-capture-settings");
      await capture.getByRole("button", { name: "Edit source 1" }).click();
      await capture
        .getByRole("textbox", { name: "Title", exact: true })
        .fill("Weekly design review");
      await capture.getByRole("button", { name: "Save source" }).click();
      await expect
        .poll(async () => (await gateway.getRequests("config.set")).at(-1)?.params)
        .toMatchObject({ raw: expect.stringContaining("Weekly design review") });
      const write = (await gateway.getRequests("config.set")).at(-1)?.params as { raw: string };
      expect(JSON.parse(write.raw).transcripts.autoStart).toEqual([
        { ...source, title: "Weekly design review" },
      ]);
      await gateway.deferNext("transcripts.list");
      await capture.getByRole("button", { name: /Transcript library/ }).click();
      await library.getByRole("status").getByText("Loading meetings…").waitFor();
      await gateway.resolveDeferred("transcripts.list");
      await library.getByRole("link", { name: /Design review/ }).waitFor();
      expect(
        (await gateway.getRequests()).some((request) => request.method === "sessions.search"),
      ).toBe(false);
    });
  });

  it("uses a single column on mobile, keeps text escaped, and shows restricted access", async () => {
    await suite.withPage(pageOptions(true), async ({ page }) => {
      const gateway = await installMockGateway(page, {
        featureMethods: methods,
        methodResponses: {
          "transcripts.list": { sessions: [meetingEntry], nextCursor: null },
          "transcripts.get": {
            ...meetingPage,
            utterances: [{ sequence: 0, text: "<script>unsafe()</script> Plain transcript text." }],
            nextCursor: null,
          },
        },
      });
      await page.goto(`${suite.server.baseUrl}meetings?selector=`);
      await page.locator(".transcripts-library").waitFor({ state: "visible" });
      await page.goto(
        `${suite.server.baseUrl}meetings?tab=transcript&selector=${encodeURIComponent(meetingEntry.selector)}`,
      );
      const reader = page.getByRole("article", { name: "Transcript reader" });
      await reader
        .getByText("<script>unsafe()</script> Plain transcript text.", { exact: true })
        .waitFor();
      expect(await page.locator(".transcripts-library").isVisible()).toBe(false);
      await screenshot(page, "meetings-transcript-mobile");
      expect(await reader.locator("script").count()).toBe(0);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      await reader.getByRole("link", { name: "Back to library" }).click();
      await page.locator(".transcripts-library").waitFor({ state: "visible" });
      await gateway.setMethodResponse("transcripts.list", {
        __mockError: { code: "FORBIDDEN", message: "Shared archive restricted" },
      });
      await page.getByRole("button", { name: "Refresh", exact: true }).click();
      await page.getByRole("heading", { name: "Transcript access is restricted" }).waitFor();
      expect(await page.locator(".transcripts-list__entry").count()).toBe(0);
    });
  });
});
