import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
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
const mediaParams = (url: URL) =>
  Object.fromEntries(
    ["meta", "source", "mediaTicket"].map((key) => [key, url.searchParams.get(key)]),
  );

suite.define(() => {
  it.each([
    ["audio", `${outbound}/voice.mp3`, "allowed"],
    ["image", `${outbound}/image.png`, "allowed"],
    ["image", "/projects/chat-worktree/.openclaw/tmp/review/preview.png", "revalidate"],
    ["image", `FILE://${outbound}/upper.png`, "allowed"],
    ["image", `file:${outbound}/plain.png`, "allowed"],
    ["audio", "structured.mp3", "structured"],
    ...[
      "~/media/report-voice.mp3",
      "/workspace/project/../media/report-voice.mp3",
      "C:\\workspace\\project\\..\\media\\report-voice.mp3",
    ].map((source) => ["audio", source, "attachment"] as const),
    ["audio", "/home/node/private/bootstrap-secret.mp3", "outside-allowed-folders"],
    ["audio", `${outbound}/bootstrap-missing.mp3`, "file-not-found"],
  ] as const)(
    "renders local assistant %s through server metadata (%s, %s)",
    async (kind, fixtureSource, mode) => {
      const source =
        mode === "structured"
          ? `FILE:${path.join(mediaTempDirs.make("control-ui-audio-"), fixtureSource)}`
          : fixtureSource;
      const denied = mode === "outside-allowed-folders" || mode === "file-not-found";
      const reason = mode === "file-not-found" ? "File not found" : "Outside allowed folders";
      const expectedSource = mode === "structured" ? new URL(source).pathname : source;
      const page = await newChatPage(suite);
      const requestedMediaUrls: URL[] = [];
      let mediaAllowed = true;

      await page.route("**/__openclaw__/assistant-media?**", async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        requestedMediaUrls.push(url);
        expect(url.searchParams.get("source")).toBe(expectedSource);
        if (denied) {
          expect(url.searchParams.get("meta")).toBe("1");
        }
        if (url.searchParams.get("meta") === "1") {
          expect(request.headers().authorization).toBe("Bearer e2e-device-token");
          await route.fulfill({
            json: denied
              ? { available: false, code: mode, reason }
              : !mediaAllowed
                ? {
                    available: false,
                    reason: "Outside allowed folders",
                    retryable: false,
                    canAllow: true,
                  }
                : {
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
              : textContent(
                  `${denied ? "Unavailable recording" : "Your recording"}\nMEDIA:${source}`,
                );
      const id = denied
        ? `assistant-bootstrap-blocked-${mode}`
        : `assistant-bootstrap-local-${kind}`;
      const gateway = await installMockGateway(page, {
        historyMessages: [{ id, role: "assistant", timestamp: Date.now(), content }],
      });
      await page.goto(`${suite.server.baseUrl}chat`);

      if (denied) {
        const status = page.locator(".chat-assistant-attachment-card__status-meta");
        await status.waitFor({ state: "visible", timeout: 10_000 });
        await expect.poll(() => status.textContent()).toContain(reason);
        expect(requestedMediaUrls).toHaveLength(1);
        expect(await page.locator(".chat-assistant-attachment-card audio").count()).toBe(0);
        expect(await page.locator(".chat-assistant-attachment-card__download").count()).toBe(0);
        return;
      }

      const media =
        kind === "image"
          ? page.getByAltText("Local bootstrap image")
          : page.locator("openclaw-chat-audio-player");
      await media.waitFor({ state: "visible", timeout: 10_000 });
      await expect
        .poll(() => requestedMediaUrls.length, { timeout: 10_000 })
        .toBeGreaterThanOrEqual(2);
      expect(requestedMediaUrls[0]!.searchParams.get("meta")).toBe("1");
      expect(
        requestedMediaUrls.slice(1).some((url) => url.searchParams.get("mediaTicket") === ticket),
      ).toBe(true);
      if (kind === "audio") {
        const href = await media
          .locator(".chat-assistant-attachment-card__download")
          .getAttribute("href");
        expect(href).toContain(`mediaTicket=${ticket}`);
        expect(mediaParams(new URL(href ?? "", suite.server.baseUrl))).toMatchObject({
          mediaTicket: ticket,
          source: expectedSource,
        });
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
      if (mode === "revalidate") {
        mediaAllowed = false;
        await gateway.emitGatewayEvent("config.changed", { hash: "workspace-protected" });
        const allowImage = page.getByRole("button", { name: "Allow image", exact: true });
        await allowImage.waitFor();
        expect(await media.count()).toBe(0);
        mediaAllowed = true;
        await gateway.emitGatewayEvent("config.changed", { hash: "workspace-unprotected" });
        await media.waitFor({ state: "visible" });
        await expect
          .poll(() => media.evaluate((element) => (element as HTMLImageElement).naturalWidth))
          .toBe(180);
        expect(await allowImage.count()).toBe(0);
        expect(
          requestedMediaUrls.filter((url) => url.searchParams.get("meta") === "1"),
        ).toHaveLength(3);
      }
    },
  );
});
