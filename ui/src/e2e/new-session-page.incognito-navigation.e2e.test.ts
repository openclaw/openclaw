import { Buffer } from "node:buffer";
import { expect, it } from "vitest";
import { waitForControlUiRoute } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { navigationAgents } from "./new-session-page.navigation-fixtures.test-support.ts";
import {
  installMockGateway,
  navigateInApp,
  pollAttribute,
  pollCount,
  pollValue,
  waitForCommittedNewSessionDraft,
} from "./new-session-page.test-support.ts";

// Query-only navigation reuses the page; Settings navigation exercises the teardown handoff.
const suite = createControlUiE2eSuite({ name: "New Session draft navigation" });
suite.define(() => {
  it("preserves route-owned drafts through Back without persisting Incognito input", async () => {
    for (const scenario of [
      { name: "ordinary-query", incognito: false, turnOff: false, destination: "new-session" },
      { name: "incognito-settings", incognito: true, turnOff: false, destination: "appearance" },
      { name: "incognito-query", incognito: true, turnOff: false, destination: "new-session" },
      { name: "incognito-off-query", incognito: true, turnOff: true, destination: "new-session" },
    ] as const) {
      await suite.withPage({ viewport: { width: 1440, height: 1000 } }, async ({ page }) => {
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        const gateway = await installMockGateway(page, {
          methodResponses: {
            "agents.list": navigationAgents(["main", "writer"], "per-sender", undefined, true),
          },
        });
        await page.goto(`${suite.server.baseUrl}new?agent=main`);
        await waitForControlUiRoute(page, { routeId: "new-session", pathname: "/new" });
        const message = page.locator(".new-session-page__message");
        const incognito = page.getByRole("switch", { name: "Incognito" });
        const attachments = page.locator(".chat-attachment-file__name");
        const expectAgent = (id: string) =>
          expect
            .poll(() =>
              page
                .locator("openclaw-new-session-page")
                .evaluate((element) => Reflect.get(element, "data")?.requestedAgentId),
            )
            .toBe(id);
        const text = `${scenario.name}: retain this unsent synthetic draft`;
        const filename = `${scenario.name}.txt`;
        if (scenario.incognito) {
          await incognito.click();
          await pollAttribute(incognito, "aria-checked").toBe("true");
          await waitForCommittedNewSessionDraft(page, null, 0);
        }
        await message.pressSequentially(text);
        await page.locator(".agent-chat__file-input").setInputFiles({
          name: filename,
          mimeType: "text/plain",
          buffer: Buffer.from("Synthetic navigation attachment. No private data."),
        });
        await expect
          .poll(() => page.locator(".chat-attachment-file__name").allTextContents())
          .toContain(filename);
        if (!scenario.incognito) {
          await waitForCommittedNewSessionDraft(page, text, 1);
        }
        if (scenario.turnOff) {
          await incognito.click();
          await pollAttribute(incognito, "aria-checked").toBe("false");
        }
        const remainsIncognito = scenario.incognito && !scenario.turnOff;
        await navigateInApp(
          page,
          scenario.destination,
          scenario.destination === "new-session" ? "?agent=writer" : "",
        );
        await waitForControlUiRoute(page, {
          routeId: scenario.destination,
          pathname: scenario.destination === "new-session" ? "/new" : "/settings/appearance",
        });
        if (scenario.destination === "new-session") {
          await expectAgent("writer");
        }
        await page.goBack();
        await waitForControlUiRoute(page, { routeId: "new-session", pathname: "/new" });
        await expectAgent("main");
        await page.locator("openclaw-new-session-page").evaluate(async (element) => {
          await Reflect.get(element, "updateComplete");
        });
        const requests = await gateway.getRequests();
        expect
          .soft(
            {
              text: await message.inputValue(),
              attachments: await attachments.allTextContents(),
              incognito: await incognito.getAttribute("aria-checked"),
              agent: new URL(page.url()).searchParams.get("agent"),
              errors,
              sends: requests.filter(
                ({ method }) => method === "sessions.create" || method === "chat.send",
              ),
            },
            scenario.name,
          )
          .toEqual({
            text,
            attachments: expect.arrayContaining([filename]),
            incognito: String(remainsIncognito),
            agent: "main",
            errors: [],
            sends: [],
          });
        if (remainsIncognito) {
          await waitForCommittedNewSessionDraft(page, null, 0);
          await page.reload();
          await waitForControlUiRoute(page, { routeId: "new-session", pathname: "/new" });
          await pollValue(message).toBe("");
          await pollCount(attachments).toBe(0);
          await pollAttribute(incognito, "aria-checked").toBe("false");
        }
        if (scenario.turnOff) {
          await waitForCommittedNewSessionDraft(page, text, 1);
          await page.reload();
          await waitForControlUiRoute(page, { routeId: "new-session", pathname: "/new" });
          await pollValue(message).toBe(text);
          await expect.poll(() => attachments.allTextContents()).toContain(filename);
        }
      });
    }
  });
});
