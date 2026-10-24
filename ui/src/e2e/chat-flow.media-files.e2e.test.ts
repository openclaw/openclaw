import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Locator } from "playwright";
import { expect, it } from "vitest";
import { waitForControlUiProofSurface } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { selectFileAction } from "./chat-file-actions.test-support.ts";
import {
  newChatPage,
  copiedViaExec,
  createChatFlowE2eSuite,
  expectDefined,
  installMockGateway,
  installPlainHttpClipboardCapture,
  waitForChatScrollIdle,
} from "./chat-flow.test-support.ts";
import { openChatSidePanelType } from "./chat-side-panel.test-support.ts";
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
    await download.path();

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
    await gateway.waitForRequest("chat.startup");
    await expect.poll(() => imageWidths(image)).toEqual([1]);
  });

  it("shares a managed image across historical URLs through one artifact-scoped ticket", async () => {
    const page = await newChatPage(suite);
    const attachmentId = crypto.randomUUID();
    const artifactId = `artifact_managed_image_${attachmentId}`;
    const imageUrl = `/api/chat/media/outgoing/agent%3Amain%3Amain/${attachmentId}/full`;
    const ticketedUrl = `${imageUrl}?mediaTicket=ticket-e2e`;
    await page.route("**/api/chat/media/outgoing/**", async (route) => {
      const request = route.request();
      expect(new URL(request.url()).searchParams.get("mediaTicket")).toBe("ticket-e2e");
      expect(request.headers().authorization).toBeUndefined();
      await route.fulfill({
        contentType: "image/png",
        body: imageBody,
      });
    });
    const gateway = await installMockGateway(page, {
      historyMessages: assistantHistory(
        Array.from({ length: 3 }, (_, alias) => ({
          type: "image",
          artifactId,
          url: `${imageUrl}?mediaTicket=historical-${alias}`,
          alt: `Ticketed generated image ${alias + 1}`,
          mimeType: "image/png",
          width: 1,
          height: 1,
        })),
      ),
      methodResponses: {
        "artifacts.download": {
          artifact: {
            id: artifactId,
            type: "image",
            title: "Ticketed generated image",
            mimeType: "image/png",
            download: { mode: "url" },
          },
          url: ticketedUrl,
          expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
        },
      },
    });

    await page.goto(`${suite.server.baseUrl}chat`);
    const images = page.getByAltText(/^Ticketed generated image \d$/u);
    await expect.poll(() => images.count()).toBe(3);
    await expect.poll(() => imageWidths(images)).toEqual([1, 1, 1]);
    const request = await gateway.waitForRequest("artifacts.download");
    expect(request.params).toMatchObject({
      sessionKey: "agent:main:main",
      artifactId,
    });
    expect(await gateway.getRequests("artifacts.download")).toHaveLength(1);
  });

  it("keeps managed document cards stable while their downloads become available", async () => {
    const page = await newChatPage(suite);
    const attachments = (
      [
        ["11111111-1111-4111-8111-111111111111", "report.pdf", "application/pdf", 8_231],
        ["22222222-2222-4222-8222-222222222222", "table.csv", "text/csv", 2_774],
        ["33333333-3333-4333-8333-333333333333", "notes.txt", "text/plain", 981],
        ["44444444-4444-4444-8444-444444444444", "bundle.zip", "application/zip", 42_831],
      ] as const
    ).map(([id, label, mimeType, sizeBytes]) => ({
      artifactId: `artifact_managed_media_${id}`,
      url: `/api/chat/media/outgoing/agent%3Amain%3Amain/${id}/full`,
      kind: "document",
      label,
      mimeType,
      sizeBytes,
    }));
    const methodCases = attachments.map((attachment) => {
      const id = attachment.artifactId.slice("artifact_managed_media_".length);
      return {
        match: { artifactId: attachment.artifactId, sessionKey: "agent:main:main" },
        response: {
          artifact: {
            id: attachment.artifactId,
            type: "attachment",
            title: attachment.label,
            mimeType: attachment.mimeType,
            sizeBytes: attachment.sizeBytes,
            download: { mode: "url" },
          },
          url: `/api/chat/media/outgoing/agent%3Amain%3Amain/${id}/full?mediaTicket=ticket-${id}`,
          expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
        },
      };
    });
    const gateway = await installMockGateway(page, {
      heldMethods: ["artifacts.download"],
      historyMessages: assistantHistory(
        attachments.map((attachment) => ({ type: "attachment", attachment })),
      ),
      methodResponses: {
        "artifacts.download": { cases: methodCases },
      },
    });

    await page.goto(`${suite.server.baseUrl}chat`);
    const cards = page.locator(".chat-assistant-attachment-card--compact");
    await cards.first().waitFor({ state: "visible", timeout: 10_000 });
    expect(await cards.count()).toBe(4);
    const downloads = cards.locator("a[download]");
    expect(await downloads.count()).toBe(4);
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

    await gateway.waitForRequest("artifacts.download", { after: attachments.length - 1 });
    await gateway.resolveDeferred("artifacts.download");
    await expect.poll(() => cards.locator("a[download][href]").count()).toBe(4);
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
    for (const attachment of attachments) {
      const card = page
        .locator(".chat-assistant-attachment-card--compact")
        .filter({ hasText: attachment.label });
      expect(await card.count()).toBe(1);
      expect(await card.locator(".chat-assistant-attachment-card__expand").count()).toBe(1);
      expect(await card.locator(".chat-assistant-attachment-card__download").count()).toBe(1);
    }
    expect(((await page.locator("body").textContent()) ?? "").includes("MEDIA:")).toBe(false);
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

  it("evicts and refetches managed image Blob URLs after the cache reaches capacity", async () => {
    const page = await newChatPage(suite);
    await page.addInitScript(() => {
      const originalCreateObjectURL = URL.createObjectURL.bind(URL);
      const originalRevokeObjectURL = URL.revokeObjectURL.bind(URL);
      const proof = { created: [] as string[], revoked: [] as string[] };
      Object.defineProperty(globalThis, "managedImageCacheProof", {
        configurable: true,
        value: proof,
      });
      Object.defineProperty(URL, "createObjectURL", {
        configurable: true,
        value: (blob: Blob) => {
          const blobUrl = originalCreateObjectURL(blob);
          proof.created.push(blobUrl);
          return blobUrl;
        },
      });
      Object.defineProperty(URL, "revokeObjectURL", {
        configurable: true,
        value: (blobUrl: string) => {
          proof.revoked.push(blobUrl);
          originalRevokeObjectURL(blobUrl);
        },
      });
    });

    const imageUrls = Array.from({ length: 65 }, (_, index) => {
      const id = String(index + 1).padStart(12, "0");
      return `/api/chat/media/outgoing/agent%3Amain%3Amain/00000000-0000-4000-8000-${id}/full`;
    });
    const fetchedMedia: Array<{
      authorization: string | undefined;
      pathname: string;
      requesterSessionKey: string | undefined;
    }> = [];
    await page.route("**/api/chat/media/outgoing/**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      fetchedMedia.push({
        authorization: request.headers().authorization,
        pathname: url.pathname,
        requesterSessionKey: request.headers()["x-openclaw-requester-session-key"],
      });
      await route.fulfill({
        body: imageBody,
        contentType: "image/png",
      });
    });

    const historyFor = (indexes: number[], labelPrefix: string) =>
      assistantHistory(
        indexes.map((index) => ({
          alt: `${labelPrefix} ${index + 1}`,
          type: "image",
          url: imageUrls[index],
        })),
      );
    const gateway = await installMockGateway(page, {
      historyMessages: historyFor(
        Array.from({ length: 64 }, (_, index) => index),
        "Initial managed image",
      ),
    });
    const readBlobProof = () =>
      page.evaluate(() => {
        const proof = (
          globalThis as typeof globalThis & {
            managedImageCacheProof: { created: string[]; revoked: string[] };
          }
        ).managedImageCacheProof;
        return { created: [...proof.created], revoked: [...proof.revoked] };
      });
    let proofMessageSequence = 100;
    const replaceHistory = async (index: number, label: string) => {
      const messages = historyFor([index], label);
      const historyRequestsBefore = (await gateway.getRequests("chat.history")).length;
      await gateway.setHistoryMessages(messages);
      proofMessageSequence += 1;
      await gateway.emitGatewayEvent("session.message", {
        activeRunIds: [],
        hasActiveRun: false,
        message: messages[0],
        messageId: `managed-image-cache-proof-${proofMessageSequence}`,
        messageSeq: proofMessageSequence,
        session: {
          activeRunIds: [],
          hasActiveRun: false,
          key: "main",
          kind: "direct",
          status: "done",
          updatedAt: Date.now(),
        },
        sessionKey: "main",
      });
      await expect
        .poll(async () => (await gateway.getRequests("chat.history")).length, {
          timeout: 15_000,
        })
        .toBeGreaterThan(historyRequestsBefore);
      await page
        .getByAltText(`${label} ${index + 1}`)
        .waitFor({ state: "visible", timeout: 10_000 });
    };

    await page.goto(`${suite.server.baseUrl}chat`);
    await gateway.waitForRequest("chat.startup");
    const frames = page.locator(".chat-image-frame");
    await expect.poll(() => frames.count()).toBe(64);
    for (const frame of await frames.all()) {
      await frame.scrollIntoViewIfNeeded();
    }
    await expect.poll(async () => (await readBlobProof()).created.length).toBe(64);
    const images = page.locator("img.chat-message-image");
    await expect.poll(() => imageWidths(images)).toEqual(Array(64).fill(1));
    const initialBlobUrls = await images.evaluateAll((nodes) =>
      nodes.map((image) => image.getAttribute("src")),
    );
    const retainedRecentBlobUrl = expectDefined(
      initialBlobUrls[0],
      "recent managed image Blob URL",
    );

    await replaceHistory(0, "Recently viewed managed image");
    expect((await readBlobProof()).created).toHaveLength(64);

    await replaceHistory(64, "Overflow managed image");
    await expect.poll(async () => (await readBlobProof()).created.length).toBe(65);
    const overflowProof = await readBlobProof();
    // Concurrent image fetches can resolve in any order. Find the real LRU
    // rather than assuming that creation order matches transcript order.
    expect(overflowProof.revoked).toHaveLength(1);
    const evictedBlobUrl = expectDefined(
      overflowProof.revoked.find((blobUrl) => blobUrl !== retainedRecentBlobUrl),
      "evicted managed image Blob URL",
    );
    expect(overflowProof.created).toContain(evictedBlobUrl);
    const evictedImageIndex = initialBlobUrls.indexOf(evictedBlobUrl);
    expect(evictedImageIndex).toBeGreaterThanOrEqual(0);
    expect(overflowProof.revoked).not.toContain(retainedRecentBlobUrl);

    const evictedUrl = new URL(
      expectDefined(imageUrls[evictedImageIndex], "evicted managed image URL"),
      suite.server.baseUrl,
    );
    const evictedPath = evictedUrl.pathname.replace(/\/full$/u, "/thumbnail");
    const fetchesBeforeRevisit = fetchedMedia.filter(
      (request) => request.pathname === evictedPath,
    ).length;
    const revisitedImageAlt = `Refetched managed image ${evictedImageIndex + 1}`;
    await replaceHistory(evictedImageIndex, "Refetched managed image");
    const revisitedImage = page.getByAltText(revisitedImageAlt);
    await expect.poll(() => imageWidths(revisitedImage)).toEqual([1]);
    await expect.poll(async () => (await readBlobProof()).created.length).toBe(66);
    const evictedImageFetches = fetchedMedia.filter(
      (request) => request.pathname === evictedPath,
    ).length;
    expect(evictedImageFetches).toBe(fetchesBeforeRevisit + 1);
    expect(fetchedMedia).not.toHaveLength(0);
    for (const request of fetchedMedia) {
      expect(request).toMatchObject({
        authorization: "Bearer e2e-device-token",
        requesterSessionKey: "agent:main:main",
      });
    }
  });

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

  it("copies a workspace file path over a non-secure context via the execCommand fallback", async () => {
    const page = await newChatPage(suite);
    await installPlainHttpClipboardCapture(page);
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "artifacts.list": { artifacts: [] },
        "sessions.files.get": {
          root: "/workspace",
          file: {
            name: "AGENTS.md",
            path: "/workspace/AGENTS.md",
            previewKind: "text",
            contentEncoding: "utf8",
            content: "# Workspace instructions",
          },
        },
        "sessions.files.list": {
          browser: { entries: [], path: "" },
          files: [
            {
              kind: "modified",
              missing: false,
              name: "AGENTS.md",
              path: "/workspace/AGENTS.md",
              size: 2048,
            },
          ],
          root: "/workspace",
          sessionKey: "main",
        },
      },
    });

    await page.goto(`${suite.server.baseUrl}chat`);
    await openChatSidePanelType(page, "Files");
    await page
      .locator(".workspace-desktop")
      .getByRole("button", {
        name: "/workspace/AGENTS.md",
        exact: true,
      })
      .click();
    const panel = page.locator("openclaw-chat-detail-panel:visible");
    await panel.locator(".sidebar-file-view").waitFor();
    await selectFileAction(panel, "Copy path");

    expect(await copiedViaExec(page)).toContain("/workspace/AGENTS.md");
    expect(await gateway.getRequests("sessions.files.list")).toHaveLength(1);
    expect(await gateway.getRequests("sessions.files.get")).toHaveLength(1);
    expect(await gateway.getRequests("chat.send")).toHaveLength(0);
  });
});
