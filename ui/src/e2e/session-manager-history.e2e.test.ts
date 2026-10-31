import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import * as ui from "./session-management.compact.test-support.ts";
import * as support from "./session-management.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI session manager and history primary QA",
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not installed or cannot start at ${executablePath}.`,
});
const captureProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";

async function captureUiProof(page: Page, fileName: string) {
  if (!captureProof) {
    return;
  }
  const proofDirectory = path.join(suite.artifactDir, "session-manager-history");
  await mkdir(proofDirectory, { recursive: true });
  await page.screenshot({ fullPage: true, path: path.join(proofDirectory, fileName) });
}

suite.define(() =>
  it("covers session listing, filtering, transcript history, and archive feedback", async () => {
    const timestamp = Date.parse("2026-08-03T09:00:00.000Z");
    const main = sessionRow("agent:main:main", "Main", timestamp);
    const research = sessionRow("agent:main:research", "Research notes", timestamp - 60_000);
    const text = "The deployment history is ready to review.";
    const hit = {
      messageId: "message-research",
      role: "assistant",
      score: 2.5,
      sessionId: "research",
      sessionKey: research.key,
      snippet: text,
      timestamp,
    };
    await ui.withSessionPage(suite, async (page) => {
      const gateway = await ui.installSessionRows(page, [main, research], {
        featureMethods: ["chat.metadata", "chat.startup", "sessions.patch", "sessions.search"],
        historyMessages: [{ role: "assistant", content: [{ type: "text", text }], timestamp }],
        methodResponses: {
          "sessions.patch": {},
          "sessions.search": { results: [hit] },
        },
        sessionKey: main.key,
      });

      await page.goto(`${suite.server.baseUrl}sessions`);
      const row = (label: string) =>
        page
          .locator(".session-data-row")
          .filter({ has: page.locator(`.session-label-chip[title="${label}"]`) });
      const mainRow = row(main.label);
      const researchRow = row(research.label);
      await mainRow.waitFor({ state: "visible", timeout: 10_000 });
      await researchRow.waitFor({ state: "visible", timeout: 10_000 });

      await ui.button(page, "Filters").click();
      const rosterFilter = page.locator('.sessions-filter-popover:popover-open input[type="text"]');
      await rosterFilter.fill("Research");
      await expect.poll(() => mainRow.count()).toBe(0);
      await researchRow.waitFor({ state: "visible" });
      await captureUiProof(page, "01-session-filter.png");
      await rosterFilter.fill("");
      await mainRow.waitFor({ state: "visible" });
      await page.keyboard.press("Escape");

      const transcriptSearch = page.getByRole("search", { name: "Search transcripts" });
      await ui.button(transcriptSearch, "Search transcripts", false).click();
      const transcriptInput = transcriptSearch.getByRole("searchbox", {
        name: "Search session transcripts",
      });
      await transcriptInput.fill("deployment history");
      await transcriptInput.press("Enter");
      const result = page.locator(".sessions-transcript-search__result");
      await result.waitFor({ state: "visible", timeout: 10_000 });
      expect((await gateway.getRequests("sessions.search"))[0]?.params).toEqual({
        limit: 25,
        query: "deployment history",
        scope: {
          agentId: "main",
          excludeDock: true,
          includeGlobal: true,
          includeUnknown: false,
          configuredAgentsOnly: true,
        },
      });
      await result.click();
      await ui.expectSessionPath(page, research.key);
      await ui.visible(
        page.locator(".chat-group.assistant").getByText(text, { exact: true }),
        10_000,
      );
      await captureUiProof(page, "02-session-history.png");

      await page.goto(`${suite.server.baseUrl}sessions`);
      await researchRow.waitFor({ state: "visible", timeout: 10_000 });
      await ui.button(researchRow, "Open session menu", false).click();
      await support.activateSelfRemovingControl(
        ui.menuItem(page.locator("openclaw-session-menu"), "Archive session", false),
      );
      await ui.sessionPatch(gateway, research.key, { archived: true });
      const toast = page
        .locator("openclaw-toast-host .app-toast")
        .filter({ hasText: "Session archived" });
      await toast.waitFor({ state: "visible", timeout: 10_000 });
      await ui.visible(ui.button(toast, "Undo", false));
      await captureUiProof(page, "03-session-archive-feedback.png");
    });
  }),
);
