// Control UI regression proof for #99213: paste a large screenshot-like PNG through the
// real chat composer and verify chat.send receives it without overflowing base64 handling.
import { copyFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { crc32 } from "node:zlib";
import type { BrowserContext, Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { createRequireRecord } from "../../../test/helpers/record.js";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiViewportScreenshot } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { controlUiE2eWaitTimeoutMs, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createChatFlowE2eSuite } from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();
const viewport = { height: 900, width: 1280 };

type RecordedPage = {
  context: BrowserContext;
  page: Page;
  rawVideoDir: string;
};

const requireRecord = createRequireRecord("record", "expected-label-object-capitalized");

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) {
    throw new Error(`Expected non-empty ${label}`);
  }
  return value;
}

function chunk(type: string, payload: Uint8Array): Buffer {
  const result = Buffer.alloc(12 + payload.length);
  result.writeUInt32BE(payload.length, 0);
  result.write(type, 4, "ascii");
  result.set(payload, 8);
  result.writeUInt32BE(crc32(result.subarray(4, 8 + payload.length)), 8 + payload.length);
  return result;
}

function createLargePngBytes(targetBytes: number): Uint8Array {
  const signature = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
  const ihdr = chunk("IHDR", Uint8Array.of(0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0));
  const idat = chunk(
    "IDAT",
    Uint8Array.of(0x78, 0x9c, 0x63, 0xf8, 0xcf, 0xc0, 0xf0, 0x1f, 0x00, 0x05, 0x00, 0x01, 0xff),
  );
  const iend = chunk("IEND", new Uint8Array());
  const fixedBytes = signature.length + ihdr.length + idat.length + iend.length + 12;
  const payload = new Uint8Array(Math.max(0, targetBytes - fixedBytes));
  for (let i = 0; i < payload.length; i += 1) {
    payload[i] = 0x41 + (i % 26);
  }
  return Buffer.concat([signature, ihdr, chunk("tEXt", payload), idat, iend]);
}

async function newRecordedPage(artifactDir: string, label: string): Promise<RecordedPage> {
  const rawVideoDir = createControlUiE2eArtifactDir(`${label}-raw`, artifactDir);
  const context = await suite.newBrowserContext({
    locale: "en-US",
    permissions: ["clipboard-read", "clipboard-write"],
    recordVideo: {
      dir: rawVideoDir,
      size: viewport,
    },
    serviceWorkers: "block",
    viewport,
  });
  const page = await context.newPage();
  page.setDefaultTimeout(controlUiE2eWaitTimeoutMs);
  return { context, page, rawVideoDir };
}

async function closeRecordedPage(
  recorded: RecordedPage,
  artifactDir: string,
  label: string,
): Promise<string[]> {
  const video = recorded.page.video();
  await suite.closeBrowserContext(recorded.context);
  if (!video) {
    return [];
  }
  const videoPath = path.join(artifactDir, `${label}.webm`);
  await copyFile(await video.path(), videoPath);
  // Failed finalization leaves the raw recording available for inspection.
  await rm(recorded.rawVideoDir, { force: true, recursive: true });
  return [videoPath];
}

suite.define(() => {
  it("sends a roughly 2 MB PNG without overlapping transcript rows", async () => {
    const artifactDir = createControlUiE2eArtifactDir("chat-large-paste-99213");
    const pngBytes = createLargePngBytes(1_901_669);
    const imageBase64 = Buffer.from(pngBytes).toString("base64");
    const dataUrl = `data:image/png;base64,${imageBase64}`;
    const prompt = "proof: large Control UI clipboard image";
    const recorded = await newRecordedPage(artifactDir, "large-paste");
    const page = recorded.page;
    const previousReply = "The existing assistant reply is taller than the virtualizer estimate.";
    const finalReply = "Large screenshot paste proof received.";
    const screenshots: string[] = [];
    const capture = async (name: string, target: Locator) => {
      const destination = path.join(artifactDir, name);
      await writeFile(
        destination,
        await takeControlUiViewportScreenshot(page, page.locator(".shell"), [target]),
      );
      screenshots.push(destination);
    };
    let videos: string[];

    try {
      const gateway = await installMockGateway(page, {
        historyMessages: [
          {
            content: [
              {
                text: `${previousReply}\n\n${["First", "Second", "Third", "Fourth", "Fifth"].map((ordinal) => `- ${ordinal} line of the existing answer.`).join("\n")}`,
                type: "text",
              },
            ],
            role: "assistant",
            timestamp: Date.now(),
          },
        ],
      });

      await recorded.page.goto(`${suite.server.baseUrl}chat`);
      await recorded.page
        .getByText("The existing assistant reply is taller than the virtualizer estimate.")
        .waitFor({ timeout: 10_000 });

      const composer = recorded.page.locator(".agent-chat__composer-combobox textarea");
      await composer.focus();
      await recorded.page.evaluate(async (text) => {
        await navigator.clipboard.writeText(text);
      }, dataUrl);
      await composer.press(process.platform === "darwin" ? "Meta+V" : "Control+V");

      await recorded.page.locator(".chat-attachment-thumb").waitFor({ state: "visible" });
      await composer.fill(prompt);
      await capture("01-pasted-large-image.png", page.locator(".chat-attachment-thumb"));

      await recorded.page.getByRole("button", { name: "Send message" }).click();
      const sendRequest = await gateway.waitForRequest("chat.send");
      const params = requireRecord(sendRequest.params, "chat.send params");
      expect(params).toMatchObject({
        message: prompt,
        attachments: [
          {
            type: "image",
            mimeType: "image/png",
            fileName: "pasted-image.png",
            content: imageBase64,
          },
        ],
      });

      const assistantRow = recorded.page
        .getByText("The existing assistant reply is taller than the virtualizer estimate.")
        .locator("xpath=ancestor::div[contains(@class, 'chat-virtual-row')]");
      const userRow = recorded.page
        .getByText(prompt)
        .locator("xpath=ancestor::div[contains(@class, 'chat-virtual-row')]");
      await expect
        .poll(async () => {
          const [assistantBounds, userBounds] = await Promise.all([
            assistantRow.boundingBox(),
            userRow.boundingBox(),
          ]);
          if (!assistantBounds || !userBounds) {
            return Number.NEGATIVE_INFINITY;
          }
          return Math.round(userBounds.y - (assistantBounds.y + assistantBounds.height));
        })
        .toBeGreaterThanOrEqual(0);

      const runId = requireString(params.idempotencyKey, "chat send idempotency key");
      await gateway.emitChatFinal({ runId, text: finalReply });
      const finalRow = page.locator(".chat-thread-inner").getByText(finalReply);
      await finalRow.waitFor({ timeout: 10_000 });
      await capture("02-sent-large-image.png", finalRow);
    } finally {
      videos = await closeRecordedPage(recorded, artifactDir, "large-paste");
    }

    const summary = {
      base64Chars: imageBase64.length,
      dataUrlChars: dataUrl.length,
      pngBytes: pngBytes.length,
      screenshots,
      videos,
    };
    await writeFile(
      path.join(artifactDir, "summary.json"),
      `${JSON.stringify(summary, null, 2)}\n`,
    );
  });
});
