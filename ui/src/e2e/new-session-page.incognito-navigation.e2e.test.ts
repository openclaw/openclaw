import { Buffer } from "node:buffer";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { composerValue } from "../test-helpers/composer-editor.ts";
import { waitForControlUiRoute } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import {
  installMockGateway,
  navigateInApp,
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
    ]) {
      await suite.withPage({ viewport: { width: 1440, height: 1000 } }, async ({ page }) => {
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        const gateway = await installMockGateway(page, {
          methodResponses: {
            "agents.list": {
              defaultId: "main",
              mainKey: "main",
              scope: "per-sender",
              agents: [
                { id: "main", name: "Main", identity: { name: "Main" } },
                { id: "writer", name: "Writer", identity: { name: "Writer" } },
              ],
            },
          },
        });
        await page.goto(`${suite.server.baseUrl}new?agent=main`);
        await waitForControlUiRoute(page, { routeId: "new-session", pathname: "/new" });
        const message = page.locator(".new-session-page__message");
        const original = await page.locator("openclaw-new-session-page").elementHandle();
        if (!original) {
          throw new Error("New Session page did not mount");
        }
        const text = `${scenario.name}: retain this unsent synthetic draft`;
        const filename = `${scenario.name}.txt`;
        if (scenario.incognito) {
          await page.getByRole("switch", { name: "Incognito" }).click();
          await expect
            .poll(() =>
              page.getByRole("switch", { name: "Incognito" }).getAttribute("aria-checked"),
            )
            .toBe("true");
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
          await page.getByRole("switch", { name: "Incognito" }).click();
          await expect
            .poll(() =>
              page.getByRole("switch", { name: "Incognito" }).getAttribute("aria-checked"),
            )
            .toBe("false");
        }
        const remainsIncognito = scenario.incognito && !scenario.turnOff;
        const observe = async () => ({
          url: page.url(),
          samePageElement: await original.evaluate(
            (element) => element === document.querySelector("openclaw-new-session-page"),
          ),
          text: (await message.count()) ? await composerValue(message) : null,
          incognito: (await page.getByRole("switch", { name: "Incognito" }).count())
            ? await page.getByRole("switch", { name: "Incognito" }).getAttribute("aria-checked")
            : null,
          attachments: await page.locator(".chat-attachment-file__name").allTextContents(),
          routeData: (await page.locator("openclaw-new-session-page").count())
            ? await page
                .locator("openclaw-new-session-page")
                .evaluate((element) => Reflect.get(element, "data"))
            : null,
        });
        const before = await observe();
        await page.screenshot({
          path: path.join(suite.artifactDir, `${scenario.name}-before.png`),
        });
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
          await expect
            .poll(() =>
              page
                .locator("openclaw-new-session-page")
                .evaluate((element) => Reflect.get(element, "data")?.requestedAgentId),
            )
            .toBe("writer");
        }
        const away = await observe();
        await page.goBack();
        await waitForControlUiRoute(page, { routeId: "new-session", pathname: "/new" });
        await expect
          .poll(() =>
            page
              .locator("openclaw-new-session-page")
              .evaluate((element) => Reflect.get(element, "data")?.requestedAgentId),
          )
          .toBe("main");
        await page.locator("openclaw-new-session-page").evaluate(async (element) => {
          await Reflect.get(element, "updateComplete");
        });
        await page.screenshot({
          path: path.join(suite.artifactDir, `${scenario.name}-returned.png`),
        });
        const returned = await observe();
        const requests = (await gateway.getRequests()).map(({ method, params }) => ({
          method,
          params,
        }));
        await writeFile(
          path.join(suite.artifactDir, `${scenario.name}.json`),
          JSON.stringify(
            {
              scenario,
              before,
              away,
              returned,
              errors,
              requests,
            },
            null,
            2,
          ),
        );
        // All outcomes are retained before judging the custody hypothesis.
        expect.soft(returned.text, scenario.name).toBe(text);
        expect.soft(returned.attachments, scenario.name).toContain(filename);
        expect.soft(returned.incognito, scenario.name).toBe(String(remainsIncognito));
        expect.soft(new URL(returned.url).searchParams.get("agent"), scenario.name).toBe("main");
        expect.soft(errors, scenario.name).toEqual([]);
        expect
          .soft(
            requests.filter(({ method }) => method === "sessions.create" || method === "chat.send"),
            scenario.name,
          )
          .toEqual([]);
        if (remainsIncognito) {
          await waitForCommittedNewSessionDraft(page, null, 0);
          await page.reload();
          await waitForControlUiRoute(page, { routeId: "new-session", pathname: "/new" });
          await expect.poll(() => composerValue(message)).toBe("");
          await expect.poll(() => page.locator(".chat-attachment-file__name").count()).toBe(0);
          await expect
            .poll(() =>
              page.getByRole("switch", { name: "Incognito" }).getAttribute("aria-checked"),
            )
            .toBe("false");
        }
        if (scenario.turnOff) {
          await waitForCommittedNewSessionDraft(page, text, 1);
          await page.reload();
          await waitForControlUiRoute(page, { routeId: "new-session", pathname: "/new" });
          await expect.poll(() => composerValue(message)).toBe(text);
          await expect
            .poll(() => page.locator(".chat-attachment-file__name").allTextContents())
            .toContain(filename);
        }
        await original.dispose();
      });
    }
  });
});
