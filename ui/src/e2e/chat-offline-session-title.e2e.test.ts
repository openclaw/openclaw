import { expect, it } from "vitest";
import { controlUiBundledSettingsStorageKey } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiSessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";
import {
  controlUiSessionUrl,
  createSessionManagementE2eSuite,
  installMockGateway,
  sessionsListResponse,
} from "./session-management.test-support.ts";

const suite = createSessionManagementE2eSuite();

suite.define(() => {
  it.each([false, true])(
    "retains named dashboard conversations while offline and after reconnect (split=%s)",
    async (split) => {
      await suite.withPage(createControlUiE2eContextOptions(), async ({ context, page }) => {
        const name = "Lunar museum itinerary";
        const row = createControlUiSessionRow("agent:main:dashboard:offline-title", name, 1);
        const sibling = createControlUiSessionRow(
          "agent:main:dashboard:exhibits",
          "Exhibit inventory",
          1,
        );
        if (split) {
          await context.addInitScript(
            ({ settingsKey, keys }) => {
              localStorage.setItem(
                settingsKey,
                JSON.stringify({
                  chatSplitLayout: {
                    activePaneId: "p1",
                    columns: keys.map((sessionKey, index) => ({
                      id: `c${index + 1}`,
                      panes: [{ id: `p${index + 1}`, sessionKey }],
                      paneWeights: [1],
                    })),
                    columnWeights: [0.5, 0.5],
                  },
                }),
              );
            },
            {
              settingsKey: controlUiBundledSettingsStorageKey(suite.server.baseUrl),
              keys: [row.key, sibling.key],
            },
          );
        }
        const transcript = "The synthetic museum itinerary is ready.";
        const gateway = await installMockGateway(page, {
          sessionKey: row.key,
          historyMessages: [{ role: "assistant", content: transcript }],
          methodResponses: {
            "sessions.list": sessionsListResponse(split ? [row, sibling] : [row]),
          },
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, row.key));
        const headings = page.locator(
          ".chat-pane-cache__pane--visible .chat-pane__session-title-text",
        );
        const heading = headings.first();
        const names = split ? [name, sibling.label] : [name];
        await expect.poll(() => heading.textContent()).toBe(name);
        await expect.poll(() => headings.allTextContents()).toEqual(names);
        await expect.poll(() => page.title()).toBe(`${name} — OpenClaw`);
        await page.getByText(transcript, { exact: true }).first().waitFor({ state: "visible" });
        const route = new URL(page.url()).pathname;
        await page.screenshot({ path: `${suite.artifactDir}/connected.png` });

        await gateway.setOnline(false);
        await gateway.closeLatest(1001, "mock Gateway restart");
        await expect.poll(() => page.title()).toMatch(/^\(Disconnected/);
        await page.getByRole("button", { name: "Offline — Retry now", exact: true }).waitFor();
        await page.screenshot({ path: `${suite.artifactDir}/offline.png` });
        const offlineTitle = await page.title();
        const offlineHeadings = await headings.allTextContents();
        expect(new URL(page.url()).pathname).toBe(route);
        expect(await page.getByText(transcript, { exact: true }).first().isVisible()).toBe(true);

        await gateway.setOnline(true);
        await expect.poll(() => page.title()).toBe(`${name} — OpenClaw`);
        await expect.poll(() => heading.textContent()).toBe(name);
        expect(new URL(page.url()).pathname).toBe(route);
        expect(await page.getByText(transcript, { exact: true }).first().isVisible()).toBe(true);
        await expect.poll(() => headings.allTextContents()).toEqual(names);
        await page.screenshot({ path: `${suite.artifactDir}/reconnected.png` });
        expect.soft(offlineTitle).toBe(`(Disconnected) ${name} — OpenClaw`);
        expect.soft(offlineHeadings).toEqual(names);
      });
    },
  );
});
