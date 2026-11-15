import { writeFile } from "node:fs/promises";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it } from "vitest";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  controlUiBundledSettingsStorageKey,
  controlUiSessionUrl,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiTeamScaleFixture } from "../test-helpers/control-ui-team-scale-fixture.ts";
import { openChatDetails } from "./chat-details.test-support.ts";
import { dashboardLayout } from "./chat-layout-fixtures.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Details excludes subsessions" });
suite.define(() => {
  it("keeps subsessions in the sidebar but only subagents in Details through reload", async () => {
    await suite.withPage(
      { viewport: { width: 1800, height: 1000 }, serviceWorkers: "block" },
      async ({ page }) => {
        const fixture = createControlUiTeamScaleFixture({
          baseUrl: suite.server.baseUrl,
          transcriptMessages: 15,
          paneChromeFacts: true,
          detailsSessionFacts: true,
          detailsSubagentActivity: 3,
        });
        const sessionKey = fixture.selectedSessionKey;
        const children = fixture.scenario.sessions!.filter(
          (row) =>
            row.parentSessionKey === sessionKey &&
            typeof row.label === "string" &&
            row.label.startsWith("Synthetic child review "),
        );
        Object.assign(children[0]!, {
          key: "agent:main:subagent:review",
          label: "Native review",
          classification: "subagent",
        });
        Object.assign(children[1]!, {
          key: "agent:main:acp:coder",
          label: "Coding subsession",
          classification: "acp",
        });
        Object.assign(children[2]!, {
          key: "agent:main:dashboard:research",
          label: "Research subsession",
        });
        fixture.scenario.sessions!.find((row) => row.key === sessionKey)!.childSessions =
          children.map((row) => row.key);
        await page.addInitScript(
          ({ key, settings }) => {
            for (const [name, value] of Object.entries(settings.sidebarPrefs)) {
              localStorage.setItem(name, value);
            }
            if (!localStorage.getItem(key)) {
              localStorage.setItem(key, JSON.stringify(settings));
            }
          },
          {
            key: controlUiBundledSettingsStorageKey(suite.server.baseUrl),
            settings: {
              sessionKey,
              sidebarPrefs: fixture.paneChromeSettings,
              sidebarSessionLayouts: {
                [sessionKey]: dashboardLayout("side-panel-column", "dashboard", false),
              },
            },
          },
        );
        await page.route("**/__openclaw__/**", (route) => {
          const asset = fixture.assets.get(new URL(route.request().url()).pathname);
          return asset ? route.fulfill(asset) : route.fallback();
        });
        const gateway = await installMockGateway(page, fixture.scenario, {
          requestHandlers: {
            "cron.list": (params) => fixture.listCronJobs(isRecord(params) ? params : {}),
          },
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey, "chat"));
        await gateway.waitForRequest("connect");
        const details = await openChatDetails(page);
        await details.locator(".chat-details-subagents__summary").waitFor();
        const frame = await takeControlUiScreenshotFrame(page, details, [details], {
          elements: [details],
        });
        await writeFile(path.join(suite.artifactDir, "details.png"), frame.elements[0]!.png);
        await writeFile(path.join(suite.artifactDir, "conversation.png"), frame.png);
        console.info(`Details proof: ${suite.artifactDir}`);
        expect(await details.getByText("Coding subsession", { exact: true }).count()).toBe(0);
        expect(await details.getByText("Research subsession", { exact: true }).count()).toBe(0);
        const sidebar = page.locator("openclaw-app-sidebar");
        const parent = sidebar.locator(`[data-session-key="${sessionKey}"]`).first();
        const expand = parent.locator("button[aria-expanded]").first();
        if ((await expand.count()) && (await expand.getAttribute("aria-expanded")) === "false") {
          await expand.click();
        }
        for (const child of children.slice(1)) {
          await sidebar.locator(`[data-session-key="${child.key}"]`).waitFor();
        }
        await page.reload({ waitUntil: "domcontentloaded" });
        const reloadedDetails = await openChatDetails(page);
        await reloadedDetails.locator(".chat-details-subagents__summary").waitFor();
        expect(await reloadedDetails.getByText("Coding subsession", { exact: true }).count()).toBe(
          0,
        );
        expect(
          await reloadedDetails.getByText("Research subsession", { exact: true }).count(),
        ).toBe(0);
      },
    );
  });
});
