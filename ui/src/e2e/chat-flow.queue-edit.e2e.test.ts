import type { Page } from "playwright";
import { expect, it } from "vitest";
import {
  confirmIme,
  newChatPage,
  QUEUED,
  queueMessages,
  createChatFlowE2eSuite,
  expectRequestCountStable,
  installMockGateway,
  requireRecord,
  requireString,
  waitForRequests,
} from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();
const wait = { timeout: 10_000 };
const detached = { ...wait, state: "detached" as const };

function queueUi(page: Page) {
  const rows = page.locator(".chat-queue__item");
  return {
    rows,
    row: (text: string) => rows.filter({ hasText: text }),
    text: () => rows.locator(".chat-queue__text").allTextContents(),
    async edit(index = 1) {
      await rows.nth(index).dblclick();
      const editor = rows.nth(index).locator(".chat-queue__edit-input");
      await editor.waitFor(wait);
      return editor;
    },
  };
}

async function offlineQueue() {
  const page = await newChatPage(suite);
  const gateway = await installMockGateway(page);
  await page.goto(`${suite.server.baseUrl}chat`);
  const composer = page.locator(".agent-chat__composer-combobox textarea");
  await composer.waitFor({ state: "visible", timeout: 15_000 });
  await page.locator(".agent-chat__welcome").waitFor({ state: "visible" });
  await gateway.setOnline(false);
  await gateway.closeLatest();
  await queueMessages(page);
  return { page, gateway, composer, ...queueUi(page) };
}

