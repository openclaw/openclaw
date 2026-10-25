import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeAll, expect, it } from "vitest";
import { createPlaybackMediaFixture } from "../../../test/fixtures/media-playback.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.ts";
import {
  newChatPage,
  buildLocalWebchatAudioMessage,
  createChatFlowE2eSuite,
  installMockGateway,
  textContent,
} from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();
const mediaTempDirs = useAutoCleanupTempDirTracker(afterEach);
const outbound = "/home/node/.openclaw/media/outbound";
const ticket = "ticket-local";

suite.define(() => {
  beforeAll(async () => {
    // Prepare Gateway fixture workers before the per-case behavior timeout starts.
    await import("../../../src/gateway/server-methods/chat-webchat-media.ts");
  });

  it.each([
    ["audio", `${outbound}/voice.mp3`, "allowed"],
    ["image", `${outbound}/image.png`, "allowed"],
    ["image", `FILE://${outbound}/upper.png`, "allowed"],
    ["image", `file:${outbound}/plain.png`, "allowed"],
    ["audio", "structured.mp3", "structured"],
    ...[
      "~/media/report-voice.mp3",
      "/workspace/project/../media/report-voice.mp3",
      "C:\\workspace\\project\\..\\media\\report-voice.mp3",
    ].map((source) => ["audio", source, "attachment"] as const),
  ] as const)(
    "renders local assistant %s through server metadata (%s, %s)",
    async (kind, fixtureSource, mode) => {
      const source =
        mode === "structured"
          ? `FILE:${path.join(mediaTempDirs.make("control-ui-audio-"), fixtureSource)}`
          : fixtureSource;
      const expectedSource = mode === "structured" ? new URL(source).pathname : source;
      const page = await newChatPage(suite);
      const requestedMediaUrls: URL[] = [];

      await page.route("**/__openclaw__/assistant-media?**", async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        requestedMediaUrls.push(url);
        expect(url.searchParams.get("source")).toBe(expectedSource);
        if (url.searchParams.get("meta") === "1") {
          expect(request.headers().authorization).toBe("Bearer e2e-device-token");
          await route.fulfill({
            json: {
              available: true,
              mediaTicket: ticket,
              mediaTicketExpiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
            },
          });
          return;
        }
        expect(url.searchParams.get("mediaTicket")).toBe(ticket);
        expect(request.headers().authorization).toBeUndefined();
        await route.fulfill(
          kind === "image"
            ? {
                contentType: "image/png",
                body: await readFile(path.join(process.cwd(), "ui/public/apple-touch-icon.png")),
              }
            : { contentType: "audio/mpeg", body: createPlaybackMediaFixture("mp3") },
        );
      });

      const content =
        kind === "image"
          ? [{ type: "image", url: source, alt: "Local bootstrap image" }]
          : mode === "attachment"
            ? [
                { type: "text", text: "Your recording" },
                {
                  type: "attachment",
                  attachment: {
                    kind: "audio",
                    label: "report-voice.mp3",
                    mimeType: "audio/mpeg",
                    url: source,
                  },
                },
              ]
            : mode === "structured"
              ? (await buildLocalWebchatAudioMessage(source)).content
              : textContent(`Your recording\nMEDIA:${source}`);
      await installMockGateway(page, {
        historyMessages: [
          {
            id: `assistant-bootstrap-local-${kind}`,
            role: "assistant",
            timestamp: Date.now(),
            content,
          },
        ],
      });
      await page.goto(`${suite.server.baseUrl}chat`);

      const media =
        kind === "image"
          ? page.getByAltText("Local bootstrap image")
          : page.locator("openclaw-chat-audio-player");
      await media.waitFor({ state: "visible", timeout: 10_000 });
      await expect
        .poll(() => requestedMediaUrls.length, { timeout: 10_000 })
        .toBeGreaterThanOrEqual(2);
      expect(requestedMediaUrls[0]!.searchParams.get("meta")).toBe("1");
      if (kind === "audio") {
        const href = await media
          .locator(".chat-assistant-attachment-card__download")
          .getAttribute("href");
        const download = new URL(href ?? "", suite.server.baseUrl);
        expect(download.searchParams.get("mediaTicket")).toBe(ticket);
        expect(download.searchParams.get("source")).toBe(expectedSource);
        await expect
          .poll(() =>
            media.locator("audio").evaluate((element) => (element as HTMLMediaElement).readyState),
          )
          .toBeGreaterThanOrEqual(1);
      }
      expect(await page.getByText("Outside allowed folders").count()).toBe(0);
      if (kind === "image") {
        await expect
          .poll(() =>
            media.evaluate((element) =>
              element instanceof HTMLImageElement && element.complete ? element.naturalWidth : 0,
            ),
          )
          .toBe(180);
      }
    },
  );
});
