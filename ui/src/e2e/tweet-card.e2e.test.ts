import { readFileSync, writeFileSync } from "node:fs";
import { expect, it } from "vitest";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Tweet browser cards" });
const url = "https://x.com/openclaw/status/1234567890123456789";
const title = "OpenClaw (@openclaw) on X";
const description =
  "Small details make a big difference. A readable preview keeps the conversation in context, so you can understand the post without opening another tab.";

suite.define(() => {
  it.each([
    { width: 1280, height: 900, colorScheme: "dark" as const, state: "text" },
    { width: 390, height: 844, colorScheme: "light" as const, state: "text" },
    { width: 1280, height: 900, colorScheme: "dark" as const, state: "media" },
    { width: 390, height: 844, colorScheme: "dark" as const, state: "unavailable" },
    { width: 390, height: 844, colorScheme: "light" as const, state: "long" },
  ])(
    "renders a $state tweet in the chat at $width px",
    async ({ width, height, colorScheme, state }) => {
      await suite.withPage({ viewport: { width, height }, colorScheme }, async ({ page }) => {
        const postTitle =
          state === "long"
            ? "OpenClaw contributors building thoughtful and accessible interfaces (@openclaw) on X"
            : title;
        const postText =
          state === "long"
            ? description + " https://example.com/" + "long-path-".repeat(25)
            : description;
        const gateway = await installMockGateway(page, {
          automaticallyFetchFavicons: true,
          featureMethods: [],
          methodResponses: {
            "controlUi.linkPreview":
              state === "unavailable"
                ? {}
                : {
                    title: postTitle,
                    description: postText,
                    ...(state === "media"
                      ? {
                          imageDataUrl:
                            "data:image/png;base64," +
                            readFileSync("docs/assets/openclaw-hero-dark.png").toString("base64"),
                        }
                      : {}),
                    faviconDataUrl:
                      "data:image/png;base64," +
                      readFileSync("ui/public/favicon-32.png").toString("base64"),
                  },
          },
          historyMessages: [
            {
              role: "user",
              content: "Take a look at this post about keeping previews readable.",
              timestamp: 1000,
            },
            {
              role: "assistant",
              timestamp: 2000,
              content: [
                {
                  type: "toolCall",
                  id: "tweet",
                  name: "browser",
                  arguments: { action: "open", url },
                },
              ],
            },
            {
              role: "toolResult",
              timestamp: 3000,
              toolCallId: "tweet",
              toolName: "browser",
              content: [{ type: "text", text: "Opened post" }],
              details: {
                browserTab: {
                  target: "host",
                  profile: "managed",
                  targetId: "tweet-tab",
                  url,
                  title,
                },
              },
            },
            { role: "assistant", content: "Here’s the post for context.", timestamp: 4000 },
          ],
        });
        await page.goto(suite.server.baseUrl + "chat");
        await page.getByText("Here’s the post for context.", { exact: true }).waitFor();
        const card = page.locator("openclaw-browser-tab-card");
        await card.locator(".tweet-author").waitFor();
        if (state !== "unavailable") {
          await card.locator(".tweet-text").waitFor();
        }
        await gateway.waitForRequest("controlUi.linkPreview", { match: { url } });
        if (state === "media") {
          const image = card.locator(".shot.social img");
          await image.waitFor();
          expect(
            await image.evaluate((node: HTMLImageElement) =>
              node.decode().then(() => node.naturalWidth),
            ),
          ).toBeGreaterThan(0);
        }
        const frame = await takeControlUiScreenshotFrame(
          page,
          card,
          [
            card.locator(".tweet-author"),
            card.getByRole("button", { name: "Open post", exact: true }),
          ],
          {
            elements: [card],
            scrollTo: card,
            animations: "disabled",
          },
        );
        writeFileSync(suite.artifactDir + "/chat.png", frame.png);
        writeFileSync(suite.artifactDir + "/card.png", frame.elements[0]!.png);
        expect(await card.locator(".tweet-handle").textContent()).toBe("@openclaw");
        const body = card.locator(".tweet-text");
        expect(await body.count()).toBe(state === "unavailable" ? 0 : 1);
        if (state !== "unavailable") {
          expect(await body.textContent()).toBe(postText.slice(0, 400));
          expect(await body.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
        }
        const bounds = await card.boundingBox();
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
        expect(
          await card.locator(".actions").evaluate((node) => getComputedStyle(node).opacity),
        ).toBe("1");
        const open = card.getByRole("button", { name: "Open post", exact: true });
        await open.focus();
        expect(await open.evaluate((node) => node.matches(":focus-visible"))).toBe(true);
        await card.getByRole("button", { name: "More actions", exact: true }).click();
        await card.getByText("Copy URL", { exact: true }).waitFor();
      });
    },
  );
});
