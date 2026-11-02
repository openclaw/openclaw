import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { requireRecord } from "./chat-flow.test-support.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Guest Home disclosure" });
suite.define(() => {
  it.each([1280, 400])(
    "keeps operator Home out of guest routes and starts a new draft at %ipx",
    async (width) => {
      const artifacts = createControlUiE2eArtifactDir("guest-home");
      await suite.withPage(
        { ...createControlUiE2eContextOptions(), viewport: { width, height: 850 } },
        async ({ page }) => {
          const home = "agent:main:main";
          const gateway = await installMockGateway(page, {
            operatorSessionCap: "view",
            operatorScopes: ["operator.sessions.read", "operator.sessions.write"],
            roleAllowsAdmin: false,
            sessionKey: home,
            sessions: [
              {
                key: "agent:main:review",
                label: "Synthetic shared review",
                kind: "direct",
                updatedAt: 1,
              },
            ],
            historyMessages: [{ role: "assistant", content: "Synthetic operator-only Home note." }],
          });
          await page.goto(controlUiSessionUrl(suite.server.baseUrl, home));
          await page
            .getByText(
              "This Home is unavailable. Start a new conversation, or open one from Sessions.",
              { exact: true },
            )
            .waitFor();
          expect(await page.getByText("Synthetic operator-only Home note.").count()).toBe(0);
          expect(
            await page
              .getByRole("button", { name: "Talk to your Home agent", exact: true })
              .count(),
          ).toBe(0);
          const unavailable = page.getByText(
            "This Home is unavailable. Start a new conversation, or open one from Sessions.",
            { exact: true },
          );
          const deniedFrame = await takeControlUiScreenshotFrame(
            page,
            page.locator("body"),
            [unavailable],
            { animations: "disabled" },
          );
          await writeFile(path.join(artifacts, `after-home-${width}.png`), deniedFrame.png);
          for (const method of ["chat.history", "chat.startup", "sessions.messages.subscribe"]) {
            expect(
              (await gateway.getRequests(method)).filter((request) => {
                const params = requireRecord(request.params);
                return params.sessionKey === home || params.key === home;
              }),
            ).toHaveLength(0);
          }
          await page.getByRole("button", { name: "New conversation", exact: true }).click();
          await page.waitForURL((url) => url.pathname === "/new");
          const composer = page.locator("textarea").first();
          await composer.fill("Synthetic unsent review draft.");
          expect(await composer.inputValue()).toBe("Synthetic unsent review draft.");
          const newFrame = await takeControlUiScreenshotFrame(
            page,
            page.locator("body"),
            [composer],
            { animations: "disabled" },
          );
          await writeFile(path.join(artifacts, `after-new-${width}.png`), newFrame.png);
          expect(await gateway.getRequests("chat.send")).toHaveLength(0);
        },
      );
    },
  );
});
