import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Locator } from "playwright";
import { expect, it } from "vitest";
import { waitForControlUiProofSurface } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  newChatPage,
  copiedViaExec,
  createChatFlowE2eSuite,
  installMockGateway,
  installPlainHttpClipboardCapture,
  waitForChatScrollIdle,
} from "./chat-flow.test-support.ts";
import { installAssistantMediaCacheMiss } from "./chat-media-http-cache.test-support.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";

const suite = createChatFlowE2eSuite();
const imageBody = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=",
  "base64",
);

const assistantHistory = (content: unknown) => [
  { role: "assistant", content, timestamp: Date.now() },
];

const imageWidths = (locator: Locator) =>
  locator.evaluateAll((images) =>
    images.map((image) =>
      image instanceof HTMLImageElement && image.complete ? image.naturalWidth : 0,
    ),
  );
const mediaTicket = (ticket: string) => ({
  available: true,
  mediaTicket: ticket,
  mediaTicketExpiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
});

const rectangle = (locator: Locator) =>
  locator.evaluate((element) => {
    const { x, y, width, height } = element.getBoundingClientRect();
    return { x, y, width, height };
  });

suite.define(() => {
  it("renders relative assistant media through the session-scoped ticket route", async () => {
    const page = await newChatPage(suite);
    const source = "openclaw/tmp/github-panel/v2-proof/github-pr-diff-light.png";
    const caption = "Browser proof from this task's workspace.";
    const imageBytes = await readFile(path.join(process.cwd(), "ui/public/apple-touch-icon.png"));
    const requests: URL[] = [];
    await page.route("**/__openclaw__/assistant-media?**", async (route) => {
      const url = new URL(route.request().url());
      requests.push(url);
      expect(url.searchParams.get("sessionKey")).toBe("agent:main:main");
      expect(url.searchParams.get("agentId")).toBe("main");
      if (url.searchParams.get("meta") === "1") {
        expect(route.request().headers().authorization).toBe("Bearer e2e-device-token");
        await route.fulfill({
          contentType: "application/json",
          body: JSON.stringify(
            url.searchParams.get("source") === source
              ? mediaTicket("ticket-relative-image")
              : { available: false, code: "file-not-found", reason: "File not found" },
          ),
        });
        return;
      }
      expect(url.searchParams.get("source")).toBe(source);
      expect(url.searchParams.get("mediaTicket")).toBe("ticket-relative-image");
      expect(route.request().headers().authorization).toBeUndefined();
      await route.fulfill({ contentType: "image/png", body: imageBytes });
    });
    await installMockGateway(page, {
      historyMessages: assistantHistory(`${caption}\n\nMEDIA:${source}\n\nMEDIA:missing.png`),
    });
    await page.goto(`${suite.server.baseUrl}chat`);
    await page.getByText(caption, { exact: false }).first().waitFor();
    const image = page.locator('img.chat-message-image[src*="github-pr-diff-light.png"]');
    await expect
      .poll(async () =>
        (await image.count()) === 1
          ? image.evaluate((element) =>
              element instanceof HTMLImageElement ? element.naturalWidth : 0,
            )
          : 0,
      )
      .toBeGreaterThan(0);
    await page.getByText("File not found", { exact: true }).waitFor();
    expect((await page.locator("body").textContent()) ?? "").not.toContain("MEDIA:");
    expect(requests.some((url) => url.searchParams.get("source") === "missing.png")).toBe(true);
  });

  it("exposes an assistant document download with its Unicode filename and ticketed URL", async () => {
    const page = await newChatPage(suite);
    const source = "/tmp/openclaw/测试 report.pdf";
    const mediaUrl = `/__openclaw__/assistant-media?source=${encodeURIComponent(source)}&mediaTicket=ticket-download`;
    await installMockGateway(page, {
      historyMessages: assistantHistory([
        { type: "text", text: "Your report is ready." },
        {
          type: "attachment",
          attachment: {
            kind: "document",
            label: "测试 report.pdf",
            mimeType: "application/pdf",
            url: mediaUrl,
          },
        },
      ]),
    });

    await page.goto(`${suite.server.baseUrl}chat`);
    const card = page
      .locator(".chat-assistant-attachment-card--compact")
      .filter({ hasText: "测试 report.pdf" });
    const link = card.locator(".chat-assistant-attachment-card__download");
    await link.waitFor({ state: "visible", timeout: 10_000 });
    expect(await link.getAttribute("href")).toBe(mediaUrl);
    await card.hover();
    const [download] = await Promise.all([page.waitForEvent("download"), link.click()]);
    expect(await download.failure()).toBeNull();

    expect(download.suggestedFilename()).toBe("测试 report.pdf");
  });

  it("renders a direct tool-result image from Gateway history", async () => {
    const page = await newChatPage(suite);
    const imageData =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+X3q8AAAAAElFTkSuQmCC";
    const gateway = await installMockGateway(page, {
      historyMessages: assistantHistory([
        { alt: "Tool result preview", data: imageData, mimeType: "image/png", type: "image" },
      ]),
    });

    await page.goto(`${suite.server.baseUrl}chat`);

    const image = page.getByAltText("Tool result preview");
    await image.waitFor({ state: "visible", timeout: 10_000 });
    expect(await image.getAttribute("src")).toBe(`data:image/png;base64,${imageData}`);
    await gateway.waitForRequest("sessions.messages.subscribe");
    await expect.poll(() => imageWidths(image)).toEqual([1]);
  });

  it("keeps managed document cards stable while their downloads become available", async () => {
    const page = await newChatPage(suite);
    const attachment = {
      artifactId: "artifact_managed_media_11111111-1111-4111-8111-111111111111",
      url: "/api/chat/media/outgoing/agent%3Amain%3Amain/11111111-1111-4111-8111-111111111111/full",
      kind: "document",
      label: "report.pdf",
      mimeType: "application/pdf",
      sizeBytes: 8_231,
    };
    const gateway = await installMockGateway(page, {
      heldMethods: ["artifacts.download"],
      historyMessages: assistantHistory([{ type: "attachment", attachment }]),
      methodResponses: {
        "artifacts.download": {
          artifact: {
            id: attachment.artifactId,
            type: "attachment",
            title: attachment.label,
            mimeType: attachment.mimeType,
            sizeBytes: attachment.sizeBytes,
            download: { mode: "url" },
          },
          url: `${attachment.url}?mediaTicket=ticket-document`,
          expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
        },
      },
    });

    await page.goto(`${suite.server.baseUrl}chat`);
    const cards = page.locator(".chat-assistant-attachment-card--compact");
    await cards.first().waitFor({ state: "visible", timeout: 10_000 });
    expect(await cards.count()).toBe(1);
    const downloads = cards.locator("a[download]");
    expect(await downloads.count()).toBe(1);
    expect(
      await downloads.evaluateAll((elements) =>
        elements.every(
          (element) =>
            !element.hasAttribute("href") &&
            element.getAttribute("aria-disabled") === "true" &&
            element.getAttribute("tabindex") === "0",
        ),
      ),
    ).toBe(true);
    expect(await cards.locator(".skeleton").count()).toBe(0);
    const pendingDownload = await downloads.first().elementHandle();
    expect(pendingDownload).not.toBeNull();
    await downloads.first().focus();
    // Ancestor entrance animations must settle before comparing viewport rectangles.
    const openButtons = cards.locator(".chat-assistant-attachment-card__expand");
    await waitForControlUiProofSurface(cards.first(), [openButtons.first()]);
    const pendingOpenSize = await rectangle(openButtons.first());
    expect(pendingOpenSize.height).toBeCloseTo(30, 3);
    const pendingActionWidths = await cards
      .locator(".chat-assistant-attachment-card__actions")
      .evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().width));
    expect(await page.getByText("Checking...", { exact: true }).count()).toBe(0);
    expect(((await page.locator("body").textContent()) ?? "").includes("MEDIA:")).toBe(false);

    await gateway.waitForRequest("artifacts.download");
    await gateway.resolveDeferred("artifacts.download");
    await expect.poll(() => cards.locator("a[download][href]").count()).toBe(1);
    expect(
      await downloads.evaluateAll((elements) =>
        elements.every((element) => !element.hasAttribute("aria-disabled")),
      ),
    ).toBe(true);
    expect(
      await downloads.first().evaluate((element, pending) => element === pending, pendingDownload),
    ).toBe(true);
    expect(await downloads.first().evaluate((element) => document.activeElement === element)).toBe(
      true,
    );
    expect(await cards.locator(".skeleton").count()).toBe(0);
    const openButtonSize = await rectangle(openButtons.first());
    for (const axis of ["x", "y", "width", "height"] as const) {
      expect(Math.abs(pendingOpenSize[axis] - openButtonSize[axis])).toBeLessThanOrEqual(0.5);
    }
    const finalActionWidths = await cards
      .locator(".chat-assistant-attachment-card__actions")
      .evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().width));
    expect(finalActionWidths).toHaveLength(pendingActionWidths.length);
    for (const [index, width] of finalActionWidths.entries()) {
      expect(Math.abs(width - (pendingActionWidths[index] ?? 0))).toBeLessThanOrEqual(0.5);
    }
    expect(await cards.locator(".chat-assistant-attachment-card__expand").count()).toBe(1);
    expect(await cards.locator(".chat-assistant-attachment-card__download").count()).toBe(1);
  });

  it.each([
    {
      name: "canonical inbound",
      boundedPreview: true,
      previewFails: false,
      source: "media://inbound/telegram-photo.png",
      workspaceDir: undefined,
    },
    {
      name: "sandbox-staged inbound",
      boundedPreview: false,
      previewFails: false,
      source: "/workspace/media/inbound/fabricated-sandbox.png",
      workspaceDir: "/workspace",
    },
    {
      name: "unavailable inbound preview",
      boundedPreview: true,
      source: "media://inbound/animated.png",
      workspaceDir: undefined,
      previewFails: true,
    },
  ] as const)(
    "renders a $name image through the ticketed media route",
    async ({ source, workspaceDir, previewFails, boundedPreview }) => {
      const page = await newChatPage(suite, {
        ...createControlUiE2eContextOptions(),
        ...(previewFails
          ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }
          : {}),
      });
      const requestedMediaUrls: URL[] = [];
      const originals = () =>
        requestedMediaUrls.filter(
          (url) => !url.searchParams.has("variant") && !url.searchParams.has("meta"),
        );
      await installAssistantMediaCacheMiss(page);
      await page.route("**/__openclaw__/assistant-media?**", async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        requestedMediaUrls.push(url);
        expect(url.searchParams.get("source")).toBe(source);
        if (url.searchParams.get("meta") === "1") {
          expect(request.headers().authorization).toBe("Bearer e2e-device-token");
          await route.fulfill({
            contentType: "application/json",
            body: JSON.stringify(mediaTicket("ticket-inbound")),
          });
          return;
        }
        expect(url.searchParams.get("mediaTicket")).toBe("ticket-inbound");
        expect(request.headers().authorization).toBeUndefined();
        if (previewFails && url.searchParams.get("variant") === "thumbnail") {
          await route.fulfill({ status: 404, body: "Not Found" });
          return;
        }
        await route.fulfill({
          contentType: "image/png",
          body: imageBody,
        });
      });
      await installMockGateway(page, {
        agentModel: "demo/model",
        models: [{ id: "model", name: "Demo", provider: "demo" }],
        historyMessages: [
          {
            id: "user-inbound-media-ref",
            role: "user",
            content: [{ type: "text", text: "🖼️ Attached image" }],
            __openclaw: {
              media: [
                {
                  path: source,
                  contentType: "image/png",
                  ...(previewFails ? { fileName: "Attached image.png" } : {}),
                  ...(workspaceDir ? { workspaceDir } : {}),
                },
              ],
            },
            timestamp: Date.now(),
          },
        ],
      });

      await page.goto(`${suite.server.baseUrl}chat`);
      await expect.poll(() => requestedMediaUrls.length, { timeout: 10_000 }).toBe(2);
      if (boundedPreview && !previewFails) {
        await expect
          .poll(() => page.evaluate(() => document.documentElement.dataset.mediaCacheRead))
          .toBe(
            JSON.stringify({
              cache: "only-if-cached",
              mode: "same-origin",
              credentials: "same-origin",
            }),
          );
      }
      if (previewFails) {
        const retry = page.getByRole("button", { name: "Retry", exact: true });
        await retry.waitFor();
        expect(await page.getByRole("button", { name: "Open original", exact: true }).count()).toBe(
          0,
        );
        expect(
          requestedMediaUrls
            .filter((url) => url.searchParams.get("meta") !== "1")
            .map((url) => url.searchParams.get("variant")),
        ).toEqual(["thumbnail"]);
        await retry.click();
        await expect
          .poll(
            () =>
              requestedMediaUrls.filter((url) => url.searchParams.get("variant") === "thumbnail")
                .length,
          )
          .toBe(2);
        await retry.waitFor();
        expect(originals()).toHaveLength(0);
        await page.getByRole("button", { name: "Image actions", exact: true }).click();
        await page.getByRole("menuitem", { name: "Copy image", exact: true }).waitFor();
        const download = page.waitForEvent("download");
        await page.getByRole("menuitem", { name: "Download image", exact: true }).click();
        expect((await download).suggestedFilename()).toBe("Attached image.png");
        expect(originals()).toHaveLength(1);
        expect(await page.locator("openclaw-image-lightbox").count()).toBe(0);
        return;
      }
      const image = page.locator("img.chat-message-image");
      await image.waitFor({ state: "visible", timeout: 10_000 });
      await expect.poll(() => imageWidths(image)).toEqual([1]);
      expect(requestedMediaUrls).toHaveLength(2);
      const previewRequest = requestedMediaUrls.find((url) => url.searchParams.get("meta") !== "1");
      expect(previewRequest?.searchParams.get("variant")).toBe(boundedPreview ? "thumbnail" : null);
      const inlineSource = await image.getAttribute("src");
      await page.getByRole("button", { name: /Open image/ }).click();
      const display = page.locator("openclaw-image-lightbox img").first();
      await display.waitFor({ state: "visible" });
      if (boundedPreview) {
        await expect.poll(() => display.getAttribute("src")).toContain("width=1920");
        expect(
          requestedMediaUrls.every(
            (url) =>
              url.searchParams.get("meta") === "1" ||
              url.searchParams.get("variant") === "thumbnail",
          ),
        ).toBe(true);
      } else {
        // Legacy local sources retain original bytes, without a second upgrade read.
        expect(await display.getAttribute("src")).toBe(
          new URL(inlineSource!, suite.server.baseUrl).href,
        );
        expect(requestedMediaUrls).toHaveLength(2);
        expect(requestedMediaUrls.every((url) => !url.searchParams.has("variant"))).toBe(true);
        expect(requestedMediaUrls.every((url) => !url.searchParams.has("width"))).toBe(true);
      }
    },
  );

  it("copies a code block over a non-secure context via the execCommand fallback", async () => {
    const page = await newChatPage(suite);
    // Simulate a plain-HTTP deployment where navigator.clipboard is unavailable.
    await installPlainHttpClipboardCapture(page);
    const code = "const hello = 1;";
    const gateway = await installMockGateway(page, {
      historyMessages: assistantHistory([
        {
          text: `${"long response line\n\n".repeat(80)}\`\`\`js\n${code}\n\`\`\``,
          type: "text",
        },
      ]),
    });

    await page.goto(`${suite.server.baseUrl}chat`);
    const copyButton = page.locator(".code-block-copy").first();
    await copyButton.waitFor({ timeout: 10_000 });
    await waitForChatScrollIdle(page);
    await copyButton.evaluate((element) => element.scrollIntoView({ block: "center" }));
    const thread = page.locator(".chat-thread");
    const scrollTopBefore = await thread.evaluate((element) =>
      Math.round((element as HTMLElement).scrollTop),
    );
    // The copied class clears after 1500ms, so click and read it in one browser step.
    const copied = await copyButton.evaluate(
      (element) =>
        new Promise<boolean>((resolve) => {
          const observer = new MutationObserver(() => {
            if (element.classList.contains("copied")) {
              observer.disconnect();
              resolve(true);
            }
          });
          observer.observe(element, { attributeFilter: ["class"], attributes: true });
          (element as HTMLButtonElement).click();
        }),
    );
    expect(copied).toBe(true);
    expect(await copiedViaExec(page)).toContain(code);
    await expect
      .poll(() => thread.evaluate((element) => Math.round((element as HTMLElement).scrollTop)))
      .toBe(scrollTopBefore);
    expect(await gateway.getRequests("chat.send")).toHaveLength(0);
  });
});
