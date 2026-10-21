import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { storedChatOutboxScopeKey } from "../lib/chat/outbox-store.ts";
import {
  resolveUiConversationIdentity,
  type UiSessionDefaultsHost,
} from "../lib/sessions/session-key.ts";
import {
  controlUiSessionUrl,
  defaultControlUiFeatureMethods,
  installMockGateway,
  navigateToControlUiSession,
} from "../test-helpers/control-ui-e2e.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";
import { waitForCommittedComposerDraft, waitForCommittedState } from "./settle.test-support.ts";
import { openSidebarPages } from "./sidebar-customization.test-support.ts";
import { openHomeFullPage } from "./sidebar-navigation.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI chat attachment read lifecycle",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
});

const ONE_PIXEL_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/woAAn8B9FD5fHAAAAAASUVORK5CYII=";
const activePane = 'openclaw-chat-pane[aria-hidden="false"]';
const composerSelector = ".agent-chat__composer-combobox textarea";
const composerFor = (page: Page) => page.locator(`${activePane} ${composerSelector}`);
const attachmentsFor = (page: Page) => page.locator(`${activePane} .chat-attachment-thumb`);
const file = (name: string, contents: string) => ({
  name,
  mimeType: "text/plain",
  buffer: Buffer.from(contents),
});
const pngPayload = (fileName = "pixel.png") => ({
  content: ONE_PIXEL_PNG_B64,
  fileName,
  mimeType: "image/png",
  origin: "file",
});
function sessionsList(...keys: string[]) {
  return {
    count: keys.length,
    defaults: { contextTokens: null, model: "gpt-5.5", modelProvider: "openai" },
    path: "",
    sessions: keys.map((key, index) => ({ key, kind: "direct", updatedAt: keys.length - index })),
    ts: Date.now(),
  };
}

type DeferredAttachmentProof = {
  aborts: number;
  finish: (() => Promise<void>) | undefined;
};

async function installDeferredAttachmentReader(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const proof = { aborts: 0, finish: undefined as (() => Promise<void>) | undefined };
    (globalThis as unknown as { attachmentReadProof: typeof proof }).attachmentReadProof = proof;
    // Keep the native methods before overriding them so deferred completion and
    // cancellation cannot recursively call their own test hooks.
    const readAsDataURL = Reflect.get(FileReader.prototype, "readAsDataURL") as (
      this: FileReader,
      blob: Blob,
    ) => void;
    const abort = Reflect.get(FileReader.prototype, "abort") as (this: FileReader) => void;
    FileReader.prototype.readAsDataURL = function (blob: Blob) {
      proof.finish = () => {
        // Only the paste read is held; later outbox hydration uses native reads.
        FileReader.prototype.readAsDataURL = readAsDataURL;
        proof.finish = undefined;
        return new Promise<void>((resolve) => {
          this.addEventListener("loadend", () => resolve(), { once: true });
          readAsDataURL.call(this, blob);
        });
      };
    };
    FileReader.prototype.abort = function () {
      proof.aborts += 1;
      return abort.call(this);
    };
  });
}

async function pastePng(composer: Locator): Promise<void> {
  await composer.evaluate((element, base64) => {
    const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
    const clipboard = new DataTransfer();
    clipboard.items.add(new File([bytes], "pixel.png", { type: "image/png" }));
    element.dispatchEvent(
      new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: clipboard }),
    );
  }, ONE_PIXEL_PNG_B64);
}

function finishAttachmentRead(page: Page) {
  return page.evaluate(() => {
    const proof = (globalThis as unknown as { attachmentReadProof: DeferredAttachmentProof })
      .attachmentReadProof;
    if (!proof.finish) {
      throw new Error("Attachment read was not held");
    }
    return proof.finish();
  });
}

async function waitForCommittedAttachmentDraft(
  page: Page,
  sessionKey: string,
  text: string,
): Promise<void> {
  const defaults = await page
    .locator('openclaw-chat-pane[aria-hidden="false"]')
    .evaluate((element) => {
      const { state } = element as HTMLElement & { state: UiSessionDefaultsHost };
      return {
        assistantAgentId: state.assistantAgentId,
        agentsList: state.agentsList,
        hello: state.hello,
      };
    });
  const storedScope = resolveUiConversationIdentity(defaults, sessionKey);
  await waitForCommittedComposerDraft(
    page,
    `chat:v3:${storedChatOutboxScopeKey(storedScope)}`,
    text,
    1,
  );
}

