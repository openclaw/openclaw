import { expect, it } from "vitest";
import { sessionRow } from "./chat-flow-fixtures.test-support.ts";
import {
  chatSessionListResponse,
  controlUiSessionUrl,
  createChatFlowE2eSuite,
  installMockGateway,
} from "./chat-flow.test-support.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";

const suite = createChatFlowE2eSuite();

suite.define(() => {
  it("renders a three-line commentary preview without omitted text or links", async () => {
    const selectedSessionKey = "agent:main:selected-clamp";
    const sessionKey = "agent:main:hovered-clamp";
    const filler = "Review the launch notes and agree on the release window. ".repeat(6);

    await suite.withPage(
      { hasTouch: false, ...createControlUiE2eContextOptions() },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          featureMethods: ["chat.metadata", "chat.startup", "progressCard.get"],
          historyMessages: [
            {
              role: "assistant",
              timestamp: 1,
              content: [{ type: "text", text: `Open ${sessionKey} for progress.` }],
            },
          ],
          methodResponses: {
            "progressCard.get": {
              card: {
                markdown: `[Build log](https://example.com/build) **Review** notes. ${filler}[Release review](https://example.com/review) Omitted ending.`,
                revision: 1,
                sessionKey,
                updatedAt: 1,
              },
            },
            "sessions.list": chatSessionListResponse([
              sessionRow(selectedSessionKey, "Selected session", 2),
              sessionRow(sessionKey, "Hovered session", 1),
            ]),
          },
          sessionKey: selectedSessionKey,
        });

        await page.goto(controlUiSessionUrl(suite.server.baseUrl, selectedSessionKey));
        const row = page.locator(
          `.chat-thread a.markdown-session-link[data-session-key="${sessionKey}"]`,
        );
        await row.waitFor({ state: "visible" });
        await row.hover();
        const commentary = page.locator(
          ".session-progress-hovercard .session-hovercard__commentary",
        );
        await commentary.waitFor({ state: "visible" });
        await expect
          .poll(() => commentary.getByRole("link", { name: "Release review" }).count())
          .toBe(0);
        let text = await commentary.textContent();
        expect(text).not.toContain("Omitted ending.");
        expect(text?.trimEnd().endsWith("…")).toBe(true);
        expect(await commentary.locator("strong").textContent()).toBe("Review");
        expect(
          await commentary.evaluate((node) => {
            const style = getComputedStyle(node);
            return node.getBoundingClientRect().height / Number.parseFloat(style.lineHeight);
          }),
        ).toBeLessThanOrEqual(3);

        await row.focus();
        await page.keyboard.press("Tab");
        await expect
          .poll(() => page.locator(":focus").getAttribute("href"))
          .toBe("https://example.com/build");
        expect(await commentary.evaluate((node) => node.scrollTop)).toBe(0);
        await row.focus();
        await page.setViewportSize({ width: 320, height: 900 });
        await expect.poll(() => commentary.textContent()).not.toBe(text);
        text = await commentary.textContent();
        for (const [revision, markdown] of [
          [
            2,
            `- **Review** ${filler}\n- [Release review](https://example.com/review) Omitted ending.`,
          ],
          [
            3,
            `\`\`\`text\n${"A long code line ".repeat(40)}\nSecond code line.\n\`\`\`\n\n[Release review](https://example.com/review) Omitted ending.`,
          ],
          [4, "[Short note](https://example.com/short)"],
        ] as const) {
          await gateway.setMethodResponse("progressCard.get", {
            card: { markdown, revision, sessionKey, updatedAt: revision },
          });
          await gateway.emitGatewayEvent("progressCard.changed", { revision, sessionKey });
          await expect.poll(() => commentary.textContent()).not.toBe(text);
          text = await commentary.textContent();
          expect(text).not.toContain("Omitted ending.");
          expect(await commentary.getByRole("link", { name: "Release review" }).count()).toBe(0);
          expect(
            await commentary.evaluate((node) => {
              const style = getComputedStyle(node);
              return (
                node.getBoundingClientRect().height <= 3 * Number.parseFloat(style.lineHeight) &&
                [node, ...node.getElementsByTagName("*")].every(
                  (element) =>
                    element.scrollWidth <= element.clientWidth &&
                    element.scrollHeight <= element.clientHeight,
                )
              );
            }),
          ).toBe(true);
          if (revision === 4) {
            expect(text?.trim()).toBe("Short note");
          } else {
            expect(text?.trimEnd().endsWith("…")).toBe(true);
            expect(
              await commentary.locator(revision === 2 ? "li strong" : "pre code").count(),
            ).toBe(1);
          }
        }
      },
    );
  });
});
