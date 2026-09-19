import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { fillComposer } from "../test-helpers/composer-editor.ts";
import {
  waitForControlUiGatewayReady,
  waitForControlUiGatewayReconnecting,
} from "../test-helpers/control-ui-e2e-readiness.ts";
import {
  captureUiProofEnabled,
  createChatFlowE2eSuite,
  expectRequestCountStable,
  installMockGateway,
  requireRecord,
} from "./chat-flow.test-support.ts";
import { outboxPayloadFile, stageOutboxAttachment } from "./chat-outbox-payloads.test-support.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";

const suite = createChatFlowE2eSuite();

const QUEUED = ["review the migration", "then update the docs", "finally run the smoke"] as const;

function storedQueueOrder(page: Page) {
  return page.evaluate(() =>
    Object.entries(sessionStorage)
      .filter(([key]) => key.startsWith("openclaw.control.chatComposer.v4:"))
      .flatMap(([, value]) => {
        try {
          const parsed = JSON.parse(value) as {
            sessions?: Record<
              string,
              { queue?: { text?: unknown; orderKey?: unknown; createdAt?: unknown }[] }
            >;
          };
          return Object.values(parsed.sessions ?? {}).flatMap((session) => session.queue ?? []);
        } catch {
          return [];
        }
      })
      .toSorted(
        (left, right) =>
          (typeof left.orderKey === "number" ? left.orderKey : Number(left.createdAt)) -
          (typeof right.orderKey === "number" ? right.orderKey : Number(right.createdAt)),
      )
      .map((item) => item.text),
  );
}

