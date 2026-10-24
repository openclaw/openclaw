import type { Page } from "playwright";
import { expect, it } from "vitest";
import {
  waitForControlUiGatewayReady,
  waitForControlUiGatewayReconnecting,
} from "../test-helpers/control-ui-e2e-readiness.ts";
import {
  newChatPage,
  QUEUED,
  queueMessages,
  createChatFlowE2eSuite,
  expectRequestCountStable,
  installMockGateway,
  requireRecord,
} from "./chat-flow.test-support.ts";
import {
  outboxPayloadFile,
  readOutboxQueue,
  stageOutboxAttachment,
} from "./chat-outbox-payloads.test-support.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";

const suite = createChatFlowE2eSuite();

async function openChat(options?: Parameters<typeof installMockGateway>[1], existingPage?: Page) {
  const page = existingPage ?? (await newChatPage(suite));
  const gateway = await installMockGateway(page, options);
  await page.goto(`${suite.server.baseUrl}chat`);
  const composer = page.locator(".agent-chat__composer-combobox textarea");
  if (!existingPage) {
    await composer.waitFor({ state: "visible", timeout: 15_000 });
  }
  return { page, gateway, composer };
}

async function storedQueueOrder(page: Page) {
  return (await readOutboxQueue(page))
    .toSorted(
      (left, right) => (left.orderKey ?? left.createdAt) - (right.orderKey ?? right.createdAt),
    )
    .map((item) => item.text);
}

