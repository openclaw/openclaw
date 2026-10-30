import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { mediaTicketPayload } from "../test-helpers/control-ui-attachment-fixtures.ts";
import { chatMessage } from "./chat-flow.test-support.ts";
import {
  createControlUiE2eContextOptions,
  tooltipTitleText,
} from "./control-ui-e2e-suite.test-support.ts";
import {
  ONE_PIXEL_PNG_B64,
  LOCAL_GIT_WORKSPACE_RESPONSES,
  controlUiSessionPath,
  createNewSessionPageE2eSuite,
  createdSessionListResult,
  expectDecodedThumbnail,
  installMockGateway,
  navigateInApp,
  pastePng,
  pollCount,
  pollEnabled,
  pollDisabled,
  pollAttribute,
  pollLocatorText,
  pollValue,
  waitForCommittedChatRoute,
  waitForCommittedNewSessionDraft,
} from "./new-session-page.test-support.ts";
import { sessionList } from "./new-session-shard.test-support.ts";
import { waitForCommittedComposerDraft } from "./settle.test-support.ts";

const suite = createNewSessionPageE2eSuite();
const pngAttachment = { fileName: "pixel.png", content: ONE_PIXEL_PNG_B64 };

function initialPromptResponses(sessionKey: string, runId: string, sessionId: string) {
  return {
    "sessions.create": { key: sessionKey, runId, runStarted: true, messageSeq: 1 },
    "sessions.list": createdSessionListResult(sessionKey),
    "chat.startup": {
      messages: [],
      sessionId,
      sessionInfo: { hasActiveRun: true, key: sessionKey, status: "running" },
    },
  };
}

async function startPrompt(page: Page, message: string, sessionKey: string) {
  await page.goto(`${suite.server.baseUrl}new`);
  await page.locator(".new-session-page__message").fill(message);
  await page.getByRole("button", { name: "Start session" }).click();
  await page.waitForURL((url) => url.pathname === controlUiSessionPath(sessionKey), {
    timeout: 30_000,
  });
}

async function expectRejectedTurn(page: Page, message: string, error: string) {
  const group = page.locator(".chat-group.user", { hasText: message });
  const status = group.locator(".chat-send-status");
  await group.waitFor({ state: "visible", timeout: 30_000 });
  expect(await status.textContent()).toContain("Not sent");
  await expect.poll(() => tooltipTitleText(status)).toBe(error);
}

async function withNewSessionPage(run: (page: Page) => Promise<void>): Promise<void> {
  await suite.withPage(createControlUiE2eContextOptions(), ({ page }) => run(page));
}

