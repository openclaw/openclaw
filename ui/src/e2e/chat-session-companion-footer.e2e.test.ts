import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Locator } from "playwright";
import { expect, it } from "vitest";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { openChatSidePanelType } from "./chat-side-panel.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "side-chat message footer" });
const exchanges = [
  {
    question: "Which repos did the session touch?",
    answer:
      "Not just OpenClaw: the session also accessed the Hermit repo. It did not have ClawHub's source checked out.",
  },
  { question: "Did it run the tests?", answer: "Yes, the UI suite passed." },
];

// Everything a transcript shows around its messages: footer tree and the space between groups.
const transcriptShape = (surface: Locator) =>
  surface.evaluate((root) => {
    const groups = [...root.querySelectorAll<HTMLElement>(".chat-group")];
    return {
      footers: groups.map((group) => {
        const footer = group.querySelector(".chat-group-footer");
        return {
          role: group.classList.contains("user") ? "user" : "assistant",
          meta: [...(footer?.querySelectorAll(".chat-group-footer__meta > *") ?? [])].map(
            (child) => child.className,
          ),
          time: footer?.querySelector("time.chat-group-timestamp")?.textContent ?? null,
          actions: [...(footer?.querySelectorAll(".chat-group-footer-actions button") ?? [])]
            .map((button) => button.getAttribute("aria-label"))
            // Side chat exchanges have no reply target; every other footer part is shared.
            .filter((label) => label !== "Reply to message"),
        };
      }),
      gaps: groups
        .slice(1)
        .map((group, index) =>
          Math.round(
            group.getBoundingClientRect().top - groups[index]!.getBoundingClientRect().bottom,
          ),
        ),
      dividers: [...root.querySelectorAll(".chat-session-rail__exchange")].filter(
        (exchange) => getComputedStyle(exchange).borderTopStyle !== "none",
      ).length,
    };
  });

suite.define(() => {
  it("renders Side chat exchanges like the main transcript", async () => {
    await suite.withPage(
      { viewport: { width: 1440, height: 900 }, locale: "en-US" },
      async ({ page }) => {
        const sessionKey = "agent:main:side-chat-footer";
        const ts = Date.now() - 5 * 60_000;
        await installMockGateway(page, {
          sessionKey,
          historyMessages: exchanges.flatMap(({ question, answer }, index) => [
            { role: "user", content: question, timestamp: ts + index * 60_000 },
            { role: "assistant", content: answer, timestamp: ts + index * 60_000 },
          ]),
          methodResponses: {
            "sessions.companion.state": {
              exchanges: exchanges.map((exchange, index) => ({
                ...exchange,
                ts: ts + index * 60_000,
              })),
            },
          },
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
        const last = exchanges.at(-1)!.answer;
        const main = page.locator(".chat-thread");
        await main.getByText(last).waitFor();
        await openChatSidePanelType(page, "Side chat");
        const side = page.locator("openclaw-chat-session-rail");
        await side.getByText(last).waitFor();
        await page.mouse.move(0, 0);
        try {
          const mainShape = await transcriptShape(main);
          expect(mainShape.footers.map(({ role }) => role)).toEqual([
            "user",
            "assistant",
            "user",
            "assistant",
          ]);
          expect(mainShape.footers.every(({ time }) => Boolean(time))).toBe(true);
          expect(await transcriptShape(side)).toEqual({ ...mainShape, dividers: 0 });
          expect(await side.getByText(/^as of /).count()).toBe(0);
          // The panel has no avatar gutter: answers start at the exchange edge.
          const inset = await side
            .locator(".chat-session-rail__exchange")
            .last()
            .evaluate((exchange) => {
              const messages = exchange.querySelector(".chat-group.assistant .chat-group-messages");
              return messages!.getBoundingClientRect().left - exchange.getBoundingClientRect().left;
            });
          expect(Math.abs(inset)).toBeLessThanOrEqual(1);
        } finally {
          if (process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR) {
            const capture = async (name: string) => {
              const frame = await takeControlUiScreenshotFrame(
                page,
                page.locator("body"),
                [main.getByText(last), side.getByText(last)],
                { animations: "disabled" },
              );
              await writeFile(path.join(suite.artifactDir, `${name}.png`), frame.png);
            };
            await capture("rest");
            // Footers are hover-disclosed in both surfaces; capture each revealed.
            for (const [name, surface] of [
              ["main", main],
              ["side", side],
            ] as const) {
              await surface.getByText(exchanges[0]!.answer).hover();
              await capture(`hover-${name}`);
            }
          }
        }
      },
    );
  });
});
