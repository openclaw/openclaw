import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { createPlaybackMediaFixture } from "../../../test/fixtures/media-playback.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.ts";
import {
  chatMessage,
  newChatPage,
  buildLocalWebchatAudioMessage,
  createChatFlowE2eSuite,
  installMockGateway,
} from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();
const mediaTempDirs = useAutoCleanupTempDirTracker(afterEach);

suite.define(() => {
  it.each([
    {
      kind: "audio",
      source: "/home/node/.openclaw/media/outbound/bootstrap-voice.mp3",
      ticket: "ticket-bootstrap-audio",
    },
    {
      kind: "image",
      source: "/home/node/.openclaw/media/outbound/bootstrap-image.png",
      ticket: "ticket-bootstrap-image",
    },
    {
      kind: "image",
      source: "/projects/chat-worktree/.openclaw/tmp/review/preview.png",
      ticket: "ticket-project-image",
      revalidatePolicy: true,
    },
    {
      kind: "image",
      source: "FILE:///home/node/.openclaw/media/outbound/bootstrap-uppercase-image.png",
      ticket: "ticket-bootstrap-uppercase-image",
    },
    {
      kind: "image",
      source: "file:/home/node/.openclaw/media/outbound/bootstrap-authorityless-image.png",
      ticket: "ticket-bootstrap-authorityless-image",
    },
    {
      kind: "audio",
      source: "bootstrap-structured-audio.mp3",
      ticket: "ticket-bootstrap-structured-audio",
      structured: true,
    },
    ...[
      "~/media/report-voice.mp3",
      "/workspace/project/../media/report-voice.mp3",
      "C:\\workspace\\project\\..\\media\\report-voice.mp3",
    ].map((source) => ({ kind: "audio", source, ticket: "ticket-dollar-home", attachment: true })),
  ] as const)(
    "renders local assistant $kind through server metadata",
    async ({ kind, source: fixtureSource, ticket, ...options }) => {
      const source =
        "structured" in options
          ? `FILE:${path.join(mediaTempDirs.make("control-ui-audio-"), fixtureSource)}`
          : fixtureSource;
      const page = await newChatPage(suite);
      const requestedMediaUrls: URL[] = [];
      const expectedSource = "structured" in options ? new URL(source).pathname : source;
      let mediaAllowed = true;

      await page.route("**/__openclaw__/assistant-media?**", async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        requestedMediaUrls.push(url);
        expect(url.searchParams.get("source")).toBe(expectedSource);
        if (url.searchParams.get("meta") === "1") {
          expect(request.headers().authorization).toBe("Bearer e2e-device-token");
          if (!mediaAllowed) {
            await route.fulfill({
              json: {
                available: false,
                reason: "Outside allowed folders",
                retryable: false,
                canAllow: true,
              },
            });
            return;
          }
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
            : {
                contentType: "audio/mpeg",
                body: createPlaybackMediaFixture("mp3"),
              },
        );
      });

      const gateway = await installMockGateway(page, {
        historyMessages: [
          kind === "image"
            ? {
                id: "assistant-bootstrap-local-image",
                role: "assistant",
                content: [{ type: "image", url: source, alt: "Local bootstrap image" }],
                timestamp: Date.now(),
              }
            : {
                id: "assistant-bootstrap-local-audio",
                role: "assistant",
                content:
                  "attachment" in options
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
                    : "structured" in options
                      ? (await buildLocalWebchatAudioMessage(source)).content
                      : [{ type: "text", text: `Your recording\nMEDIA:${source}` }],
                timestamp: Date.now(),
              },
        ],
      });

      await page.goto(`${suite.server.baseUrl}chat`);
      const media =
        kind === "image"
          ? page.getByAltText("Local bootstrap image")
          : page.locator("openclaw-chat-audio-player");
      await media.waitFor({
        state: "visible",
        timeout: 10_000,
      });
      await expect
        .poll(() => requestedMediaUrls.length, { timeout: 10_000 })
        .toBeGreaterThanOrEqual(2);
      expect(requestedMediaUrls[0]?.searchParams.get("meta")).toBe("1");
      expect(requestedMediaUrls[0]?.searchParams.get("source")).toBe(expectedSource);
      expect(
        requestedMediaUrls.slice(1).some((url) => url.searchParams.get("mediaTicket") === ticket),
      ).toBe(true);
      if (kind === "audio") {
        const href = await media
          .locator(".chat-assistant-attachment-card__download")
          .getAttribute("href");
        expect(href).toBeTruthy();
        expect(href).toContain(`mediaTicket=${ticket}`);
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

      if ("revalidatePolicy" in options) {
        mediaAllowed = false;
        await gateway.emitGatewayEvent("config.changed", { hash: "workspace-protected" });
        await page.getByRole("button", { name: "Allow image", exact: true }).waitFor();
        expect(await media.count()).toBe(0);

        mediaAllowed = true;
        await gateway.emitGatewayEvent("config.changed", { hash: "workspace-unprotected" });
        await media.waitFor({ state: "visible" });
        await expect
          .poll(() => media.evaluate((element) => (element as HTMLImageElement).naturalWidth))
          .toBe(180);
        expect(await page.getByRole("button", { name: "Allow image", exact: true }).count()).toBe(
          0,
        );
        expect(
          requestedMediaUrls.filter((url) => url.searchParams.get("meta") === "1"),
        ).toHaveLength(3);
      }
    },
  );

  it.each([
    {
      code: "outside-allowed-folders",
      reason: "Outside allowed folders",
      source: "/home/node/private/bootstrap-secret.mp3",
    },
    {
      code: "file-not-found",
      reason: "File not found",
      source: "/home/node/.openclaw/media/outbound/bootstrap-missing.mp3",
    },
  ] as const)("keeps server-rejected $code media blocked", async ({ code, reason, source }) => {
    const page = await newChatPage(suite);
    const requestedMediaUrls: URL[] = [];

    await page.route("**/__openclaw__/assistant-media?**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      requestedMediaUrls.push(url);
      expect(url.searchParams.get("source")).toBe(source);
      expect(url.searchParams.get("meta")).toBe("1");
      expect(request.headers().authorization).toBe("Bearer e2e-device-token");
      await route.fulfill({ json: { available: false, code, reason } });
    });

    await installMockGateway(page, {
      historyMessages: [
        chatMessage("assistant", `Unavailable recording\nMEDIA:${source}`, {
          id: `assistant-bootstrap-blocked-${code}`,
          timestamp: Date.now(),
        }),
      ],
    });

    await page.goto(`${suite.server.baseUrl}chat`);
    const status = page.locator(".chat-assistant-attachment-card__status-meta");
    await status.waitFor({ state: "visible", timeout: 10_000 });
    await expect.poll(() => status.textContent()).toContain(reason);
    expect(requestedMediaUrls).toHaveLength(1);
    expect(await page.locator(".chat-assistant-attachment-card audio").count()).toBe(0);
    expect(await page.locator(".chat-assistant-attachment-card__download").count()).toBe(0);
  });
});
