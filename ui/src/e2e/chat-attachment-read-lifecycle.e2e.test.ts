import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { storedChatOutboxScopeKey } from "../lib/chat/outbox-store.ts";
import {
  resolveUiConversationIdentity,
  type UiSessionDefaultsHost,
} from "../lib/sessions/session-key.ts";
import {
  type ControlUiMockGatewayScenario,
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

type DeferredAttachmentProof = {
  aborts: number;
  finish: (() => Promise<void>) | undefined;
};

const withPage = (run: Parameters<typeof suite.withPage>[1]) =>
  suite.withPage(createControlUiE2eContextOptions(), run);
const activePane = (page: Page) => page.locator('openclaw-chat-pane[aria-hidden="false"]');
const composerFor = (owner: Page | Locator) =>
  owner.locator(".agent-chat__composer-combobox textarea");
const fileInput = (owner: Page | Locator) => owner.locator(".agent-chat__file-input");
const activeComposer = (page: Page) => composerFor(activePane(page));
const activeAttachments = (page: Page) => activePane(page).locator(".chat-attachment-thumb");
const button = (owner: Page | Locator, name: string) =>
  owner.getByRole("button", { name, exact: true });
const expectCount = (locator: Locator, count: number) =>
  expect.poll(() => locator.count()).toBe(count);
const expectValue = (locator: Locator, value: string) =>
  expect.poll(() => locator.inputValue()).toBe(value);
const expectEnabled = (control: Locator, enabled = true) =>
  expect.poll(() => control.isEnabled()).toBe(enabled);
async function expectDraft(page: Page, text: string, attachments: number) {
  await expectValue(activeComposer(page), text);
  await expectCount(activeAttachments(page), attachments);
}
const textFile = (name: string, text: string) => ({
  name,
  mimeType: "text/plain",
  buffer: Buffer.from(text),
});
const pngPayload = (fileName = "pixel.png") => ({
  content: ONE_PIXEL_PNG_B64,
  fileName,
  mimeType: "image/png",
  origin: "file",
});
const textPayload = (fileName: string, text: string) => ({
  content: Buffer.from(text).toString("base64"),
  fileName,
  origin: "file",
  mimeType: "text/plain",
});
const textMessage = (
  role: string,
  text: string,
  id: string,
  seq: number,
  idempotencyKey?: string,
) => ({
  role,
  content: [{ text, type: "text" }],
  __openclaw: { id, seq, ...(idempotencyKey === undefined ? {} : { idempotencyKey }) },
});

async function openChat(
  page: Page,
  options: ControlUiMockGatewayScenario = {},
  sessionKey = options.sessionKey,
) {
  const gateway = await installMockGateway(page, options);
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(
    sessionKey
      ? controlUiSessionUrl(suite.server.baseUrl, sessionKey)
      : `${suite.server.baseUrl}chat`,
  );
  return {
    gateway,
    pageErrors,
    composer: composerFor(page),
    send: button(page, "Send message"),
    pane: activePane(page),
  };
}

function readAborts(page: Page) {
  return page.evaluate(
    () =>
      (globalThis as unknown as { attachmentReadProof: DeferredAttachmentProof })
        .attachmentReadProof.aborts,
  );
}

function sessionList(...keys: string[]) {
  return {
    count: keys.length,
    defaults: { contextTokens: null, model: "gpt-5.5", modelProvider: "openai" },
    path: "",
    sessions: keys.map((key, index) => ({ key, kind: "direct", updatedAt: keys.length - index })),
    ts: Date.now(),
  };
}

function finishRead(page: Page) {
  return page.evaluate(() => {
    const proof = (globalThis as unknown as { attachmentReadProof: DeferredAttachmentProof })
      .attachmentReadProof;
    if (!proof.finish) {
      throw new Error("Attachment read was not held");
    }
    return proof.finish();
  });
}

async function installDeferredAttachmentReader(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const proof = { aborts: 0, finish: undefined as (() => Promise<void>) | undefined };
    (globalThis as unknown as { attachmentReadProof: typeof proof }).attachmentReadProof = proof;
    const { readAsDataURL, abort } = FileReader.prototype;
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

async function waitForCommittedAttachmentDraft(
  page: Page,
  sessionKey: string,
  text: string,
): Promise<void> {
  const defaults = await activePane(page).evaluate((element) => {
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

function readFollowUps(active: Element, content: string) {
  const rows = (selector: string, id: string, match?: string) =>
    [...active.querySelectorAll(selector)]
      .filter((row) => match === undefined || row.textContent?.includes(match))
      .map((row) => {
        const rect = row.getBoundingClientRect();
        return {
          id: row.getAttribute(id),
          visible: rect.height > 0 && rect.width > 0 && rect.bottom > 0 && rect.top < innerHeight,
          text: row.querySelector(".chat-queue__text")?.textContent?.trim(),
        };
      });
  return {
    bubbles: rows(".chat-group.user .chat-bubble", "data-message-id", content),
    queued: rows(".agent-chat__composer-shell .chat-queue__item", "data-chat-queue-item"),
  };
}

suite.define(() => {
  it("keeps a preparing Home attachment through the page and dock route", async () => {
    await withPage(async ({ page }) => {
      await installDeferredAttachmentReader(page);
      const homeKey = "agent:main:main";
      const draft = "QA attachment handoff: keep this file with my Home draft.";
      const { gateway, pageErrors } = await openChat(page, {
        featureMethods: [...defaultControlUiFeatureMethods, "chat.history", "chat.send"],
        sessionKey: homeKey,
        sessions: [{ key: homeKey, kind: "direct", label: "Main", updatedAt: 1 }],
      });
      const home = page.locator("openclaw-chat-page");
      const composer = composerFor(home);
      await composer.fill(draft);
      await fileInput(home).setInputFiles(
        textFile("handoff.txt", "Synthetic Home handoff payload."),
      );
      await home.locator('.chat-attachment-thumb[aria-busy="true"]').waitFor();
      const pages = await openSidebarPages(page);
      await pages.getByRole("link", { name: "Agents", exact: true }).click();
      await page.waitForURL((url) => url.pathname.endsWith("/agents"));
      await page.getByRole("region", { name: "Agents", exact: true }).waitFor();
      await page.locator(".sidebar-footer-bar__home").click();
      const dock = page.locator("openclaw-assistant-panel");
      const dockComposer = composerFor(dock);
      await dockComposer.waitFor({ state: "visible" });
      await expectValue(dockComposer, draft);
      const pending = {
        files: await dock.locator('.chat-attachment-thumb[aria-busy="true"]').count(),
        sendDisabled: await button(dock, "Send message").isDisabled(),
      };
      await finishRead(page);
      await openHomeFullPage(page);
      await composer.waitFor({ state: "visible" });
      await expect.poll(() => dockComposer.isVisible()).toBe(false);
      const receipt = {
        pending,
        returnedDraft: await composer.inputValue(),
        returnedFiles: await home.locator('.chat-attachment-thumb[aria-busy="false"]').count(),
        removeAvailable: await button(home, "Remove handoff.txt").count(),
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

  it.each([
    "same-draft",
    "rewind-completed",
    "rewind-pending",
    "rewind-failed",
    "rewind-newer-draft",
    "rewind-newer-file",
  ] as const)("rewind draft attachment custody: %s", async (scenario) => {
    await withPage(async ({ page }) => {
      await installDeferredAttachmentReader(page);
      const earlierText = "Earlier prompt.";
      const currentText = "Current draft.";
      const newerText = "Newer pending draft.";
      const retainsFile = !["rewind-completed", "rewind-pending"].includes(scenario);
      const expectedText =
        scenario === "rewind-newer-draft" ? newerText : retainsFile ? currentText : earlierText;
      const rewindMessage = (role: string, content: string, id: string, seq: number) => ({
        role,
        content,
        __openclaw: { id: `rewind-${id}`, seq },
      });
      const prefix = rewindMessage("assistant", "Earlier conversation.", "prefix", 1);
      const { gateway, pageErrors, composer, send } = await openChat(page, {
        historyMessages: [
          prefix,
          rewindMessage("user", earlierText, "user", 2),
          rewindMessage("assistant", "Later answer.", "answer", 3),
        ],
      });
      await composer.fill(currentText);
      const selectFile = () =>
        fileInput(page).setInputFiles({
          name: "late-selection.png",
          mimeType: "image/png",
          buffer: Buffer.from(ONE_PIXEL_PNG_B64, "base64"),
        });
      if (scenario !== "rewind-newer-file") {
        await selectFile();
        await expectEnabled(send, false);
      }
      if (scenario === "same-draft" || scenario === "rewind-completed") {
        await finishRead(page);
        await page.getByRole("img", { name: "late-selection.png", exact: true }).waitFor();
        await expectEnabled(send);
      }
      if (scenario !== "same-draft") {
        await gateway.deferNext("sessions.rewind");
        await page.locator(".chat-bubble", { hasText: earlierText }).click({ button: "right" });
        await page.getByRole("menuitem", { name: "Rewind to here", exact: true }).click();
        await button(page.locator(".chat-confirm-popover"), "Rewind").click();
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
          if (scenario === "rewind-newer-draft") {
            await composer.fill(newerText);
          } else if (scenario === "rewind-newer-file") {
            await selectFile();
            await expectEnabled(send, false);
          }
          await gateway.setHistoryMessages([prefix]);
          await gateway.resolveDeferred("sessions.rewind", {
            editorText: earlierText,
            editorAttachments: [],
          });
          if (scenario === "rewind-newer-draft" || scenario === "rewind-newer-file") {
            await expectCount(page.locator(".chat-bubble", { hasText: earlierText }), 0);
          }
        }
        if (scenario !== "rewind-newer-file") {
          await expectValue(composer, expectedText);
        }
      }
      if (scenario !== "same-draft" && scenario !== "rewind-completed") {
        await finishRead(page);
      }
      await expectEnabled(send);
      const composerFiles = await page
        .locator(".chat-attachment-thumb img")
        .evaluateAll((images) => images.map((image) => image.getAttribute("alt")));
      await send.click();
      const request = await gateway.waitForRequest("chat.send");
      const sent = request.params as {
        message: string;
        attachments?: { fileName: string; mimeType: string; content: string }[];
      };
      expect(pageErrors).toEqual([]);
      expect(sent.message).toBe(expectedText);
      expect(composerFiles).toEqual(retainsFile ? ["late-selection.png"] : []);
      expect(sent.attachments ?? []).toEqual(
        retainsFile ? [{ type: "image", ...pngPayload("late-selection.png") }] : [],
      );
    });
  });

  it.each([
    { attachment: false, gesture: "held Enter", expectedTurns: 1 },
    { attachment: true, gesture: "held Enter", expectedTurns: 1 },
    { attachment: false, gesture: "released and repressed Enter", expectedTurns: 2 },
    { attachment: true, gesture: "released and repressed Enter", expectedTurns: 2 },
  ])(
    "admits $expectedTurns turn(s) from $gesture during terminal history (attachment=$attachment)",
    async ({ attachment, gesture, expectedTurns }) => {
      await withPage(async ({ page }) => {
        const held = gesture === "held Enter";
        const ready = textMessage("assistant", "Held Enter ready.", "held-enter-ready", 1);
        const { gateway, pageErrors, pane } = await openChat(
          page,
          { historyMessages: [ready] },
          "main",
        );
        const composer = composerFor(pane);
        await pane.getByText("Held Enter ready.", { exact: true }).waitFor();
        await gateway.waitForRequest("chat.startup");
        const initialText = "First turn.";
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

        const followUpText = attachment ? "" : "Follow-up per press.";
        const fileName = "held-enter.txt";
        const fileContents = "Synthetic held Enter attachment contents.";
        async function stageFollowUp() {
          await composer.fill(followUpText);
          if (attachment) {
            await fileInput(pane).setInputFiles(textFile(fileName, fileContents));
            await pane.locator(".chat-attachment-thumb", { hasText: fileName }).waitFor();
          }
        }
        await stageFollowUp();
        const terminalText = "First turn complete.";
        const terminalMessage = textMessage("assistant", terminalText, "held-enter-terminal", 3);
        const terminalState = { activeRunIds: [], hasActiveRun: false };
        const terminalSession = { ...terminalState, key: "agent:main:main", status: "done" };
        const historyMessages = [
          ready,
          textMessage("user", initialText, "held-enter-initial-user", 2, `${initialRunId}:user`),
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
          ...terminalState,
          clientRunId: initialRunId,
          message: terminalMessage,
          messageId: "held-enter-terminal",
          messageSeq: 3,
          session: terminalSession,
          sessionKey: "agent:main:main",
        });
        await gateway.waitForRequest("chat.history", { after: historyBefore });
        await expectEnabled(pane.getByRole("button", { name: "Send message" }));
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
              await expectDraft(page, "", 0);
              await stageFollowUp();
              if (attachment) {
                await expectEnabled(pane.getByRole("button", { name: "Send message" }));
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
          await expectDraft(page, "", 0);
          await expectCount(pane.locator(".chat-queue__item"), expectedTurns);

          const sendsBefore = (await gateway.getRequests("chat.send")).length;
          await gateway.deferNext("chat.send");
          await gateway.resolveDeferred("chat.history", {
            messages: historyMessages,
            sessionId: "session:agent:main:main",
            sessionInfo: {
              ...terminalSession,
              activeLeafEntryId: "held-enter-terminal",
            },
            thinkingLevel: null,
          });
          const followUp = await gateway.waitForRequest("chat.send", { after: sendsBefore });
          expect(followUp.params).toMatchObject({
            expectedLeafEntryId: "held-enter-terminal",
            idempotencyKey: expect.any(String),
            message: followUpText,
            sessionKey: "agent:main:main",
            ...(attachment && {
              attachments: [{ ...textPayload(fileName, fileContents), type: "file" }],
            }),
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
          // Read the held ACK in the transcript and later waiting turns in the queue together.
          const observed = await pane.evaluate(readFollowUps, attachment ? fileName : followUpText);
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
          await keyProof.evaluate((proof) => proof.dispose()).finally(() => keyProof.dispose());
        }
      });
    },
  );

  it("restores an attachment staged offline after reload and reconnect", async () => {
    await withPage(async ({ page }) => {
      const sessionKey = "agent:main:main";
      const text = "offline attachment draft";
      const contents = "offline attachment contents";
      const { gateway, composer } = await openChat(page, {}, sessionKey);
      await composer.waitFor();

      await gateway.setOnline(false);
      await page.locator(".agent-chat__input--offline").waitFor();
      await composer.fill(text);
      await fileInput(page).setInputFiles(textFile("offline.txt", contents));
      await expectCount(page.locator(".chat-attachment-thumb"), 1);
      await waitForCommittedAttachmentDraft(page, sessionKey, text);

      await page.reload();
      await gateway.setOnline(true);
      await expectDraft(page, text, 1);
      await composer.press("Enter");

      const request = await gateway.waitForRequest("chat.send");
      expect(request.params).toMatchObject({
        attachments: [textPayload("offline.txt", contents)],
        message: text,
        sessionKey,
      });
    });
  });

  it("restores isolated session drafts across fresh pages and retires sent or removed attachments", async () => {
    const firstSession = "agent:main:restart-session-a";
    const secondSession = "agent:main:restart-session-b";
    const sessionsList = sessionList(firstSession, secondSession);
    const firstDraft = "restart draft A with image";
    const secondDraft = "restart draft B with removable file";
    const context = await suite.browser.newContext(createControlUiE2eContextOptions());
    async function openFreshPage() {
      const page = await context.newPage();
      const { gateway } = await openChat(page, {
        methodResponses: { "sessions.list": sessionsList },
        sessionKey: firstSession,
      });
      return { page, gateway };
    }
    try {
      const { page: firstPage } = await openFreshPage();
      await activeComposer(firstPage).fill(firstDraft);
      await pastePng(activeComposer(firstPage));
      await expectCount(activeAttachments(firstPage), 1);
      await waitForCommittedAttachmentDraft(firstPage, firstSession, firstDraft);

      await navigateToControlUiSession(firstPage, secondSession);
      await activeComposer(firstPage).fill(secondDraft);
      await fileInput(activePane(firstPage)).setInputFiles(
        textFile("remove-me.txt", "remove this attachment"),
      );
      await expectCount(activeAttachments(firstPage), 1);
      await waitForCommittedAttachmentDraft(firstPage, secondSession, secondDraft);
      await firstPage.close();

      const { page: restoredPage, gateway: restoredGateway } = await openFreshPage();
      await expectValue(activeComposer(restoredPage), firstDraft);
      await activeAttachments(restoredPage).first().waitFor();
      expect(await activeAttachments(restoredPage).count()).toBe(1);

      await navigateToControlUiSession(restoredPage, secondSession);
      await expectValue(activeComposer(restoredPage), secondDraft);
      await activeAttachments(restoredPage).first().waitFor();
      expect(await activeAttachments(restoredPage).count()).toBe(1);
      await activePane(restoredPage).locator(".chat-attachment-remove").click();
      await expectCount(activeAttachments(restoredPage), 0);

      await navigateToControlUiSession(restoredPage, firstSession);
      await activeComposer(restoredPage).press("Enter");
      const send = await restoredGateway.waitForRequest("chat.send");
      expect(send.params).toMatchObject({
        sessionKey: firstSession,
        message: firstDraft,
        attachments: [pngPayload()],
      });
      await expectDraft(restoredPage, "", 0);
      await restoredPage.close();

      const { page: clearedPage } = await openFreshPage();
      await expectDraft(clearedPage, "", 0);
      await navigateToControlUiSession(clearedPage, secondSession);
      await expectDraft(clearedPage, secondDraft, 0);
    } finally {
      await context.close();
    }
  });

  it("rejects the file that would overflow one send's frame at intake", async () => {
    await withPage(async ({ page }) => {
      // 400 bytes past the 256 KiB envelope slack leaves a 300-byte decoded batch
      // budget: each 200-byte file fits the per-file ceiling, both together do not.
      const { gateway, composer } = await openChat(page, {
        attachmentMaxBytes: 256,
        maxPayload: 256 * 1024 + 400,
      });

      await composer.fill("Send both files");
      await fileInput(page).setInputFiles([
        { name: "first.txt", mimeType: "text/plain", buffer: Buffer.alloc(200, 0x61) },
        { name: "second.txt", mimeType: "text/plain", buffer: Buffer.alloc(200, 0x62) },
      ]);

      await page.locator(".app-toast", { hasText: "Too large to send: second.txt" }).waitFor();
      await expectCount(page.locator('.chat-attachment-thumb[aria-busy="false"]'), 2);
      expect(await page.locator(".chat-attachment-failures").textContent()).toContain(
        "Too large to send: second.txt",
      );

      await composer.press("Enter");
      const request = await gateway.waitForRequest("chat.send");
      expect(request.params).toMatchObject({
        attachments: [{ fileName: "first.txt", mimeType: "text/plain", origin: "file" }],
        message: "Send both files",
      });
    });
  });

  it("waits for a pasted image before sending its complete gateway payload", async () => {
    await withPage(async ({ page }) => {
      await installDeferredAttachmentReader(page);
      const { gateway, composer, send } = await openChat(page);
      await composer.fill("Include the image that is still loading");
      await pastePng(composer);

      await expectEnabled(send, false);
      await composer.press("Enter");
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);

      await finishRead(page);
      await page.getByRole("img", { name: "pixel.png" }).waitFor();
      await expectEnabled(send);
      await send.click();

      const request = await gateway.waitForRequest("chat.send");
      expect(request.params).toMatchObject({
        attachments: [pngPayload()],
        message: "Include the image that is still loading",
      });
    });
  });

  it("keeps a session's pending image isolated while another session is active", async () => {
    const firstSession = "agent:main:attachment-session-a";
    const secondSession = "agent:main:attachment-session-b";
    await withPage(async ({ page }) => {
      await installDeferredAttachmentReader(page);
      const { gateway, send } = await openChat(page, {
        methodResponses: {
          "sessions.list": sessionList(firstSession, secondSession),
        },
        sessionKey: firstSession,
      });

      await activeComposer(page).fill("Private session A attachment");
      await pastePng(activeComposer(page));
      await expectEnabled(send, false);

      await navigateToControlUiSession(page, secondSession);

      await expect.poll(() => readAborts(page)).toBe(0);
      await expectCount(activeAttachments(page), 0);

      await activeComposer(page).fill("Safe session B message");
      await activeComposer(page).press("Enter");
      const request = await gateway.waitForRequest("chat.send");
      expect(request.params).toMatchObject({
        message: "Safe session B message",
        sessionKey: secondSession,
      });
      expect((request.params as { attachments?: unknown }).attachments).toBeUndefined();

      await navigateToControlUiSession(page, firstSession);
      await finishRead(page);
      await activePane(page).getByRole("img", { name: "pixel.png" }).waitFor();
    });
  });

  it("settles an eventless stalled attachment read through failure, preserves draft, and releases send", async () => {
    await withPage(async ({ page }) => {
      await installDeferredAttachmentReader(page);
      const { gateway, composer, send } = await openChat(page);
      const draftText = "Draft message while attachment read stalls";
      await composer.fill(draftText);

      await page.clock.install();
      await pastePng(composer);

      await expectEnabled(send, false);
      await page.locator(".chat-attachment-loading").waitFor();

      await page.clock.runFor(15_001);

      await page.locator(".chat-attachment-thumb--error").waitFor();
      await page.locator(".chat-attachment-error").waitFor();
      await expectEnabled(send);

      await page.locator(".chat-attachment-remove").first().click();
      await expectCount(page.locator(".chat-attachment-thumb"), 0);
      expect(await composer.inputValue()).toBe(draftText);
      await expectEnabled(send);

      await send.click();
      const request = await gateway.waitForRequest("chat.send");
      expect(request.params).toMatchObject({ message: draftText });
      expect((request.params as { attachments?: unknown }).attachments).toBeUndefined();
      await expectValue(composer, "");

      expect(await readAborts(page)).toBe(1);
    });
  });
});
