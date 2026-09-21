import { expect, it } from "vitest";
import {
  createChatFlowE2eSuite,
  installMockGateway,
  requireRecord,
  requireString,
} from "./chat-flow.test-support.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";

const suite = createChatFlowE2eSuite();

suite.define(() => {
  it("sanitizes a long split memory tag through cumulative snapshots", async () => {
    const context = await suite.newBrowserContext(createControlUiE2eContextOptions());
    const page = await context.newPage();
    const gateway = await installMockGateway(page);

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      await page.locator(".agent-chat__composer-combobox textarea").fill("long split syntax proof");
      await page.getByRole("button", { name: "Send message" }).click();
      const sendRequest = await gateway.waitForRequest("chat.send");
      const runId = requireString(
        requireRecord(sendRequest.params).idempotencyKey,
        "chat send idempotency key",
      );
      const opener = `<relevant-memories data-proof="${"x".repeat(300)}"`;
      await gateway.emitGatewayEvent("chat", {
        deltaText: opener,
        message: {
          content: [{ text: opener, type: "text" }],
          role: "assistant",
          timestamp: Date.now(),
        },
        runId,
        sessionKey: "main",
        state: "delta",
      });
      await gateway.emitGatewayEvent("chat", {
        deltaText: ">hidden",
        message: {
          content: [{ text: `${opener}>hidden`, type: "text" }],
          role: "assistant",
          timestamp: Date.now(),
        },
        runId,
        sessionKey: "main",
        state: "delta",
      });

      const transcript = page.locator(".chat-thread-inner");
      await expect.poll(() => transcript.textContent()).not.toContain("hidden");

      const visibleDelta = "</relevant-memories>\nVisible";
      await gateway.emitGatewayEvent("chat", {
        deltaText: visibleDelta,
        message: {
          content: [{ text: `${opener}>hidden${visibleDelta}`, type: "text" }],
          role: "assistant",
          timestamp: Date.now(),
        },
        runId,
        sessionKey: "main",
        state: "delta",
      });
      await transcript.getByText("Visible", { exact: true }).waitFor();
      expect(await transcript.textContent()).not.toContain("relevant-memories");
      expect(await transcript.textContent()).not.toContain("hidden");
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("sanitizes a long split trace and reconciles the persisted reply", async () => {
    const context = await suite.newBrowserContext(createControlUiE2eContextOptions());
    const page = await context.newPage();
    const gateway = await installMockGateway(page);

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      await page.locator(".agent-chat__composer-combobox textarea").fill("long trace proof");
      await page.getByRole("button", { name: "Send message" }).click();
      const sendRequest = await gateway.waitForRequest("chat.send");
      const runId = requireString(
        requireRecord(sendRequest.params).idempotencyKey,
        "chat send idempotency key",
      );
      const prefix = `🛠️${" ".repeat(300)}`;
      await gateway.emitGatewayEvent("chat", {
        deltaText: prefix,
        message: {
          content: [{ text: prefix, type: "text" }],
          role: "assistant",
          timestamp: Date.now(),
        },
        runId,
        sessionKey: "main",
        state: "delta",
      });
      const completion = "git status\nVisible";
      await gateway.emitGatewayEvent("chat", {
        deltaText: completion,
        message: {
          content: [{ text: `${prefix}${completion}`, type: "text" }],
          role: "assistant",
          timestamp: Date.now(),
        },
        runId,
        sessionKey: "main",
        state: "delta",
      });

      const transcript = page.locator(".chat-thread-inner");
      await transcript.getByText("Visible", { exact: true }).waitFor();
      expect(await transcript.textContent()).not.toContain("🛠️");
      expect(await transcript.textContent()).not.toContain("git status");
      expect(await transcript.textContent()).not.toContain("hidden");

      await gateway.emitChatFinal({ runId, text: "Visible" });
      await expect.poll(() => transcript.getByText("Visible", { exact: true }).count()).toBe(1);
      expect(await page.locator(".chat-bubble.streaming").count()).toBe(0);
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("processes a cumulative snapshot burst through the production chat path", async () => {
    const context = await suite.newBrowserContext(createControlUiE2eContextOptions());
    const page = await context.newPage();
    const gateway = await installMockGateway(page);

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      await page.locator(".agent-chat__composer-combobox textarea").fill("cumulative burst proof");
      await page.getByRole("button", { name: "Send message" }).click();
      const sendRequest = await gateway.waitForRequest("chat.send");
      const runId = requireString(
        requireRecord(sendRequest.params).idempotencyKey,
        "chat send idempotency key",
      );
      const metrics = await page.evaluate(
        ({ targetRunId, count, payloadSize }) => {
          const mockGateway = (
            window as Window & {
              openclawControlUiE2eGateway?: {
                emit: (event: string, payload?: unknown) => void;
              };
            }
          ).openclawControlUiE2eGateway;
          if (!mockGateway) {
            throw new Error("mock gateway handle missing");
          }
          const originalReplace = Object.getOwnPropertyDescriptor(String.prototype, "replace")
            ?.value as typeof String.prototype.replace;
          let maxReplaceInputChars = 0;
          let replaceCalls = 0;
          let cumulativeText = "";
          const startedAt = performance.now();
          // eslint-disable-next-line no-extend-native -- bounded proof instruments production replacement inputs and restores in finally
          String.prototype.replace = function (
            this: string,
            searchValue: string | RegExp,
            replaceValue: string | ((substring: string, ...args: unknown[]) => string),
          ) {
            const source = String(this);
            if (source.includes("burst-")) {
              replaceCalls += 1;
              maxReplaceInputChars = Math.max(maxReplaceInputChars, source.length);
            }
            return Reflect.apply(originalReplace, source, [searchValue, replaceValue]);
          } as typeof String.prototype.replace;
          try {
            for (let index = 1; index <= count; index += 1) {
              const deltaText = ` ${"x".repeat(payloadSize)} burst-${index}`;
              cumulativeText += deltaText;
              mockGateway.emit("chat", {
                deltaText,
                message: {
                  content: [{ text: cumulativeText, type: "text" }],
                  role: "assistant",
                  timestamp: Date.now(),
                },
                runId: targetRunId,
                sessionKey: "main",
                state: "delta",
              });
            }
          } finally {
            // eslint-disable-next-line no-extend-native -- restore the exact built-in captured above
            String.prototype.replace = originalReplace;
          }
          return {
            cumulativeChars: cumulativeText.length,
            deltaCount: count,
            elapsedMs: performance.now() - startedAt,
            maxReplaceInputChars,
            replaceCalls,
          };
        },
        { targetRunId: runId, count: 240, payloadSize: 512 },
      );

      const transcript = page.locator(".chat-thread-inner");
      await expect.poll(() => transcript.textContent()).toContain("burst-240");
      console.info(`[chat-cumulative-snapshot-proof] ${JSON.stringify(metrics)}`);
      expect(metrics.cumulativeChars).toBeGreaterThan(120_000);
      expect(metrics.maxReplaceInputChars).toBeLessThan(2_048);
      expect(metrics.replaceCalls).toBeGreaterThan(0);
      expect(metrics.elapsedMs).toBeLessThan(5_000);
    } finally {
      await suite.closeBrowserContext(context);
    }
  });
});