suite.define(() => {
  it("delivers the reordered head after a reconnect attachment read settles", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const { gateway, composer } = await openChat(
        {
          historyMessages: [{ role: "assistant", content: "Synthetic queue ordering proof." }],
          sessionInfo: { key: "main", hasActiveRun: false, status: "done" },
        },
        page,
      );
      await waitForControlUiGatewayReady(page);
      const rows = page.locator(".chat-queue__item");
      await composer.waitFor();
      await page.getByText("Synthetic queue ordering proof.", { exact: true }).waitFor();
      await gateway.setOnline(false);
      await gateway.closeLatest();
      await waitForControlUiGatewayReconnecting(page);
      await stageOutboxAttachment(page, "A: review the attached itinerary");
      await composer.press("Enter");
      await rows.filter({ hasText: "A: review" }).waitFor();
      await queueMessages(page, ["B: read this instruction first"]);
      // Hold the browser's real Blob decoder after offline admission has stored every byte.
      const attachmentRead = await page.evaluateHandle(() => {
        const NativeFileReader = FileReader;
        const pending: Array<() => void> = [];
        globalThis.FileReader = class extends NativeFileReader {
          override readAsDataURL(blob: Blob): void {
            pending.push(() => super.readAsDataURL(blob));
          }
        };
        return {
          count: () => pending.length,
          release: () => {
            globalThis.FileReader = NativeFileReader;
            pending.splice(0).forEach((resume) => resume());
          },
        };
      });
      await gateway.deferNext("chat.send");
      await gateway.setOnline(true);
      await waitForControlUiGatewayReady(page);
      await expect.poll(() => attachmentRead.evaluate((read) => read.count())).toBeGreaterThan(0);
      await rows.filter({ hasText: "B: read" }).locator(".chat-queue__grip").focus();
      await page.keyboard.press("ArrowUp");
      const expected = ["B: read this instruction first", "A: review the attached itinerary"];
      await expect.poll(() => storedQueueOrder(page)).toEqual(expected);
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);

      await attachmentRead.evaluate((read) => read.release());
      await attachmentRead.dispose();
      const first = requireRecord((await gateway.waitForRequest("chat.send")).params);
      await page.locator(".chat-group.user", { hasText: String(first.message) }).waitFor();

      expect(first.message).toBe(expected[0]);
      await gateway.resolveDeferred("chat.send", {
        runId: first.idempotencyKey,
        status: "ok",
        messageSeq: 1,
      });
      const second = requireRecord(
        (await gateway.waitForRequest("chat.send", { after: 1 })).params,
      );
      expect(second.message).toBe(expected[1]);
      expect(second.attachments).toEqual([
        {
          type: "file",
          mimeType: outboxPayloadFile.mimeType,
          fileName: outboxPayloadFile.name,
          origin: "file",
          content: outboxPayloadFile.buffer.toString("base64"),
        },
      ]);
      expect(
        (await gateway.getRequests("chat.send")).map(({ params }) => requireRecord(params).message),
      ).toEqual(expected);
    });
  });

  it.each(["keyboard", "drag"] as const)(
    "keeps a reconnecting send ahead of queued messages reordered by %s",
    async (interaction) => {
      const { page, gateway, composer } = await openChat();
      const rows = page.locator(".chat-queue__item");
      await gateway.deferNext("chat.send");
      await composer.fill(QUEUED[0]);
      await composer.press("Enter");
      await gateway.waitForRequest("chat.send");
      await gateway.setOnline(false);
      await page
        .locator('.chat-send-status[data-send-state="waiting-reconnect"]')
        .getByText("Waiting for reconnect", { exact: true })
        .waitFor();

      await queueMessages(page, QUEUED.slice(1));

      const queueText = () => rows.locator(".chat-queue__text").allTextContents();
      expect(await queueText()).toEqual([QUEUED[1], QUEUED[2]]);
      expect(await storedQueueOrder(page)).toEqual([...QUEUED]);
      expect(
        await page.locator(".chat-group.user").getByText(QUEUED[0], { exact: true }).count(),
      ).toBe(1);

      const handle = rows.filter({ hasText: QUEUED[2] }).locator(".chat-queue__grip");
      if (interaction === "keyboard") {
        await handle.focus();
        await page.keyboard.press("ArrowUp");
      } else {
        const target = rows.filter({ hasText: QUEUED[1] });
        const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
        try {
          // Let the handle write its own drag payload before the row accepts the drop.
          await handle.dispatchEvent("dragstart", { dataTransfer });
          await target.dispatchEvent("dragover", { dataTransfer });
          expect(await target.getAttribute("class")).toContain("chat-queue__item--drop-target");
          await target.dispatchEvent("drop", { dataTransfer });
        } finally {
          await handle.dispatchEvent("dragend", { dataTransfer });
          await dataTransfer.dispose();
        }
      }

      await expect.poll(queueText).toEqual([QUEUED[2], QUEUED[1]]);
      // The attempted send is hidden from this tray but still owns the first delivery slot.
      expect(await storedQueueOrder(page)).toEqual([QUEUED[0], QUEUED[2], QUEUED[1]]);
      if (interaction === "keyboard") {
        await page.keyboard.press("ArrowUp");
        expect(await queueText()).toEqual([QUEUED[2], QUEUED[1]]);
        expect(await storedQueueOrder(page)).toEqual([QUEUED[0], QUEUED[2], QUEUED[1]]);
      }
      await expectRequestCountStable(gateway, "chat.send", 1);
    },
  );

  it("keeps the queue order consistent through a reload after a mid-reorder storage failure", async () => {
    const { page, gateway } = await openChat({
      // A real active turn holds the restored queue while we inspect its order.
      sessions: [
        {
          key: "agent:main:main",
          kind: "direct",
          hasActiveRun: true,
          activeRunIds: ["queue-order-holder"],
          status: "running",
        },
      ],
    });

    await gateway.setOnline(false);
    await gateway.closeLatest();
    await queueMessages(page);

    const queueText = () => page.locator(".chat-queue__item .chat-queue__text").allTextContents();
    expect(await queueText()).toEqual([...QUEUED]);

    // A failed durable batch must reject the whole permutation.
    await page.evaluate(() => {
      window.sessionStorage.setItem = () => {
        throw new DOMException("quota exceeded", "QuotaExceededError");
      };
    });

    await page.locator(".chat-queue__item").nth(2).locator(".chat-queue__grip").focus();
    await page.keyboard.press("ArrowUp");

    await page
      .getByRole("alert")
      .filter({ hasText: "Could not store this message for reconnect." })
      .waitFor();
    expect(await queueText()).toEqual([...QUEUED]);

    // Check durable order before reconnect mounts the session UI.
    await page.reload();
    expect(await storedQueueOrder(page)).toEqual([...QUEUED]);

    await gateway.setOnline(true);
    await page.locator("openclaw-chat-pane").waitFor({ state: "attached", timeout: 15_000 });
    await page.locator(".chat-queue__item", { hasText: QUEUED[0] }).waitFor({ timeout: 10_000 });
    expect(await queueText()).toEqual([...QUEUED]);
  });
});