suite.define(() => {
  it("delivers the reordered head after a reconnect attachment read settles", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const gateway = await installMockGateway(page, {
        historyMessages: [{ role: "assistant", content: "Synthetic queue ordering proof." }],
        sessionInfo: { key: "main", hasActiveRun: false, status: "done" },
      });
      await page.goto(`${suite.server.baseUrl}chat`);
      await waitForControlUiGatewayReady(page);
      await page.locator(".agent-chat__composer-combobox openclaw-composer-editor").waitFor();
      await page.getByText("Synthetic queue ordering proof.", { exact: true }).waitFor();
      await gateway.setOnline(false);
      await gateway.closeLatest();
      await waitForControlUiGatewayReconnecting(page);
      await stageOutboxAttachment(page, "A: review the attached itinerary");
      const composer = page.locator(".agent-chat__composer-combobox openclaw-composer-editor");
      await composer.press("Enter");
      await page.locator(".chat-queue__item", { hasText: "A: review" }).waitFor();
      await fillComposer(composer, "B: read this instruction first");
      await composer.press("Enter");
      await page.locator(".chat-queue__item", { hasText: "B: read" }).waitFor();
      // Hold the browser's real Blob decoder after offline admission has stored every byte.
      await page.evaluate(() => {
        const NativeFileReader = FileReader;
        const pending: Array<() => void> = [];
        globalThis.FileReader = class extends NativeFileReader {
          override readAsDataURL(blob: Blob): void {
            pending.push(() => super.readAsDataURL(blob));
          }
        };
        Object.assign(window, {
          queuedAttachmentRead: {
            count: () => pending.length,
            release: () => {
              globalThis.FileReader = NativeFileReader;
              pending.splice(0).forEach((resume) => resume());
            },
          },
        });
      });
      await gateway.deferNext("chat.send");
      await gateway.setOnline(true);
      await waitForControlUiGatewayReady(page);
      await expect
        .poll(() =>
          page.evaluate(() =>
            (
              window as unknown as { queuedAttachmentRead: { count(): number } }
            ).queuedAttachmentRead.count(),
          ),
        )
        .toBeGreaterThan(0);
      await page
        .locator(".chat-queue__item", { hasText: "B: read" })
        .locator(".chat-queue__grip")
        .focus();
      await page.keyboard.press("ArrowUp");
      const expected = ["B: read this instruction first", "A: review the attached itinerary"];
      await expect.poll(() => storedQueueOrder(page)).toEqual(expected);
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);
      await page.screenshot({
        path: path.join(suite.artifactDir, "hydration-reordered.png"),
        animations: "disabled",
      });
      await page.evaluate(() =>
        (
          window as unknown as { queuedAttachmentRead: { release(): void } }
        ).queuedAttachmentRead.release(),
      );
      const first = requireRecord((await gateway.waitForRequest("chat.send")).params);
      await page.locator(".chat-group.user", { hasText: String(first.message) }).waitFor();
      await page.screenshot({
        path: path.join(suite.artifactDir, "hydration-first-delivery.png"),
        animations: "disabled",
      });
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

  it("reorders offline queued messages from the keyboard-focused handle", async () => {
    const context = await suite.newBrowserContext(createControlUiE2eContextOptions());
    const page = await context.newPage();
    const gateway = await installMockGateway(page);

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      const composer = page.locator(".agent-chat__composer-combobox openclaw-composer-editor");
      await composer.waitFor({ state: "visible", timeout: 15_000 });

      // Offline is the honest way to hold a queue still: nothing drains while
      // the Gateway is gone, so the rows stay observable.
      await gateway.setOnline(false);
      await gateway.closeLatest();
      for (const message of QUEUED) {
        await fillComposer(composer, message);
        await composer.press("Enter");
        await page.locator(".chat-queue__item", { hasText: message }).waitFor({ timeout: 10_000 });
      }

      const queueText = () => page.locator(".chat-queue__item .chat-queue__text").allTextContents();
      expect(await queueText()).toEqual([...QUEUED]);

      // One handle per movable row, and it is the whole reorder surface.
      expect(await page.locator(".chat-queue__grip").count()).toBe(QUEUED.length);

      // Keyboard path: focus the last row's handle and walk it up the queue.
      await page.locator(".chat-queue__item").nth(2).locator(".chat-queue__grip").focus();
      await page.keyboard.press("ArrowUp");

      await expect.poll(queueText, { timeout: 10_000 }).toEqual([QUEUED[0], QUEUED[2], QUEUED[1]]);

      // Focus follows the moved row, so a second press keeps moving the same one.
      await page.keyboard.press("ArrowUp");

      await expect.poll(queueText, { timeout: 10_000 }).toEqual([QUEUED[2], QUEUED[0], QUEUED[1]]);
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it.each(["keyboard", "drag"] as const)(
    "keeps a reconnecting send ahead of queued messages reordered by %s",
    async (interaction) => {
      const context = await suite.newBrowserContext(createControlUiE2eContextOptions());
      const page = await context.newPage();
      const gateway = await installMockGateway(page);

      try {
        await page.goto(`${suite.server.baseUrl}chat`);
        const composer = page.locator(".agent-chat__composer-combobox openclaw-composer-editor");
        await composer.waitFor({ state: "visible", timeout: 15_000 });
        await gateway.deferNext("chat.send");
        await fillComposer(composer, QUEUED[0]);
        await composer.press("Enter");
        await gateway.waitForRequest("chat.send");
        await gateway.setOnline(false);
        await page
          .locator('.chat-send-status[data-send-state="waiting-reconnect"]')
          .getByText("Waiting for reconnect", { exact: true })
          .waitFor();

        for (const message of QUEUED.slice(1)) {
          await fillComposer(composer, message);
          await composer.press("Enter");
          await page.locator(".chat-queue__item", { hasText: message }).waitFor();
        }

        const queueText = () =>
          page.locator(".chat-queue__item .chat-queue__text").allTextContents();
        expect(await queueText()).toEqual([QUEUED[1], QUEUED[2]]);
        expect(await storedQueueOrder(page)).toEqual([...QUEUED]);
        expect(
          await page.locator(".chat-group.user").getByText(QUEUED[0], { exact: true }).count(),
        ).toBe(1);

        const movingRow = page.locator(".chat-queue__item", { hasText: QUEUED[2] });
        const handle = movingRow.locator(".chat-queue__grip");
        if (interaction === "keyboard") {
          await handle.focus();
          await page.keyboard.press("ArrowUp");
        } else {
          const target = page.locator(".chat-queue__item", { hasText: QUEUED[1] });
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
      } finally {
        await suite.closeBrowserContext(context);
      }
    },
  );

  it("keeps the queue order consistent through a reload after a mid-reorder storage failure", async () => {
    if (captureUiProofEnabled) {
      await mkdir(path.join(suite.artifactDir, "queue-reorder-failure-reload"), {
        recursive: true,
      });
    }
    const context = await suite.newBrowserContext(createControlUiE2eContextOptions());
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
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

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      const composer = page.locator(".agent-chat__composer-combobox openclaw-composer-editor");
      await composer.waitFor({ state: "visible", timeout: 15_000 });

      await gateway.setOnline(false);
      await gateway.closeLatest();
      for (const message of QUEUED) {
        await fillComposer(composer, message);
        await composer.press("Enter");
        await page.locator(".chat-queue__item", { hasText: message }).waitFor({ timeout: 10_000 });
      }

      const queueText = () => page.locator(".chat-queue__item .chat-queue__text").allTextContents();
      expect(await queueText()).toEqual([...QUEUED]);
      if (captureUiProofEnabled) {
        await page.screenshot({
          path: `${path.join(suite.artifactDir, "queue-reorder-failure-reload")}/01-queued-before-failure.png`,
        });
      }

      // Break durable storage for the rest of this page's lifetime, then attempt
      // a reorder. A real `sessionStorage.setItem` failure (quota, private mode,
      // disabled storage) landing mid-batch must reject the whole permutation
      // instead of applying it partway, so the order has to stay exactly what
      // it was — never a mix of the attempted and original arrangements.
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
      if (captureUiProofEnabled) {
        await page.screenshot({
          path: `${path.join(suite.artifactDir, "queue-reorder-failure-reload")}/02-order-unchanged-after-failure.png`,
        });
      }

      // A fresh load reads back only what actually made it to storage. Seeing the
      // same order here (not a mix of the attempted and original permutations)
      // is the proof: the failed batch never left a half-applied reorder behind.
      // The app only mounts its session UI once the Gateway connects, so the
      // storage-level readback below runs first, while this reload is still
      // offline, exactly as the cold-reload offline-queue proof elsewhere does.
      await page.reload();
      expect(await storedQueueOrder(page)).toEqual([...QUEUED]);

      // Bringing the Gateway back lets the app mount its session UI so the same
      // order can be confirmed rendered, not just stored.
      await gateway.setOnline(true);
      await page.locator("openclaw-chat-pane").waitFor({ state: "attached", timeout: 15_000 });
      await page.locator(".chat-queue__item", { hasText: QUEUED[0] }).waitFor({ timeout: 10_000 });
      expect(await queueText()).toEqual([...QUEUED]);
      if (captureUiProofEnabled) {
        await page.screenshot({
          path: `${path.join(suite.artifactDir, "queue-reorder-failure-reload")}/03-consistent-order-after-reload.png`,
        });
      }
    } finally {
      await suite.closeBrowserContext(context);
    }
  });
});