suite.define(() => {
  it("edits a queued message in its row and returns it to its place", async () => {
    const { page, gateway, composer, rows, edit } = await offlineQueue();
    const queueText = () =>
      rows.evaluateAll((elements) =>
        elements.map((row) => {
          const editor = row.querySelector(".chat-queue__edit-input");
          return editor instanceof HTMLTextAreaElement
            ? editor.value
            : (row.querySelector(".chat-queue__text")?.textContent ?? "");
        }),
      );
    expect(await queueText()).toEqual([...QUEUED]);
    expect(await page.locator(".chat-queue__grip").count()).toBe(QUEUED.length);

    await composer.fill("a separate composer draft");

    const rowEditor = await edit();
    await rowEditor.press("ControlOrMeta+A");
    expect(await rowEditor.inputValue()).toBe(QUEUED[1]);
    expect(await composer.inputValue()).toBe("a separate composer draft");
    expect(await queueText()).toEqual([...QUEUED]);
    expect(await page.locator(".chat-queue__item--editing").count()).toBe(1);

    await rowEditor.fill("日本語の編集");
    expect(await confirmIme(rowEditor, "日本語の編集")).toBe(false);
    expect(await rowEditor.isVisible()).toBe(true);
    expect(await gateway.getRequests("chat.send")).toHaveLength(0);
    await rowEditor.dispatchEvent("keyup", { key: "Enter" });
    await rowEditor.press("Enter");

    await expect.poll(queueText, wait).toEqual([QUEUED[0], "日本語の編集", QUEUED[2]]);
    await expect.poll(() => page.locator(".chat-queue__item--editing").count()).toBe(0);
    expect(await composer.inputValue()).toBe("a separate composer draft");
  });

  it("puts the row back untouched when the edit is cancelled", async () => {
    const { composer, edit, text } = await offlineQueue();
    await composer.fill("a separate composer draft");
    const rowEditor = await edit();
    await rowEditor.fill("a replacement the operator abandons");

    await rowEditor.press("Escape");

    await expect.poll(text, wait).toEqual([...QUEUED]);
    expect(await composer.inputValue()).toBe("a separate composer draft");
  });

  it("keeps a normal composer send separate from an open row edit", async () => {
    const { composer, rows, row, edit, text } = await offlineQueue();
    const rowEditor = await edit();
    await composer.fill("a separate composer send");
    await composer.press("Enter");

    await row("a separate composer send").waitFor(wait);
    await expect.poll(() => rowEditor.inputValue(), wait).toBe(QUEUED[1]);
    expect(await composer.inputValue()).toBe("");
    expect(await rows.count()).toBe(4);

    await rowEditor.press("Escape");
    await expect.poll(text, wait).toEqual([...QUEUED, "a separate composer send"]);
  });

  it("keeps edit, remove, and reorder outcomes exact through reconnect", async () => {
    const page = await newChatPage(suite);
    const queue = queueUi(page);
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "chat.history": {
          messages: [],
          sessionId: "session:agent:main:main",
          sessionInfo: { hasActiveRun: false, status: "done" },
          thinkingLevel: null,
        },
      },
    });

    await page.goto(`${suite.server.baseUrl}settings/appearance`);
    await page.locator("[data-settings-follow-up-mode]").selectOption("queue");
    await page.goto(`${suite.server.baseUrl}chat?session=main`);
    const composer = page.locator(".agent-chat__composer-combobox textarea");
    await composer.waitFor({ state: "visible", timeout: 15_000 });
    await composer.fill("keep the first run active");
    await page.getByRole("button", { name: "Send message" }).click();
    const active = requireRecord((await gateway.waitForRequest("chat.send")).params);
    const activeRunId = requireString(active.idempotencyKey, "active run idempotency key");
    await page.getByRole("button", { name: "Stop generating" }).waitFor(wait);

    const acceptedSession = {
      key: "agent:main:main",
      sessionId: "session:agent:main:main",
      hasActiveRun: true,
      activeRunIds: [activeRunId],
      status: "running",
    };
    const history = (sessionInfo: typeof acceptedSession) => ({
      sessionId: acceptedSession.sessionId,
      sessionInfo,
      messages: [
        {
          role: "user",
          content: "keep the first run active",
          idempotencyKey: `${activeRunId}:user`,
        },
      ],
    });
    await gateway.setMethodResponse("chat.history", history(acceptedSession));
    await gateway.emitGatewayEvent("sessions.changed", acceptedSession);
    await page.locator(".chat-send-status").waitFor({ state: "detached" });

    for (const message of ["send first", "edit before send", "remove me", "send last"]) {
      await composer.fill(message);
      await page.getByRole("button", { name: "Queue message" }).click();
      await queue.row(message).waitFor(wait);
    }
    await queue.row("edit before send").dblclick();
    await gateway.setOnline(false);
    await gateway.closeLatest();
    await page.locator(".agent-chat__input--offline").waitFor(wait);

    // `hasText` stops matching once the row text becomes a textarea value.
    const inlineEditor = page.locator(".chat-queue__edit-input");
    await inlineEditor.waitFor(wait);
    await inlineEditor.press("ControlOrMeta+A");
    await page.keyboard.insertText("edited before send");
    await inlineEditor.press("Control+Enter");
    await queue.row("edited before send").waitFor();
    expect(await page.getByRole("alert").count()).toBe(0);

    await queue.row("send last").locator(".chat-queue__grip").focus();
    for (const expected of [
      ["send first", "edited before send", "send last", "remove me"],
      ["send first", "send last", "edited before send", "remove me"],
      ["send last", "send first", "edited before send", "remove me"],
    ]) {
      await page.keyboard.press("ArrowUp");
      await expect.poll(queue.text).toEqual(expected);
    }

    const row = queue.row("remove me");

    const storage = await page.evaluateHandle(() => {
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function (this: Storage, ...args: [string, string]) {
        if (this === window.sessionStorage) {
          throw new DOMException("exceeded the quota", "QuotaExceededError");
        }
        return Reflect.apply(original, this, args);
      };
      return {
        restore: () => {
          Storage.prototype.setItem = original;
        },
      };
    });
    await row.locator(".chat-queue__remove").click();

    await page
      .getByRole("alert")
      .getByText("Could not store this message for reconnect.", { exact: false })
      .waitFor(wait);
    await row.waitFor();
    expect(await gateway.getRequests("chat.send")).toHaveLength(1);

    await storage.evaluate((owner) => owner.restore());
    await storage.dispose();
    const clicks = await page.evaluateHandle(() => {
      const trace: Array<{ detail: number; rowText?: string }> = [];
      document.addEventListener(
        "click",
        (event) => {
          const target = event.target instanceof Element ? event.target : null;
          trace.push({
            detail: event.detail,
            rowText: target?.closest(".chat-queue__item")?.querySelector(".chat-queue__text")
              ?.textContent,
          });
        },
        { capture: true },
      );
      return trace;
    });
    await row.locator(".chat-queue__remove").click();
    await row.waitFor(detached);
    // Queue reflow can move the next row away from the first click's coordinates.
    // Aim the native second click at its remove control without another first click.
    await queue.row("edited before send").locator(".chat-queue__remove").hover();
    await page.mouse.down({ clickCount: 2 });
    await page.mouse.up({ clickCount: 2 });
    expect(await clicks.jsonValue()).toEqual([
      { detail: 1, rowText: "remove me" },
      { detail: 2, rowText: "edited before send" },
    ]);
    await clicks.dispose();
    await page.getByRole("alert").waitFor(detached);
    await expect.poll(queue.text).toEqual(["send last", "send first", "edited before send"]);
    expect(await gateway.getRequests("chat.send")).toHaveLength(1);

    // The preceding successful pointer removal already covers single-click activation.
    await queueMessages(page, ["keyboard removal"]);
    const keyboardRow = queue.row("keyboard removal");
    await keyboardRow.locator(".chat-queue__remove").focus();
    await page.keyboard.press("Enter");
    await keyboardRow.waitFor(detached);
    // Remove at the first DOM commit, before yielded delivery can resume.
    // Programmatic activation must keep cancellation exact even at this boundary.
    const removal = await page.evaluateHandle(() => {
      let removed = false;
      const observer = new MutationObserver(() => {
        const queuedRow = [...document.querySelectorAll(".chat-queue__item")].find(
          (item) => item.querySelector(".chat-queue__text")?.textContent === "programmatic removal",
        );
        const button = queuedRow?.querySelector<HTMLButtonElement>(".chat-queue__remove");
        if (button) {
          observer.disconnect();
          button.click();
          removed = true;
        }
      });
      observer.observe(document, { childList: true, subtree: true });
      return { wasRemoved: () => removed };
    });
    await composer.fill("programmatic removal");
    await composer.press("Enter");
    await expect.poll(() => removal.evaluate((proof) => proof.wasRemoved())).toBe(true);
    await removal.dispose();
    await queue.row("programmatic removal").waitFor(detached);
    await expectRequestCountStable(gateway, "chat.send", 1);
    await page.getByRole("alert").waitFor(detached);
    expect(await gateway.getRequests("chat.send")).toHaveLength(1);

    const terminalSession = {
      ...acceptedSession,
      activeRunIds: [],
      hasActiveRun: false,
      lastRunId: activeRunId,
      status: "done",
    };
    await gateway.setMethodResponse("chat.history", history(terminalSession));
    await gateway.deferNext("chat.send");
    await gateway.setOnline(true);
    await page.locator(".agent-chat__input--offline").waitFor(detached);
    await gateway.emitChatFinal({ runId: activeRunId, text: "Initial run completed." });
    await gateway.emitGatewayEvent("sessions.changed", terminalSession);

    for (const [index, ordinal] of ["First", "Second", "Third"].entries()) {
      const send = requireRecord(
        (await waitForRequests(gateway, "chat.send", index + 2))[index + 1]?.params,
      );
      const runId = requireString(send.idempotencyKey, `${ordinal} queued send idempotency key`);
      if (index === 0) {
        expect(send.message).toBe("send last");
        await gateway.resolveDeferred("chat.send");
      }
      await gateway.emitChatFinal({ runId, text: `${ordinal} queued turn completed.` });
    }
    const params = (await gateway.getRequests("chat.send")).map((request) =>
      requireRecord(request.params),
    );
    expect(params.map((entry) => entry.message)).toEqual([
      "keep the first run active",
      "send last",
      "send first",
      "edited before send",
    ]);
    expect(new Set(params.map((entry) => entry.idempotencyKey)).size).toBe(4);
    await expectRequestCountStable(gateway, "chat.send", 4);
    await page.locator(".chat-queue").waitFor(detached);
  });
});
