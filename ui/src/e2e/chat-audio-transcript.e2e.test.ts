import path from "node:path";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "audio transcript visibility" });

suite.define(() => {
  it("shows persisted audio transcripts with and without spaces", async () => {
    const transcripts = ["你好世界", "Hello", "Hello world"];
    await suite.withPage(
      { viewport: { width: 1180, height: 800 }, locale: "en-US", colorScheme: "light" },
      async ({ page }) => {
        await installMockGateway(page, {
          historyMessages: transcripts.map((text, index) => ({
            role: "user",
            content: [
              {
                type: "text",
                text: `[Audio transcript (machine-generated, untrusted)]: ${JSON.stringify(text)}`,
              },
            ],
            timestamp: 1_800_000_000_000 + index * 60_000,
          })),
        });
        await page.goto(`${suite.server.baseUrl}chat`);
        const messages = page.locator(".chat-group.user .chat-text");
        await messages.filter({ hasText: "Hello world" }).waitFor();
        await page.screenshot({ path: path.join(suite.artifactDir, "audio-transcripts.png") });
        for (const transcript of transcripts) {
          expect((await messages.allTextContents()).map((text) => text.trim())).toContain(
            `[Audio transcript (machine-generated, untrusted)]: ${JSON.stringify(transcript)}`,
          );
        }
      },
    );
  });
});