suite.define(() => {
  it("restores a prompt, image and permission choice, then clears them after creation", async () => {
    const context = await suite.browser.newContext(createControlUiE2eContextOptions());
    try {
      const firstPage = await context.newPage();
      await installMockGateway(firstPage);
      await firstPage.goto(`${suite.server.baseUrl}new`);
      const firstMessage = firstPage.locator(".new-session-page__message");
      await firstMessage.fill("restore this prompt after restart");
      await pastePng(firstMessage);
      await firstPage.locator('.chat-attachment-thumb img[alt="pixel.png"]').waitFor();
      const incognito = firstPage.getByRole("switch", { name: "Incognito" });
      await incognito.click();
      await pollAttribute(incognito, "aria-checked").toBe("true");
      await waitForCommittedNewSessionDraft(firstPage, null, 0);
      await incognito.click();
      await pollAttribute(incognito, "aria-checked").toBe("false");
      await firstMessage.fill("restore this prompt after restart and incognito");
      await pollCount(firstPage.locator(".chat-attachment-thumb")).toBe(1);
      await waitForCommittedNewSessionDraft(
        firstPage,
        "restore this prompt after restart and incognito",
        1,
      );
      const permission = firstPage.locator('[data-chat-permission-select="true"]');
      await permission.click();
      await firstPage.locator('[data-chat-permission-option="read-only"]').click();
      await pollAttribute(permission, "data-chat-select-value").toBe("read-only");
      await firstPage.reload();
      await pollAttribute(permission, "data-chat-select-value").toBe("read-only");
      await pollValue(firstMessage).toBe("restore this prompt after restart and incognito");
      await pollCount(firstPage.locator(".chat-attachment-thumb")).toBe(1);
      await firstPage.close();

      const restoredPage = await context.newPage();
      const restoredGateway = await installMockGateway(restoredPage, {
        methodResponses: {
          "sessions.create": { key: "agent:main:restart-draft", runStarted: true },
        },
      });
      await restoredPage.goto(`${suite.server.baseUrl}new`);
      const restoredMessage = restoredPage.locator(".new-session-page__message");
      await pollValue(restoredMessage).toBe("restore this prompt after restart and incognito");
      await pollCount(restoredPage.locator(".chat-attachment-thumb")).toBe(1);
      await pollAttribute(
        restoredPage.locator('[data-chat-permission-select="true"]'),
        "data-chat-select-value",
      ).toBe("read-only");
      await restoredPage.getByRole("button", { name: "Start session" }).click();

      const create = await restoredGateway.waitForRequest("sessions.create");
      expect(create.params).toMatchObject({
        message: "restore this prompt after restart and incognito",
        permissionMode: "read-only",
        attachments: [{ ...pngAttachment, type: "image", mimeType: "image/png" }],
      });
      await restoredPage.waitForURL(
        (url) => url.pathname === controlUiSessionPath("agent:main:restart-draft"),
      );
      // Chat admission precedes durable cleanup; keep its document alive until retirement commits.
      await waitForCommittedComposerDraft(restoredPage, JSON.stringify(["", "", ""]), null, 0);
      await restoredPage.close();

      const clearedPage = await context.newPage();
      await installMockGateway(clearedPage);
      await clearedPage.goto(`${suite.server.baseUrl}new`);
      await pollValue(clearedPage.locator(".new-session-page__message")).toBe("");
      await pollCount(clearedPage.locator(".chat-attachment-thumb")).toBe(0);
      await pollAttribute(
        clearedPage.locator('[data-chat-permission-select="true"]'),
        "data-chat-select-value",
      ).toBe("");
    } finally {
      await context.close();
    }
  });

  it("grows the first prompt downward to twelve lines, then scrolls internally", async () => {
    await withNewSessionPage(async (page) => {
      const gateway = await installMockGateway(page);
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.goto(`${suite.server.baseUrl}new`);
      const message = page.locator(".new-session-page__message");
      await message.waitFor();

      const identity = page.locator(
        ".agent-chat__welcome-clawd, .agent-chat__welcome-avatar, .agent-chat__avatar--text",
      );
      const triggers = page.locator(".new-session-page__triggers");
      const composer = page.locator(".new-session-page__composer");
      const [identityBox, triggersBox, composerBox] = await Promise.all([
        identity.boundingBox(),
        triggers.boundingBox(),
        composer.boundingBox(),
      ]);
      expect([identityBox, triggersBox, composerBox]).not.toContain(null);

      const initial = await message.evaluate((element) => ({
        height: element.clientHeight,
        overflowY: getComputedStyle(element).overflowY,
      }));
      await message.fill(Array.from({ length: 10 }, (_, index) => `line ${index + 1}`).join("\n"));
      const tenLines = await message.evaluate((element) => {
        const style = getComputedStyle(element);
        return {
          height: element.clientHeight,
          scrollHeight: element.scrollHeight,
          viewportHeight: element.ownerDocument.defaultView!.innerHeight,
          lineHeight: Number.parseFloat(style.lineHeight),
          overflowY: style.overflowY,
          padding: Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom),
        };
      });

      expect(tenLines.height).toBeGreaterThan(initial.height);
      expect(tenLines.height).toBeGreaterThanOrEqual(
        Math.floor(tenLines.lineHeight * 10 + tenLines.padding) - 1,
      );
      expect(tenLines.scrollHeight).toBe(tenLines.height);
      expect(tenLines.overflowY).toBe("hidden");

      // More text than even the whole viewport can hold must exceed the pane budget.
      const overflowLines = Math.ceil(tenLines.viewportHeight / tenLines.lineHeight) + 1;
      const longPrompt = Array.from(
        { length: overflowLines },
        (_, index) => `line ${index + 1}`,
      ).join("\n");
      await message.fill(longPrompt);
      // Classic scrollbars retain their gutter at the cap to prevent draft-height oscillation.
      await expect
        .poll(() => message.evaluate((element) => getComputedStyle(element).overflowY))
        .toBe("scroll");
      const capped = await message.evaluate((element) => ({
        clientHeight: element.clientHeight,
        scrollHeight: element.scrollHeight,
      }));
      const [expandedIdentityBox, expandedTriggersBox, expandedComposerBox] = await Promise.all([
        identity.boundingBox(),
        triggers.boundingBox(),
        composer.boundingBox(),
      ]);
      expect(capped.clientHeight).toBeCloseTo(tenLines.lineHeight * 12 + tenLines.padding, 0);
      expect(capped.clientHeight).toBeLessThan(tenLines.viewportHeight);
      expect(capped.clientHeight).toBeLessThan(capped.scrollHeight);
      // Browser subpixel rounding may shift stable blocks by a pixel; larger movement is visible.
      for (const [before, after] of [
        [identityBox, expandedIdentityBox],
        [triggersBox, expandedTriggersBox],
        [composerBox, expandedComposerBox],
      ]) {
        expect(Math.abs((after?.y ?? 0) - (before?.y ?? 0))).toBeLessThanOrEqual(2);
      }
      const start = page.getByRole("button", { name: "Start session" });
      await expect(start.isVisible()).resolves.toBe(true);
      await expect(start.isEnabled()).resolves.toBe(true);
      await start.focus();
      await expect(start.evaluate((element) => document.activeElement === element)).resolves.toBe(
        true,
      );
      await start.press("Enter");
      await expect(gateway.waitForRequest("sessions.create")).resolves.toMatchObject({
        params: { message: longPrompt },
      });
    });
  });

  it("enlarges and removes a picked image without object URL support", async () => {
    await withNewSessionPage(async (page) => {
      await page.addInitScript(() => {
        Object.defineProperty(URL, "createObjectURL", { configurable: true, value: undefined });
      });
      await installMockGateway(page);
      await page.goto(`${suite.server.baseUrl}new`);

      await page
        .locator(".agent-chat__photo-input")
        .setInputFiles(path.join(process.cwd(), "ui/public/favicon-32.png"));

      const attachment = page.locator(".chat-attachment-thumb");
      const preview = attachment.getByRole("img", { name: "favicon-32.png" });
      const previewButton = page.getByRole("button", { name: "Open image favicon-32.png" });
      await preview.waitFor({ state: "visible" });
      await pollAttribute(preview, "src").toMatch(/^data:image\/png;base64,/u);
      await previewButton.click();
      const lightbox = page.locator("openclaw-image-lightbox");
      const dialog = page.getByRole("dialog", { name: "Image preview: favicon-32.png" });
      await dialog.waitFor({ state: "visible" });
      await expect(lightbox.getAttribute("title")).resolves.toBeNull();
      await page.getByAltText("favicon-32.png").last().waitFor({ state: "visible" });
      await page.keyboard.press("Escape");
      await lightbox.waitFor({ state: "detached" });
      await previewButton.press("Enter");
      await dialog.waitFor({ state: "visible" });
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: "Remove favicon-32.png" }).click();
      await pollCount(attachment).toBe(0);
    });
  });

  it("keeps blob-backed SVG previews out of original-document navigation", async () => {
    await withNewSessionPage(async (page) => {
      await installMockGateway(page);
      await page.goto(`${suite.server.baseUrl}new`);

      await page.locator(".agent-chat__photo-input").setInputFiles({
        name: "untrusted.svg",
        mimeType: "image/svg+xml",
        buffer: Buffer.from(
          "<svg xmlns='http://www.w3.org/2000/svg'><rect width='1' height='1'/></svg>",
        ),
      });

      const previewButton = page.getByRole("button", { name: "Open image untrusted.svg" });
      await pollAttribute(previewButton.locator("img"), "src").toMatch(/^blob:/u);
      await previewButton.click();
      await page.getByRole("dialog", { name: "Image preview: untrusted.svg" }).waitFor();
      await expect(page.getByRole("link", { name: "Open in new tab" }).count()).resolves.toBe(0);
    });
  });

  it("shows the initial prompt while the newly created session is still running", async () => {
    await withNewSessionPage(async (page) => {
      const sessionKey = "agent:main:visible-initial-prompt";
      const message = "keep this prompt visible while the agent works";
      const activeOutputTimestamp = Date.now() + 60_000;
      const responses = initialPromptResponses(
        sessionKey,
        "visible-initial-run",
        "visible-initial-prompt",
      );
      const gateway = await installMockGateway(page, {
        methodResponses: {
          ...responses,
          "chat.startup": {
            ...responses["chat.startup"],
            messages: [
              {
                role: "assistant",
                content: [
                  {
                    type: "toolCall",
                    id: "active-tool-call",
                    name: "read",
                    arguments: { path: "SKILL.md" },
                  },
                ],
                timestamp: activeOutputTimestamp,
                __openclaw: { id: "active-assistant", seq: 2 },
              },
              {
                role: "toolResult",
                toolCallId: "active-tool-call",
                toolName: "read",
                content: [{ type: "text", text: "working" }],
                timestamp: activeOutputTimestamp + 1,
                __openclaw: { id: "active-tool-result", seq: 3 },
              },
            ],
          },
        },
      });
      await startPrompt(page, message, sessionKey);
      await gateway.waitForRequest("sessions.messages.subscribe");
      await page.getByText("SKILL.md", { exact: true }).waitFor();

      await pollLocatorText(page.locator(".chat-group.user")).toContain(message);
      const userRow = await page.locator(".chat-group.user").boundingBox();
      const toolRow = await page.getByText("SKILL.md", { exact: true }).boundingBox();
      if (!userRow || !toolRow) {
        throw new Error("expected visible prompt and tool rows");
      }
      expect(userRow.y).toBeLessThan(toolRow.y);
    });
  });

  it("keeps the initial prompt visible across a Gateway reconnect", async () => {
    await withNewSessionPage(async (page) => {
      const sessionKey = "agent:main:reconnected-initial-prompt";
      const message = "keep this first prompt through reconnect";
      const gateway = await installMockGateway(page, {
        methodResponses: initialPromptResponses(
          sessionKey,
          "reconnected-initial-run",
          "reconnected-initial-prompt",
        ),
      });
      await startPrompt(page, message, sessionKey);
      await gateway.waitForRequest("sessions.messages.subscribe");
      await pollLocatorText(page.locator(".chat-group.user")).toContain(message);

      const socketsBeforeReconnect = await gateway.getSocketCount();
      await gateway.setOnline(false);
      await expect
        .poll(() => gateway.getSocketCount(), { timeout: 10_000 })
        .toBeGreaterThan(socketsBeforeReconnect);
      await gateway.setOnline(true);
      await expect
        .poll(() => page.evaluate(() => window.openclawControlUi?.snapshot().gatewayPhase))
        .toBe("connected");
      await pollLocatorText(page.locator(".chat-group.user")).toContain(message);
      await pollCount(page.locator(".chat-group.user")).toBe(1);
    });
  });

  it("keeps an initial image visible through worktree hydration and canonical history", async () => {
    await withNewSessionPage(async (page) => {
      const sessionKey = "agent:main:single-image-prompt";
      const runId = "initial-image-send";
      const message = "testing if dual prompts show";
      const source = "media://inbound/initial-prompt.png";
      const imageBytes = await readFile(path.join(process.cwd(), "ui/public/apple-touch-icon.png"));
      const { promise: mediaGate, resolve: releaseMedia } = createDeferred();
      let metadataRequested = false;
      await page.route("**/__openclaw__/assistant-media?**", async (route) => {
        const url = new URL(route.request().url());
        expect(url.searchParams.get("source")).toBe(source);
        const metadata = url.searchParams.get("meta") === "1";
        metadataRequested ||= metadata;
        await mediaGate;
        await route.fulfill(
          metadata
            ? {
                json: mediaTicketPayload("initial-prompt-ticket", 5 * 60_000),
              }
            : { contentType: "image/png", body: imageBytes },
        );
      });
      const authoritative = chatMessage("user", message, {
        timestamp: Date.now(),
        __openclaw: {
          id: "persisted-image-prompt",
          idempotencyKey: `${runId}:user`,
          seq: 1,
          media: [{ path: source, contentType: "image/png", fileName: "pixel.png" }],
          mediaImageLayout: { slots: [{ kind: "inline", factIndex: 0 }] },
        },
      });
      const responses = initialPromptResponses(sessionKey, runId, "single-image-prompt");
      const gateway = await installMockGateway(page, {
        subscriptionInitialHistory: false,
        deferredMethods: ["chat.startup"],
        methodResponses: {
          ...responses,
          "sessions.create": {
            ...responses["sessions.create"],
            entry: { sessionId: "single-image-prompt" },
          },
          "chat.startup": {
            ...responses["chat.startup"],
            messages: [authoritative],
            sessionInfo: {
              ...responses["chat.startup"].sessionInfo,
              activeRunIds: [runId],
            },
          },
        },
      });
      try {
        await page.goto(`${suite.server.baseUrl}new`);
        const composer = page.locator(".new-session-page__message");
        await composer.fill(message);
        await page.locator(".agent-chat__file-input").setInputFiles({
          name: "pixel.png",
          mimeType: "image/png",
          buffer: imageBytes,
        });
        await page.getByRole("button", { name: "Start session" }).click();
        await page.waitForURL((url) => url.pathname === controlUiSessionPath(sessionKey), {
          timeout: 30_000,
        });
        await gateway.waitForRequest("chat.startup");

        const userRow = page.locator(".chat-group.user");
        const userImage = userRow.locator("img.chat-message-image");
        await pollCount(userRow).toBe(1);
        await pollCount(userImage).toBe(1);
        await pollAttribute(userImage, "src").toMatch(/^data:image\/png;base64,/u);
        await expectDecodedThumbnail(userImage, 180);
        const initialImageSrc = await userImage.getAttribute("src");
        const initialImageAlt = await userImage.getAttribute("alt");
        const captureThumbnail = () => userImage.screenshot({ animations: "disabled" });
        const initialPixels = await captureThumbnail();
        await userImage.evaluate((image) => image.setAttribute("data-initial-image-node", "true"));
        const expectStablePixels = async () => {
          expect((await captureThumbnail()).equals(initialPixels)).toBe(true);
          expect(await userRow.locator('[aria-busy="true"]').count()).toBe(0);
        };
        await pollLocatorText(userRow).toContain(message);
        await pollLocatorText(userRow).not.toContain("Attached image");

        const promptBubbles = page.locator(".chat-bubble").filter({ hasText: message });
        const durableBubble = page.locator('.chat-bubble[data-entry-id="persisted-image-prompt"]');
        await pollCount(promptBubbles).toBe(1);
        await gateway.emitGatewayEvent("session.message", {
          activeRunIds: [runId],
          clientRunId: runId,
          hasActiveRun: true,
          message: authoritative,
          messageId: "persisted-image-prompt",
          messageSeq: 1,
          session: {
            activeRunIds: [runId],
            hasActiveRun: true,
            key: sessionKey,
            kind: "direct",
            status: "running",
            updatedAt: Date.now(),
          },
          sessionKey,
        });
        await durableBubble.waitFor({ timeout: 10_000 });
        await pollCount(durableBubble).toBe(1);
        await pollCount(promptBubbles).toBe(1);
        await expect.poll(() => metadataRequested).toBe(true);
        await pollAttribute(userImage, "data-initial-image-node").toBe("true");
        await pollAttribute(userImage, "src").toBe(initialImageSrc);
        await expectStablePixels();

        const worktreeSession = {
          key: sessionKey,
          sessionId: "single-image-prompt",
          displayName: "Image handoff worktree",
          kind: "direct",
          updatedAt: Date.now(),
          activeRunIds: [runId],
          hasActiveRun: true,
          status: "running",
          permissionMode: "workspace",
          sessionRoot: "/workspace/image-handoff",
          spawnedCwd: "/workspace/image-handoff",
          worktree: {
            id: "image-handoff-worktree",
            branch: "image-handoff",
            repoRoot: "/workspace/project",
          },
        };
        await gateway.setMethodResponse("sessions.list", {
          ...createdSessionListResult(sessionKey),
          sessions: [worktreeSession],
        });
        await gateway.emitGatewayEvent("sessions.changed", {
          sessionKey,
          sessionId: worktreeSession.sessionId,
          reason: "project",
          session: worktreeSession,
        });
        await pollLocatorText(page.locator(".chat-pane__session-title-text")).toBe(
          worktreeSession.displayName,
        );
        expect(await userImage.getAttribute("data-initial-image-node")).toBe("true");
        expect(await userImage.getAttribute("src")).toBe(initialImageSrc);
        await expectStablePixels();

        await gateway.resolveDeferred("chat.startup");

        await pollCount(userRow).toBe(1);
        await pollCount(userImage).toBe(1);
        await pollAttribute(userImage, "data-initial-image-node").toBe("true");
        await pollAttribute(userImage, "src").toBe(initialImageSrc);
        await pollCount(promptBubbles).toBe(1);
        await pollCount(durableBubble).toBe(1);
        await pollLocatorText(userRow).toContain(message);
        await pollLocatorText(userRow).not.toContain("Attached image");
        releaseMedia();
        await pollAttribute(userImage, "src").toContain("initial-prompt-ticket");
        await expectDecodedThumbnail(userImage, 180);
        expect(await userImage.getAttribute("data-initial-image-node")).toBe("true");
        expect((await captureThumbnail()).equals(initialPixels)).toBe(true);
        await userRow.locator(".chat-message-image-button").click();
        const lightbox = page.locator("openclaw-image-lightbox");
        const dialog = lightbox.getByRole("dialog");
        await dialog.waitFor({ state: "visible" });
        expect(initialImageAlt).toBe("pixel.png");
        expect(await userImage.getAttribute("alt")).toBe("pixel.png");
        expect(await dialog.getAttribute("aria-label")).toBe("Image preview: pixel.png");
      } finally {
        releaseMedia();
      }
    });
  });

  it("waits for pasted image reads before enabling session creation", async () => {
    await withNewSessionPage(async (page) => {
      await page.addInitScript(() => {
        const readAsDataUrl = Object.getOwnPropertyDescriptor(FileReader.prototype, "readAsDataURL")
          ?.value as FileReader["readAsDataURL"];
        FileReader.prototype.readAsDataURL = function (blob: Blob) {
          (globalThis as unknown as { finishPastedImageRead?: () => void }).finishPastedImageRead =
            () => readAsDataUrl.call(this, blob);
        };
      });
      const gateway = await installMockGateway(page, {
        methodResponses: {
          "sessions.create": { key: "agent:main:delayed-image-draft", runStarted: true },
        },
      });
      await page.goto(`${suite.server.baseUrl}new`);
      const composer = page.locator(".new-session-page__message");
      const submit = page.getByRole("button", { name: "Start session" });
      await composer.fill("include the image that is still loading");
      await pastePng(composer);

      await pollDisabled(submit).toBe(true);
      expect(await gateway.getRequests("sessions.create")).toHaveLength(0);
      await page.evaluate(() => {
        const finish = (globalThis as unknown as { finishPastedImageRead?: () => void })
          .finishPastedImageRead;
        if (!finish) {
          throw new Error("Pasted image read was not started");
        }
        finish();
      });

      await page.getByRole("img", { name: "pixel.png" }).waitFor();
      await pollEnabled(submit).toBe(true);
      await submit.click();
      const create = await gateway.waitForRequest("sessions.create");
      expect(create.params).toMatchObject({
        message: "include the image that is still loading",
        attachments: [pngAttachment],
      });
    });
  });

  it("retains a completed file when the rest of its pasted batch is aborted", async () => {
    type PasteProof = {
      reads: number;
      loaded: number;
      aborts: number;
      created: number;
      revoked: number;
    };
    await withNewSessionPage(async (page) => {
      await page.addInitScript(() => {
        const readAsDataUrl = Reflect.get(
          FileReader.prototype,
          "readAsDataURL",
        ) as FileReader["readAsDataURL"];
        const abort = Reflect.get(FileReader.prototype, "abort") as FileReader["abort"];
        const createObjectURL = URL.createObjectURL.bind(URL);
        const revokeObjectURL = URL.revokeObjectURL.bind(URL);
        const proof: PasteProof = { reads: 0, loaded: 0, aborts: 0, created: 0, revoked: 0 };
        (globalThis as unknown as { partialPasteProof: PasteProof }).partialPasteProof = proof;
        FileReader.prototype.readAsDataURL = function (blob: Blob) {
          proof.reads += 1;
          if (proof.reads === 1) {
            this.addEventListener(
              "load",
              () => {
                proof.loaded += 1;
              },
              { once: true },
            );
            readAsDataUrl.call(this, blob);
          } else {
            // Hold only the second pasted file; draft restoration keeps native reads.
            FileReader.prototype.readAsDataURL = readAsDataUrl;
          }
        };
        FileReader.prototype.abort = function () {
          proof.aborts += 1;
          abort.call(this);
        };
        URL.createObjectURL = (blob: Blob) => {
          proof.created += 1;
          return createObjectURL(blob);
        };
        URL.revokeObjectURL = (url: string) => {
          proof.revoked += 1;
          revokeObjectURL(url);
        };
      });
      const gateway = await installMockGateway(page);
      const readProof = () =>
        page.evaluate(
          () => (globalThis as unknown as { partialPasteProof: PasteProof }).partialPasteProof,
        );
      await page.goto(`${suite.server.baseUrl}new`);
      const composer = page.locator(".new-session-page__message");
      await pastePng(composer, 2);
      await expect
        .poll(readProof)
        .toEqual({ reads: 2, loaded: 1, aborts: 0, created: 1, revoked: 0 });
      expect(await page.locator(".chat-attachment-thumb").count()).toBe(2);
      expect(await page.locator('.chat-attachment-thumb[aria-busy="true"]').count()).toBe(1);
      await page.getByRole("img", { name: "pixel-1.png", exact: true }).waitFor();
      await waitForCommittedNewSessionDraft(page, "", ["pixel-1.png"]);

      await navigateInApp(page, "chat");
      await waitForCommittedChatRoute(page);
      await expect
        .poll(readProof)
        .toEqual({ reads: 2, loaded: 1, aborts: 1, created: 1, revoked: 0 });
      await navigateInApp(page, "new-session");
      await composer.waitFor();
      await page.getByRole("img", { name: "pixel-1.png", exact: true }).waitFor();
      expect(await page.locator(".chat-attachment-thumb").count()).toBe(1);
      expect(await page.locator('.chat-attachment-thumb[aria-busy="true"]').count()).toBe(0);
      expect(await gateway.getRequests("sessions.create")).toHaveLength(0);
      await page.getByRole("button", { name: "Remove pixel-1.png", exact: true }).click();
      await waitForCommittedNewSessionDraft(page, "", []);
      await expect
        .poll(async () => {
          const proof = await readProof();
          return {
            reads: proof.reads,
            aborts: proof.aborts,
            previews: proof.created - proof.revoked,
          };
        })
        .toEqual({ reads: 2, aborts: 1, previews: 0 });
      expect(await page.locator(".chat-attachment-thumb").count()).toBe(0);
    });
  });

  it.each(["reload", "quota"] as const)(
    "keeps a rejected first message retryable after %s",
    async (recovery) => {
      await withNewSessionPage(async (page) => {
        const quota = recovery === "quota";
        if (quota) {
          await page.addInitScript(() => {
            const setItem = Object.getOwnPropertyDescriptor(Storage.prototype, "setItem")
              ?.value as Storage["setItem"];
            Storage.prototype.setItem = function (key: string, value: string) {
              if (key.startsWith("openclaw.control.chatComposer.v2:")) {
                throw new DOMException("Quota exceeded", "QuotaExceededError");
              }
              return setItem.call(this, key, value);
            };
          });
        }
        const sessionId = quota ? "storage-failed-initial-turn" : "rejected-first-message";
        const sessionKey = `agent:main:${sessionId}`;
        const message = "Keep this rejected message";
        const runError = "send blocked by session policy";
        const gateway = await installMockGateway(page, {
          methodResponses: {
            ...(quota ? {} : LOCAL_GIT_WORKSPACE_RESPONSES),
            "sessions.list": quota
              ? createdSessionListResult(sessionKey)
              : sessionList({
                  hasActiveRun: false,
                  key: sessionKey,
                  kind: "direct",
                  status: "done",
                  updatedAt: Date.now(),
                }),
            "sessions.create": {
              key: sessionKey,
              runStarted: false,
              runError: { code: "INVALID_REQUEST", message: runError },
            },
            "chat.history": {
              messages: [],
              sessionId,
              sessionInfo: { hasActiveRun: false, key: sessionKey, status: "done" },
            },
            "chat.send": { runId: "retry-run", status: "started" },
          },
        });
        await page.goto(`${suite.server.baseUrl}new`);
        const composer = page.locator(".new-session-page__message");
        await composer.fill(message);
        await pastePng(composer);
        await page.getByRole("button", { name: "Start session" }).click();
        const create = await gateway.waitForRequest("sessions.create");
        expect(create.params).toMatchObject({ message, attachments: [pngAttachment] });
        await page.waitForURL((url) => url.pathname === controlUiSessionPath(sessionKey), {
          timeout: 30_000,
        });
        await expectRejectedTurn(page, message, runError);
        if (!quota) {
          await page.reload();
          await expectRejectedTurn(page, message, runError);
        }
        await page.getByRole("button", { name: "Retry queued message" }).click();
        const retry = await gateway.waitForRequest("chat.send");
        expect(retry.params).toMatchObject({ sessionKey, message, attachments: [pngAttachment] });
        const retriedTurn = page.locator(".chat-group.user", { hasText: message });
        await pollCount(retriedTurn.locator(".chat-send-status")).toBe(0);
        await retriedTurn.locator("time.chat-group-timestamp").waitFor();
        expect(await gateway.getRequests("sessions.create")).toHaveLength(quota ? 1 : 0);
      });
    },
  );
});
