import { readFile } from "node:fs/promises";
import type { TranscriptsGetResult } from "@openclaw/gateway-protocol";
import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import {
  defaultControlUiFeatureMethods,
  installMockGateway,
  type MockGatewayControls,
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
function pageOptions(mobile = false) {
  const viewport = mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 };
  return {
    viewport,
    locale: "en-US",
    serviceWorkers: "block" as const,
    ...(mobile ? { colorScheme: "dark" as const } : {}),
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
const control = (root: Page | Locator, role: Parameters<Page["getByRole"]>[0], name: string) =>
  root.getByRole(role, { name, exact: true });
const text = (root: Page | Locator, value: string) => root.getByText(value, { exact: true });
const click = (root: Page | Locator, name: string) => control(root, "button", name).click();
const transcriptCase = (match: object, response: TranscriptsGetResult = meetingPage) => ({
  match,
  response,
});
const transcriptPage = (utterances: TranscriptsGetResult["utterances"]) => ({
  ...meetingPage,
  utterances,
  nextCursor: null,
});
const expectParams = (gateway: MockGatewayControls, method: string, params: object) =>
  expect.poll(async () => (await gateway.getRequests(method)).at(-1)?.params).toMatchObject(params);
async function expectSource(gateway: MockGatewayControls, source: object & { title: string }) {
  await expectParams(gateway, "config.set", { raw: expect.stringContaining(source.title) });
  const write = (await gateway.getRequests("config.set")).at(-1)?.params as { raw: string };
  expect(JSON.parse(write.raw).transcripts.autoStart).toEqual([source]);
}
async function expectDownload(
  page: Page,
  reader: Locator,
  format: string,
  extension: string,
  contents: string,
) {
  const event = page.waitForEvent("download");
  await click(reader, `Download ${format}`);
  const download = await event;
  expect(download.suggestedFilename()).toBe(`design-review.${extension}`);
  const file = await download.path();
  expect(file).not.toBeNull();
  expect(await readFile(file!, "utf8")).toBe(contents);
}

suite.define(() => {
  it("renders provider locators after native selection and saves a new capture source", async () => {
    await suite.withPage(pageOptions(), async ({ page }) => {
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
      await click(capture, "Add source");
      const redirected = new URL(page.url());
      expect([
        redirected.pathname,
        redirected.searchParams.get("advanced"),
        redirected.hash,
      ]).toEqual(["/settings/communications", "1", "#config-section-transcripts"]);
      const save = control(capture, "button", "Save source");
      expect(await save.isDisabled()).toBe(true);
      expect(await control(capture, "textbox", "Guild ID").count()).toBe(0);

      await control(capture, "combobox", "Provider").selectOption("test-voice");
      const guild = control(capture, "textbox", "Guild ID");
      const channel = control(capture, "textbox", "Channel ID");
      await guild.waitFor();
      expect(await guild.getAttribute("required")).not.toBeNull();
      expect(await channel.getAttribute("required")).not.toBeNull();
      await expect.poll(() => save.isEnabled()).toBe(true);
      await guild.fill("synthetic-guild");
      await channel.fill("synthetic-room");
      await control(capture, "textbox", "Title").fill("New capture source");
      await save.scrollIntoViewIfNeeded();
      await save.click();
      await expectSource(gateway, {
        providerId: "test-voice",
        title: "New capture source",
        guildId: "synthetic-guild",
        channelId: "synthetic-room",
      });
    });
  });

  it("reads, searches, extracts, downloads and edits capture through normal navigation", async () => {
    await suite.withPage(pageOptions(), async ({ page }) => {
      const source = {
        ...meetingEntry.source,
        title: meetingEntry.title,
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
              transcriptCase({ query: "quiet" }, transcriptPage(meetingPage.utterances)),
              transcriptCase(
                { cursor: "reader-page-2" },
                transcriptPage([
                  { sequence: 1, speakerLabel: "Blair", text: "The next page is readable too." },
                ]),
              ),
              transcriptCase({}),
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
      await control(library, "searchbox", "Search meetings").fill("design");
      await click(library, "Filter");
      await expectParams(gateway, "transcripts.list", { query: "design", limit: 50 });
      await click(library, "Next page");
      await expectParams(gateway, "transcripts.list", { cursor: "list-next", query: "design" });
      await gateway.deferNext("transcripts.get", { selector: meetingEntry.selector });
      await library.getByRole("link", { name: /Design review/ }).click();
      const reader = control(page, "article", "Transcript reader");
      await reader.getByRole("status").getByText("Loading summary…").waitFor();
      expect(await reader.getAttribute("aria-busy")).toBe("true");
      await gateway.resolveDeferred("transcripts.get");
      await text(reader, "Reader layout discussed.").waitFor();
      expect(await reader.getAttribute("aria-busy")).toBe("false");
      await control(reader, "tab", "Transcript").click();
      await text(reader, "Keep the reader quiet and readable.").waitFor();
      await text(reader, "The next page is readable too.").waitFor();
      await control(reader, "searchbox", "Search within this transcript").fill("quiet");
      await click(reader, "Search");
      await expectParams(gateway, "transcripts.get", {
        selector: meetingEntry.selector,
        query: "quiet",
        limit: 50,
      });
      await control(reader, "tab", "Summary").click();
      await text(reader, "Reader layout discussed.").waitFor();
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
      await click(reader, "Download JSONL");
      await reader.getByRole("alert").filter({ hasText: "Download failed" }).waitFor();
      await control(page, "link", "Meeting capture").click();
      const capture = page.locator("openclaw-meeting-capture-settings");
      await text(capture, "Not active").waitFor();
      await click(capture, "Edit source 1");
      await control(capture, "textbox", "Title").fill("Weekly design review");
      await click(capture, "Save source");
      await expectSource(gateway, { ...source, title: "Weekly design review" });
      await gateway.deferNext("transcripts.list");
      await capture.getByRole("button", { name: /Transcript library/ }).click();
      await library.getByRole("status").getByText("Loading meetings…").waitFor();
      await gateway.resolveDeferred("transcripts.list");
      await library.getByRole("link", { name: /Design review/ }).waitFor();
      expect(await gateway.getRequests("sessions.search")).toHaveLength(0);
    });
  });

  it("uses a single column on mobile, keeps text escaped, and shows restricted access", async () => {
    await suite.withPage(pageOptions(true), async ({ page }) => {
      const gateway = await installMockGateway(page, {
        featureMethods: methods,
        methodResponses: {
          "transcripts.list": { sessions: [meetingEntry], nextCursor: null },
          "transcripts.get": transcriptPage([
            { sequence: 0, text: "<script>unsafe()</script> Plain transcript text." },
          ]),
        },
      });
      await page.goto(`${suite.server.baseUrl}meetings?selector=`);
      await page.locator(".transcripts-library").waitFor({ state: "visible" });
      await page.goto(
        `${suite.server.baseUrl}meetings?tab=transcript&selector=${encodeURIComponent(meetingEntry.selector)}`,
      );
      const reader = control(page, "article", "Transcript reader");
      await text(reader, "<script>unsafe()</script> Plain transcript text.").waitFor();
      expect(await page.locator(".transcripts-library").isVisible()).toBe(false);
      expect(await reader.locator("script").count()).toBe(0);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      await control(reader, "link", "Back to library").click();
      await page.locator(".transcripts-library").waitFor({ state: "visible" });
      await gateway.setMethodResponse("transcripts.list", {
        __mockError: { code: "FORBIDDEN", message: "Shared archive restricted" },
      });
      await click(page, "Refresh");
      await control(page, "heading", "Transcript access is restricted").waitFor();
      expect(await page.locator(".transcripts-list__entry").count()).toBe(0);
    });
  });
});