suite.define(() => {
  it("keeps a preparing Home attachment through the page and dock route", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      await installDeferredAttachmentReader(page);
      const homeKey = "agent:main:main";
      const draft = "QA attachment handoff: keep this file with my Home draft.";
      const gateway = await installMockGateway(page, {
        featureMethods: [...defaultControlUiFeatureMethods, "chat.history", "chat.send"],
        sessionKey: homeKey,
        sessions: [{ key: homeKey, kind: "direct", label: "Main", updatedAt: 1 }],
      });
      const pageErrors: string[] = [];
      page.on("pageerror", (error) => pageErrors.push(error.message));
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, homeKey));
      const home = page.locator("openclaw-chat-page");
      const composer = home.locator(composerSelector);
      await composer.fill(draft);
      await home
        .locator(".agent-chat__file-input")
        .setInputFiles(file("handoff.txt", "Synthetic attachment payload survives Home handoff."));
      await home.locator('.chat-attachment-thumb[aria-busy="true"]').waitFor();
      const pages = await openSidebarPages(page);
      await pages.getByRole("link", { name: "Sessions", exact: true }).click();
      await page.waitForURL((url) => url.pathname.endsWith("/sessions"));
      await page.locator("openclaw-sessions-page").waitFor();
      await page.locator(".sidebar-footer-bar__home").click();
      const dock = page.locator("openclaw-assistant-panel");
      const dockComposer = dock.locator(composerSelector);
      await dockComposer.waitFor({ state: "visible" });
      await expect.poll(() => dockComposer.inputValue()).toBe(draft);
      const pending = {
        files: await dock.locator('.chat-attachment-thumb[aria-busy="true"]').count(),
        sendDisabled: await dock
          .getByRole("button", { name: "Send message", exact: true })
          .isDisabled(),
      };
      await finishAttachmentRead(page);
      await openHomeFullPage(page);
      await composer.waitFor({ state: "visible" });
      await expect.poll(() => dockComposer.isVisible()).toBe(false);
      const receipt = {
        pending,
        returnedDraft: await composer.inputValue(),
        returnedFiles: await home.locator('.chat-attachment-thumb[aria-busy="false"]').count(),
        removeAvailable: await home
          .getByRole("button", { name: "Remove handoff.txt", exact: true })
          .count(),
        pageErrors,
        requests: await gateway.getRequests("chat.send"),
      };
      expect(receipt).toEqual({
        pending: { files: 1, sendDisabled: true },
        returnedDraft: draft,
        returnedFiles: 1,
        removeAvailable: 1,
        pageErrors: [],
        requests: [],
      });
    });
  });

  it.each(["rewind-pending", "rewind-failed", "rewind-newer-file"])(
    "rewind draft attachment custody: %s",
    async (scenario) => {
      await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
        await installDeferredAttachmentReader(page);
        const earlierText = "Restore this earlier synthetic prompt.";
        const currentText = "Current synthetic draft with a selected file.";
        const retainsFile = scenario !== "rewind-pending";
        const expectedText = retainsFile ? currentText : earlierText;
        const prefix = {
          role: "assistant",
          content: "Synthetic conversation before the selected turn.",
          __openclaw: { id: "rewind-prefix", seq: 1 },
        };
        const gateway = await installMockGateway(page, {
          historyMessages: [
            prefix,
            { role: "user", content: earlierText, __openclaw: { id: "rewind-user", seq: 2 } },
            {
              role: "assistant",
              content: "Synthetic answer after the selected turn.",
              __openclaw: { id: "rewind-answer", seq: 3 },
            },
          ],
        });
        const pageErrors: string[] = [];
        page.on("pageerror", (error) => pageErrors.push(error.message));
        await page.goto(`${suite.server.baseUrl}chat`);
        const composer = page.locator(composerSelector);
        const send = page.getByRole("button", { name: "Send message", exact: true });
        await composer.fill(currentText);
        const selectFile = async () => {
          await page.locator(".agent-chat__file-input").setInputFiles({
            name: "late-selection.png",
            mimeType: "image/png",
            buffer: Buffer.from(ONE_PIXEL_PNG_B64, "base64"),
          });
          await expect.poll(() => send.isDisabled()).toBe(true);
        };
        if (scenario !== "rewind-newer-file") {
          await selectFile();
        }
        await gateway.deferNext("sessions.rewind");
        await page
          .locator(".chat-bubble")
          .filter({ hasText: earlierText })
          .click({ button: "right" });
        await page.getByRole("menuitem", { name: "Rewind to here", exact: true }).click();
        await page
          .locator(".chat-confirm-popover")
          .getByRole("button", { name: "Rewind", exact: true })
          .click();
        const rewind = await gateway.waitForRequest("sessions.rewind");
        expect(rewind.params).toMatchObject({ entryId: "rewind-user" });
        if (scenario === "rewind-failed") {
          await gateway.rejectDeferred("sessions.rewind", {
            code: "UNAVAILABLE",
            message: "Synthetic rewind failed; draft retained.",
          });
          await page
            .getByText("Synthetic rewind failed; draft retained.", { exact: false })
            .first()
            .waitFor();
        } else {
          if (scenario === "rewind-newer-file") {
            await selectFile();
          }
          await gateway.setHistoryMessages([prefix]);
          await gateway.resolveDeferred("sessions.rewind", {
            editorText: earlierText,
            editorAttachments: [],
          });
        }
        if (scenario === "rewind-newer-file") {
          await expect
            .poll(() => page.locator(".chat-bubble").filter({ hasText: earlierText }).count())
            .toBe(0);
        } else {
          await expect.poll(() => composer.inputValue()).toBe(expectedText);
        }
        await finishAttachmentRead(page);
        await expect.poll(() => send.isEnabled()).toBe(true);
        const composerFiles = await page
          .locator(".chat-attachment-thumb img")
          .evaluateAll((images) => images.map((image) => image.getAttribute("alt")));
        await send.click();
        const request = await gateway.waitForRequest("chat.send");
        expect(pageErrors).toEqual([]);
        expect(composerFiles).toEqual(retainsFile ? ["late-selection.png"] : []);
        const sent = request.params as {
          message: string;
          attachments?: { fileName: string; mimeType: string; content: string }[];
        };
        expect({ message: sent.message, attachments: sent.attachments ?? [] }).toEqual({
          message: expectedText,
          attachments: retainsFile ? [{ ...pngPayload("late-selection.png"), type: "image" }] : [],
        });
      });
    },
  );

  it.each([
    { attachment: false, gesture: "held Enter", expectedTurns: 1 },
    { attachment: true, gesture: "held Enter", expectedTurns: 1 },
    { attachment: false, gesture: "released and repressed Enter", expectedTurns: 2 },
    { attachment: true, gesture: "released and repressed Enter", expectedTurns: 2 },
  ])(
    "admits $expectedTurns turn(s) from $gesture during terminal history (attachment=$attachment)",
    async ({ attachment, gesture, expectedTurns }) => {
      await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
        const held = gesture === "held Enter";
        const ready = {
          content: [{ text: "Ready for the held Enter check.", type: "text" }],
          role: "assistant",
          __openclaw: { id: "held-enter-ready", seq: 1 },
        };
        const gateway = await installMockGateway(page, { historyMessages: [ready] });
        const pageErrors: string[] = [];
        page.on("pageerror", (error) => pageErrors.push(error.message));
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, "main"));
        const pane = page.locator(activePane);
        const composer = pane.locator(composerSelector);
        await pane.getByText("Ready for the held Enter check.", { exact: true }).waitFor();
        await gateway.waitForRequest("chat.startup");
        const initialText = "Finish the initial synthetic turn.";
        await composer.fill(initialText);
        await composer.press("Enter");
        const initial = await gateway.waitForRequest("chat.send");
        expect(initial.params).toMatchObject({
          idempotencyKey: expect.any(String),
          message: initialText,
          sessionKey: "agent:main:main",
        });
        const initialRunId = (initial.params as { idempotencyKey: string }).idempotencyKey;
        expect(initialRunId).not.toBe("");
        await pane.getByRole("button", { name: "Stop generating" }).waitFor();

        const followUpText = attachment ? "" : "Submit this follow-up once per key press.";
        const fileName = "held-enter.txt";
        const fileContents = "Synthetic held Enter attachment contents.";
        const stageFollowUp = async () => {
          await composer.fill(followUpText);
          if (attachment) {
            await pane
              .locator(".agent-chat__file-input")
              .setInputFiles(file(fileName, fileContents));
            await pane.locator(".chat-attachment-thumb", { hasText: fileName }).waitFor();
          }
        };
        await stageFollowUp();
        const terminalText = "The initial synthetic turn completed.";
        const terminalMessage = {
          content: [{ text: terminalText, type: "text" }],
          role: "assistant",
          __openclaw: { id: "held-enter-terminal", seq: 3 },
        };
        const historyMessages = [
          ready,
          {
            content: [{ text: initialText, type: "text" }],
            role: "user",
            __openclaw: {
              id: "held-enter-initial-user",
              idempotencyKey: `${initialRunId}:user`,
              seq: 2,
            },
          },
          terminalMessage,
        ];
        await gateway.setHistoryMessages(historyMessages);
        const historyBefore = (await gateway.getRequests("chat.history")).length;
        await gateway.deferNext("chat.history");
        await gateway.emitChatFinal({ runId: initialRunId, text: terminalText });
        await pane
          .locator(".chat-group.assistant .chat-bubble")
          .getByText(terminalText, { exact: true })
          .waitFor();
        await gateway.emitGatewayEvent("session.message", {
          activeRunIds: [],
          clientRunId: initialRunId,
          hasActiveRun: false,
          message: terminalMessage,
          messageId: "held-enter-terminal",
          messageSeq: 3,
          session: {
            activeRunIds: [],
            hasActiveRun: false,
            key: "agent:main:main",
            status: "done",
          },
          sessionKey: "agent:main:main",
        });
        await gateway.waitForRequest("chat.history", { after: historyBefore });
        await expect
          .poll(() => pane.getByRole("button", { name: "Send message" }).isEnabled())
          .toBe(true);
        expect(await composer.inputValue()).toBe(followUpText);
        expect(await pane.locator(".chat-attachment-thumb").count()).toBe(attachment ? 1 : 0);
        expect(await pane.locator(".chat-queue__item").count()).toBe(0);
        await composer.click();
        expect(
          await composer.evaluate((element) => ({
            focused: document.hasFocus() && document.activeElement === element,
            visibility: document.visibilityState,
          })),
        ).toEqual({ focused: true, visibility: "visible" });

        const keyProof = await composer.evaluateHandle((element) => {
          const textarea = element as HTMLTextAreaElement;
          const events: Array<{ isTrusted: boolean; repeat: boolean }> = [];
          const record = (event: KeyboardEvent) => {
            if (event.key === "Enter" && events.length < 4) {
              events.push({ isTrusted: event.isTrusted, repeat: event.repeat });
            }
          };
          textarea.addEventListener("keydown", record, true);
          return {
            events,
            dispose: () => textarea.removeEventListener("keydown", record, true),
          };
        });
        try {
          try {
            await page.keyboard.down("Enter");
            if (!held) {
              await page.keyboard.up("Enter");
              await expect.poll(() => composer.inputValue()).toBe("");
              await expect.poll(() => pane.locator(".chat-attachment-thumb").count()).toBe(0);
              await stageFollowUp();
              if (attachment) {
                await expect
                  .poll(() => pane.getByRole("button", { name: "Send message" }).isEnabled())
                  .toBe(true);
              }
            }
            await page.keyboard.down("Enter");
          } finally {
            await page.keyboard.up("Enter");
          }
          const keys = await keyProof.evaluate((proof) => proof.events);
          expect(keys).toEqual([
            { isTrusted: true, repeat: false },
            { isTrusted: true, repeat: held },
          ]);
          expect(await gateway.getRequests("chat.history")).toHaveLength(historyBefore + 1);
          expect(await gateway.getRequests("chat.send")).toHaveLength(1);
          await expect.poll(() => composer.inputValue()).toBe("");
          await expect.poll(() => pane.locator(".chat-attachment-thumb").count()).toBe(0);
          await expect.poll(() => pane.locator(".chat-queue__item").count()).toBe(expectedTurns);

          const sendsBefore = (await gateway.getRequests("chat.send")).length;
          await gateway.deferNext("chat.send");
          await gateway.resolveDeferred("chat.history", {
            messages: historyMessages,
            sessionId: "session:agent:main:main",
            sessionInfo: {
              activeLeafEntryId: "held-enter-terminal",
              activeRunIds: [],
              hasActiveRun: false,
              key: "agent:main:main",
              status: "done",
            },
            thinkingLevel: null,
          });
          const followUp = await gateway.waitForRequest("chat.send", { after: sendsBefore });
          expect(followUp.params).toMatchObject({
            expectedLeafEntryId: "held-enter-terminal",
            idempotencyKey: expect.any(String),
            message: followUpText,
            sessionKey: "agent:main:main",
            ...(attachment
              ? {
                  attachments: [
                    {
                      content: Buffer.from(fileContents).toString("base64"),
                      fileName,
                      origin: "file",
                      mimeType: "text/plain",
                      type: "file",
                    },
                  ],
                }
              : {}),
          });
          const followUpRunId = (followUp.params as { idempotencyKey: string }).idempotencyKey;
          expect(followUpRunId).not.toBe("");
          expect(followUpRunId).not.toBe(initialRunId);
          if (!attachment) {
            expect(followUp.params).not.toHaveProperty("attachments");
          }

          // Both held-history continuations enqueue synchronously before their
          // next await. Cross a committed render boundary, not a transient count=1.
          await waitForCommittedState(
            page,
            () => {
              const active = document.querySelector('openclaw-chat-pane[aria-hidden="false"]');
              const input = active?.querySelector(".agent-chat__composer-combobox textarea");
              return (
                input instanceof HTMLTextAreaElement &&
                input.value === "" &&
                active?.querySelectorAll(".chat-attachment-thumb").length === 0
              );
            },
            {},
          );
          // The held ACK keeps the first turn in the transcript; later
          // waiting turns remain in the composer queue. Read both together.
          const observed = await pane.evaluate(
            (active, followUpContent) => {
              const readRow = (row: Element, idAttribute: string) => {
                const rect = row.getBoundingClientRect();
                return {
                  id: row.getAttribute(idAttribute),
                  visible:
                    rect.height > 0 && rect.width > 0 && rect.bottom > 0 && rect.top < innerHeight,
                };
              };
              return {
                bubbles: [...active.querySelectorAll(".chat-group.user .chat-bubble")]
                  .filter((bubble) => bubble.textContent?.includes(followUpContent))
                  .map((bubble) => readRow(bubble, "data-message-id")),
                queued: [
                  ...active.querySelectorAll(".agent-chat__composer-shell .chat-queue__item"),
                ].map((row) => {
                  const { id, visible } = readRow(row, "data-chat-queue-item");
                  return {
                    id,
                    visible,
                    text: row.querySelector(".chat-queue__text")?.textContent?.trim(),
                  };
                }),
              };
            },
            attachment ? fileName : followUpText,
          );
          expect(pageErrors).toEqual([]);
          expect(observed.bubbles.map((row) => row.id)).toEqual([`msg:send:${followUpRunId}:0`]);
          for (const rows of [observed.bubbles, observed.queued]) {
            expect(rows.every((row) => row.visible && row.id)).toBe(true);
            expect(new Set(rows.map((row) => row.id)).size).toBe(rows.length);
          }
          expect(
            observed.queued.every((row) => row.text === (attachment ? "Image (1)" : followUpText)),
          ).toBe(true);
          expect(observed.bubbles.length + observed.queued.length).toBe(expectedTurns);
          expect(await gateway.getRequests("chat.send")).toHaveLength(sendsBefore + 1);
        } finally {
          try {
            await keyProof.evaluate((proof) => proof.dispose());
          } finally {
            await keyProof.dispose();
          }
        }
      });
    },
  );

  it("restores an attachment staged offline after reload and reconnect", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const gateway = await installMockGateway(page);
      const sessionKey = "agent:main:main";
      const text = "offline attachment draft";
      const contents = "offline attachment contents";
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
      const composer = page.locator(composerSelector);
      await composer.waitFor();

      await gateway.setOnline(false);
      await page.locator(".agent-chat__input--offline").waitFor();
      await composer.fill(text);
      await page.locator(".agent-chat__file-input").setInputFiles(file("offline.txt", contents));
      await expect.poll(() => page.locator(".chat-attachment-thumb").count()).toBe(1);
      await waitForCommittedAttachmentDraft(page, sessionKey, text);

      await page.reload();
      await gateway.setOnline(true);
      await expect.poll(() => composer.inputValue()).toBe(text);
      await expect.poll(() => page.locator(".chat-attachment-thumb").count()).toBe(1);
      await composer.press("Enter");

      const request = await gateway.waitForRequest("chat.send");
      expect(request.params).toMatchObject({
        attachments: [
          {
            content: Buffer.from(contents).toString("base64"),
            fileName: "offline.txt",
            origin: "file",
            mimeType: "text/plain",
          },
        ],
        message: text,
        sessionKey,
      });
    });
  });

  it("restores isolated session drafts across fresh pages and retires sent or removed attachments", async () => {
    const firstSession = "agent:main:restart-session-a";
    const secondSession = "agent:main:restart-session-b";
    const options = {
      methodResponses: { "sessions.list": sessionsList(firstSession, secondSession) },
      sessionKey: firstSession,
    };
    const context = await suite.browser.newContext(createControlUiE2eContextOptions());
    const openSession = async () => {
      const page = await context.newPage();
      const gateway = await installMockGateway(page, options);
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, firstSession));
      return { page, gateway };
    };
    const expectRestored = async (page: Page, text: string, count: number) => {
      await expect.poll(() => composerFor(page).inputValue()).toBe(text);
      if (count) {
        await attachmentsFor(page).first().waitFor();
        expect(await attachmentsFor(page).count()).toBe(count);
      } else {
        await expect.poll(() => attachmentsFor(page).count()).toBe(0);
      }
    };
    try {
      const { page: firstPage } = await openSession();
      await composerFor(firstPage).fill("restart draft A with image");
      await pastePng(composerFor(firstPage));
      await expect.poll(() => attachmentsFor(firstPage).count()).toBe(1);
      await waitForCommittedAttachmentDraft(firstPage, firstSession, "restart draft A with image");

      await navigateToControlUiSession(firstPage, secondSession);
      await composerFor(firstPage).fill("restart draft B with removable file");
      await firstPage
        .locator('openclaw-chat-pane[aria-hidden="false"] .agent-chat__file-input')
        .setInputFiles(file("remove-me.txt", "remove this attachment"));
      await expect.poll(() => attachmentsFor(firstPage).count()).toBe(1);
      await waitForCommittedAttachmentDraft(
        firstPage,
        secondSession,
        "restart draft B with removable file",
      );
      await firstPage.close();

      const { page: restoredPage, gateway: restoredGateway } = await openSession();
      await expectRestored(restoredPage, "restart draft A with image", 1);

      await navigateToControlUiSession(restoredPage, secondSession);
      await expectRestored(restoredPage, "restart draft B with removable file", 1);
      await restoredPage
        .locator('openclaw-chat-pane[aria-hidden="false"] .chat-attachment-remove')
        .click();
      await expect.poll(() => attachmentsFor(restoredPage).count()).toBe(0);

      await navigateToControlUiSession(restoredPage, firstSession);
      await composerFor(restoredPage).press("Enter");
      const send = await restoredGateway.waitForRequest("chat.send");
      expect(send.params).toMatchObject({
        sessionKey: firstSession,
        message: "restart draft A with image",
        attachments: [pngPayload()],
      });
      await expectRestored(restoredPage, "", 0);
      await restoredPage.close();

      const { page: clearedPage } = await openSession();
      await expectRestored(clearedPage, "", 0);
      await navigateToControlUiSession(clearedPage, secondSession);
      await expectRestored(clearedPage, "restart draft B with removable file", 0);
    } finally {
      await context.close();
    }
  });

  it("rejects the file that would overflow one send's frame at intake", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      // 400 bytes past the 256 KiB envelope slack leaves a 300-byte decoded batch
      // budget: each 200-byte file fits the per-file ceiling, both together do not.
      const gateway = await installMockGateway(page, {
        attachmentMaxBytes: 256,
        maxPayload: 256 * 1024 + 400,
      });

      await page.goto(`${suite.server.baseUrl}chat`);
      const composer = page.locator(composerSelector);
      await composer.fill("Send both files");
      await page.locator(".agent-chat__file-input").setInputFiles([
        { name: "first.txt", mimeType: "text/plain", buffer: Buffer.alloc(200, 0x61) },
        { name: "second.txt", mimeType: "text/plain", buffer: Buffer.alloc(200, 0x62) },
      ]);

      await page
        .locator(".app-toast")
        .filter({ hasText: "File too large. Try a smaller file." })
        .waitFor();
      await expect
        .poll(() => page.locator('.chat-attachment-thumb[aria-busy="false"]').count())
        .toBe(1);
      expect(await page.locator(".chat-attachment-failures").count()).toBe(0);
      expect(
        await page.getByRole("button", { name: "Remove second.txt", exact: true }).count(),
      ).toBe(0);

      await composer.press("Enter");
      const request = await gateway.waitForRequest("chat.send");
      expect(request.params).toMatchObject({
        attachments: [{ fileName: "first.txt", mimeType: "text/plain", origin: "file" }],
        message: "Send both files",
      });
    });
  });

  it("keeps a session's pending image isolated while another session is active", async () => {
    const firstSession = "agent:main:attachment-session-a";
    const secondSession = "agent:main:attachment-session-b";
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      await installDeferredAttachmentReader(page);
      const gateway = await installMockGateway(page, {
        methodResponses: { "sessions.list": sessionsList(firstSession, secondSession) },
        sessionKey: firstSession,
      });

      await page.goto(controlUiSessionUrl(suite.server.baseUrl, firstSession));
      const activeComposer = () => composerFor(page);
      await activeComposer().fill("Private session A attachment");
      await pastePng(activeComposer());
      await expect
        .poll(() => page.getByRole("button", { name: "Send message" }).isDisabled())
        .toBe(true);

      await navigateToControlUiSession(page, secondSession);

      await expect
        .poll(() =>
          page.evaluate(
            () =>
              (globalThis as unknown as { attachmentReadProof: DeferredAttachmentProof })
                .attachmentReadProof.aborts,
          ),
        )
        .toBe(0);
      await expect.poll(() => attachmentsFor(page).count()).toBe(0);

      await activeComposer().fill("Safe session B message");
      await activeComposer().press("Enter");
      const request = await gateway.waitForRequest("chat.send");
      expect(request.params).toMatchObject({
        message: "Safe session B message",
        sessionKey: secondSession,
      });
      expect((request.params as { attachments?: unknown }).attachments).toBeUndefined();

      await navigateToControlUiSession(page, firstSession);
      await finishAttachmentRead(page);
      await page
        .locator('openclaw-chat-pane[aria-hidden="false"]')
        .getByRole("img", { name: "pixel.png" })
        .waitFor();
    });
  });

  it("settles an eventless stalled attachment read through failure, preserves draft, and releases send", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      await installDeferredAttachmentReader(page);
      const gateway = await installMockGateway(page);

      await page.goto(`${suite.server.baseUrl}chat`);
      const composer = page.locator(composerSelector);
      const send = page.getByRole("button", { name: "Send message" });
      const draftText = "Draft message while attachment read stalls";
      await composer.fill(draftText);

      await page.clock.install();
      await pastePng(composer);

      await expect.poll(() => send.isDisabled()).toBe(true);
      await page.locator(".chat-attachment-loading").waitFor();

      // Advance virtual clock past the 15-second read timeout
      await page.clock.runFor(15_001);

      // Failed reads leave the composer and report through the shared toast.
      await page
        .locator(".app-toast")
        .getByText("Could not attach file. Try again.", { exact: true })
        .waitFor();
      await expect.poll(() => send.isEnabled()).toBe(true);

      await expect.poll(() => page.locator(".chat-attachment-thumb").count()).toBe(0);
      expect(await composer.inputValue()).toBe(draftText);
      expect(await page.locator(".chat-attachment-failures").count()).toBe(0);

      // The preserved draft remains sendable after the failed read retires.
      await send.click();
      const request = await gateway.waitForRequest("chat.send");
      expect(request.params).toMatchObject({
        message: draftText,
      });
      expect((request.params as { attachments?: unknown }).attachments).toBeUndefined();
      await expect.poll(() => composer.inputValue()).toBe("");

      const aborts = await page.evaluate(
        () =>
          (globalThis as unknown as { attachmentReadProof: DeferredAttachmentProof })
            .attachmentReadProof.aborts,
      );
      expect(aborts).toBe(1);
    });
  });
});
