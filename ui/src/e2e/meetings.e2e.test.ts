import path from "node:path";
import type { TranscriptSessionSummary, TranscriptsGetResult } from "@openclaw/gateway-protocol";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Meetings dashboard" });
const meeting: TranscriptSessionSummary = {
  selector: "2026-08-12/design-review",
  sessionId: "design-review",
  title: "Design review",
  providerId: "discord-voice",
  providerName: "Discord voice",
  source: { providerId: "discord-voice" },
  startedAt: "2026-08-12T17:00:00Z",
  stoppedAt: "2026-08-12T17:45:00Z",
  active: false,
  activeSubscription: false,
  agentId: "main",
  updatedAt: "2026-08-12T17:45:00Z",
  lastUtteranceAt: "2026-08-12T17:44:00Z",
  utteranceCount: 42,
  participants: ["Ada", "Sam", "Jo", "Alex"],
  hasSummary: true,
  summarySource: "model",
  overview: "Agreed on a simpler onboarding flow and a focused launch checklist.",
};
const detail: TranscriptsGetResult = {
  session: meeting,
  nextCursor: null,
  summary: {
    generatedAt: "2026-08-12T17:45:00Z",
    overview: meeting.overview!,
    decisions: [],
    actionItems: [],
    risks: [],
    participants: meeting.participants,
    utteranceCount: meeting.utteranceCount,
    source: "model",
    markdown:
      "# Design review\n\n## Overview\nAgreed on a simpler onboarding flow and a focused launch checklist.\n\n## Participants\n- Ada\n- Sam\n- Jo\n- Alex\n\n## Decisions\n- Keep the first-run setup to three steps.\n- Ship the accessible navigation before launch.\n\n## Action Items\n- Ada: prepare the revised prototype.\n- Sam: review keyboard navigation.\n\n## Risks\n- Leave time for mobile testing.\n\n## Transcript\n- Ada: Let's keep the setup simple.",
  },
};

suite.define(() => {
  it("opens Summary by default and follows speech, interim notes, and final notes across tabs", async () => {
    await suite.withPage(
      { viewport: { width: 1440, height: 1000 }, timezoneId: "UTC", colorScheme: "light" },
      async ({ page }) => {
        const activeMeeting: TranscriptSessionSummary = {
          ...meeting,
          selector: "2026-09-18/product-huddle",
          sessionId: "product-huddle",
          title: "Product huddle",
          startedAt: "2026-09-18T16:00:00Z",
          stoppedAt: undefined,
          updatedAt: "2026-09-18T16:00:00Z",
          lastUtteranceAt: null,
          active: true,
          activeSubscription: true,
          utteranceCount: 0,
          participants: [],
          hasSummary: false,
          summarySource: undefined,
          overview: undefined,
        };
        const initial: TranscriptsGetResult = {
          session: activeMeeting,
          utterances: [],
          nextCursor: null,
        };
        const gateway = await installMockGateway(page, {
          methodResponses: {
            "transcripts.list": { sessions: [activeMeeting, meeting], nextCursor: null },
            "transcripts.get": initial,
          },
        });
        await page.goto(
          `${suite.server.baseUrl}meetings?selector=${encodeURIComponent(activeMeeting.selector)}`,
        );
        const view = page.locator("openclaw-meetings-page");
        const reader = view.locator(".transcripts-reader");
        const row = view.getByRole("link", { name: /Product huddle/ });
        await reader.getByRole("heading", { name: "Product huddle", exact: true }).waitFor();
        await expect.poll(() => reader.getAttribute("aria-busy")).toBe("false");
        await page.screenshot({
          path: path.join(suite.artifactDir, "meetings-live-initial.png"),
          animations: "disabled",
        });
        expect(await view.getByRole("tab", { name: "Summary" }).getAttribute("aria-selected")).toBe(
          "true",
        );
        expect(await reader.getByText("Live capture", { exact: true }).isVisible()).toBe(true);
        await view.getByRole("tab", { name: "Transcript", exact: true }).click();
        await reader.getByText("Waiting for speech…", { exact: true }).waitFor();
        expect(
          await view.getByRole("tab", { name: "Transcript" }).getAttribute("aria-selected"),
        ).toBe("true");

        const speech: TranscriptsGetResult = {
          ...initial,
          session: {
            ...activeMeeting,
            utteranceCount: 2,
            participants: ["Ada", "Sam"],
            updatedAt: "2026-09-18T16:00:12Z",
            lastUtteranceAt: "2026-09-18T16:00:12Z",
          },
          utterances: [
            {
              sequence: 0,
              speakerLabel: "Ada",
              startedAt: "2026-09-18T16:00:05Z",
              text: "Let's make the setup easier to follow.",
              final: true,
            },
            {
              sequence: 1,
              speakerLabel: "Sam",
              startedAt: "2026-09-18T16:00:12Z",
              text: "I can test keyboard navigation this afternoon.",
              final: true,
            },
          ],
        };
        await gateway.setMethodResponse("transcripts.get", speech);
        await gateway.setMethodResponse("transcripts.list", {
          sessions: [speech.session, meeting],
          nextCursor: null,
        });
        await reader.getByText(speech.utterances![1]!.text, { exact: true }).waitFor();
        expect(
          await reader.locator(".transcripts-utterance__byline strong").allTextContents(),
        ).toEqual(["Ada", "Sam"]);
        await expect.poll(() => row.textContent()).toContain("2 saved utterances");
        expect((await gateway.getRequests("transcripts.list")).length).toBeGreaterThan(1);
        await page.screenshot({
          path: path.join(suite.artifactDir, "meetings-live-speech.png"),
          animations: "disabled",
        });
        await page.setViewportSize({ width: 390, height: 844 });
        await page.emulateMedia({ reducedMotion: "reduce" });
        expect(await reader.getByText("Live capture", { exact: true }).isVisible()).toBe(true);
        expect(
          await reader.getByText(speech.utterances![1]!.text, { exact: true }).isVisible(),
        ).toBe(true);
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        ).toBe(true);
        await reader.scrollIntoViewIfNeeded();
        await page.screenshot({
          path: path.join(suite.artifactDir, "meetings-live-mobile-reduced-motion.png"),
          animations: "disabled",
        });
        await page.setViewportSize({ width: 1440, height: 1000 });
        await page.emulateMedia({ reducedMotion: "no-preference" });

        await view.getByRole("tab", { name: "Summary", exact: true }).click();
        await reader.locator(".transcripts-summary").waitFor();
        expect(new URL(page.url()).searchParams.get("tab")).toBe("summary");
        expect(await reader.getByText("Live capture", { exact: true }).isVisible()).toBe(true);
        const interim: TranscriptsGetResult = {
          ...speech,
          session: {
            ...speech.session,
            hasSummary: true,
            summarySource: "model",
            overview: "The team is discussing a simpler setup and keyboard navigation.",
          },
          summary: {
            generatedAt: "2026-09-18T16:05:00Z",
            overview: "The team is discussing a simpler setup and keyboard navigation.",
            decisions: [],
            actionItems: ["Sam will test keyboard navigation."],
            risks: [],
            participants: ["Ada", "Sam"],
            utteranceCount: 2,
            source: "model",
            markdown:
              "# Product huddle\n\n## Overview\nThe team is discussing a simpler setup and keyboard navigation.\n\n## Action items\n- Sam will test keyboard navigation.\n\n## Transcript\n- Ada: Let's make the setup easier to follow.",
          },
        };
        await gateway.setMethodResponse("transcripts.get", interim);
        await gateway.setMethodResponse("transcripts.list", {
          sessions: [interim.session, meeting],
          nextCursor: null,
        });
        await reader.getByText(interim.summary!.overview, { exact: true }).waitFor();
        await expect.poll(() => row.textContent()).toContain(interim.summary!.overview);
        expect(await reader.getByText(/Summary so far/).isVisible()).toBe(true);
        expect(await reader.getByRole("heading", { name: "Transcript", exact: true }).count()).toBe(
          0,
        );
        expect(await reader.getByText(speech.utterances![0]!.text, { exact: true }).count()).toBe(
          0,
        );
        expect(await view.getByRole("tab", { name: "Summary" }).getAttribute("aria-selected")).toBe(
          "true",
        );
        await page.screenshot({
          path: path.join(suite.artifactDir, "meetings-live-summary.png"),
          animations: "disabled",
        });
        const completed: TranscriptsGetResult = {
          ...interim,
          session: {
            ...interim.session,
            active: false,
            activeSubscription: false,
            stoppedAt: "2026-09-18T16:06:00Z",
            updatedAt: "2026-09-18T16:06:00Z",
          },
        };
        await gateway.setMethodResponse("transcripts.get", completed);
        await gateway.setMethodResponse("transcripts.list", {
          sessions: [completed.session, meeting],
          nextCursor: null,
        });
        await expect.poll(() => reader.getByText("Live capture", { exact: true }).count()).toBe(0);
        expect(await reader.getByText(interim.summary!.overview, { exact: true }).isVisible()).toBe(
          true,
        );
        expect(await view.getByRole("tab", { name: "Summary" }).getAttribute("aria-selected")).toBe(
          "true",
        );
        await page.screenshot({
          path: path.join(suite.artifactDir, "meetings-awaiting-notes.png"),
          animations: "disabled",
        });
        const notes: TranscriptsGetResult = {
          ...completed,
          session: {
            ...completed.session,
            hasSummary: true,
            summarySource: "model",
            overview: "The team agreed to simplify setup and verify keyboard navigation.",
          },
          summary: {
            generatedAt: "2026-09-18T16:06:04Z",
            overview: "The team agreed to simplify setup and verify keyboard navigation.",
            decisions: ["Simplify setup."],
            actionItems: ["Sam will test keyboard navigation."],
            risks: [],
            participants: ["Ada", "Sam"],
            utteranceCount: 2,
            source: "model",
            markdown:
              "# Product huddle\n\n## Overview\nThe team agreed to simplify setup and verify keyboard navigation.\n\n## Action items\n- Sam will test keyboard navigation.",
          },
        };
        await gateway.setMethodResponse("transcripts.get", notes);
        await gateway.setMethodResponse("transcripts.list", {
          sessions: [notes.session, meeting],
          nextCursor: null,
        });
        await reader.getByText(notes.summary!.overview, { exact: true }).waitFor();
        await expect.poll(() => row.textContent()).toContain(notes.summary!.overview);
        expect(await view.getByRole("tab", { name: "Summary" }).getAttribute("aria-selected")).toBe(
          "true",
        );
        await page.screenshot({
          path: path.join(suite.artifactDir, "meetings-completed-notes.png"),
          animations: "disabled",
        });
      },
    );
  });

  it("groups meetings, marks silent captures, and opens shareable notes without duplicate transcripts", async () => {
    await suite.withPage(
      { viewport: { width: 1440, height: 1000 }, timezoneId: "UTC", colorScheme: "light" },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          methodResponses: {
            "transcripts.list": {
              nextCursor: null,
              sessions: [
                meeting,
                {
                  ...meeting,
                  selector: "2026-08-12/quiet-check-in",
                  sessionId: "quiet-check-in",
                  title: "Quiet check-in",
                  startedAt: "2026-08-12T16:00:00Z",
                  stoppedAt: "2026-08-12T16:01:00Z",
                  utteranceCount: 0,
                  participants: [],
                  summarySource: "heuristic",
                  overview: "No transcript captured yet.",
                },
                {
                  ...meeting,
                  selector: "2026-08-11/planning",
                  sessionId: "planning",
                  title: "Launch planning",
                  startedAt: "2026-08-11T09:00:00Z",
                  stoppedAt: "2026-08-11T09:45:00Z",
                  summarySource: "heuristic",
                },
              ],
            },
            "transcripts.get": {
              cases: [{ match: { selector: meeting.selector }, response: detail }],
            },
          },
        });
        await page.goto(`${suite.server.baseUrl}meetings`);
        const view = page.locator("openclaw-meetings-page");
        await view.getByRole("link", { name: /Design review/ }).waitFor();
        expect(await view.locator(".meetings-day h2").allTextContents()).toEqual([
          "August 12, 2026",
          "August 11, 2026",
        ]);
        expect(await gateway.getRequests("transcripts.list")).toMatchObject([
          { params: { limit: 50 } },
        ]);
        expect(await gateway.getRequests("transcripts.get")).toHaveLength(0);
        const silentRow = view.getByRole("link", { name: /Quiet check-in/ });
        expect.soft(await silentRow.textContent()).toContain("No speech captured");
        expect.soft(await silentRow.textContent()).not.toContain("No transcript captured yet.");
        await view.getByRole("link", { name: /Design review/ }).click();
        await view.getByRole("heading", { name: "Design review", exact: true }).waitFor();
        expect(new URL(page.url()).searchParams.get("selector")).toBe(meeting.selector);
        expect(
          await view.getByText("Ada: prepare the revised prototype.", { exact: true }).isVisible(),
        ).toBe(true);
        expect(await view.getByRole("tab", { name: "Summary" }).getAttribute("aria-selected")).toBe(
          "true",
        );
        expect(await view.getByRole("heading", { name: "Transcript", exact: true }).count()).toBe(
          0,
        );
        expect(
          await view.getByText("Ada: Let's keep the setup simple.", { exact: true }).count(),
        ).toBe(0);
        expect(
          (await gateway.getRequests("transcripts.get")).map((request) => request.params),
        ).toEqual(
          expect.arrayContaining([
            { selector: meeting.selector },
            { selector: meeting.selector, includeUtterances: true, limit: 50 },
          ]),
        );
        for (const theme of ["light", "dark"] as const) {
          await page.emulateMedia({ colorScheme: theme });
          await expect.poll(() => page.locator("html").getAttribute("data-theme-mode")).toBe(theme);
          const mutedColor = await silentRow
            .locator(".meetings-row__meta")
            .first()
            .evaluate((element) => getComputedStyle(element).color);
          expect
            .soft(
              await silentRow
                .locator(".meetings-row__title")
                .evaluate((element) => getComputedStyle(element).color),
            )
            .toBe(mutedColor);
          await page.screenshot({
            path: path.join(suite.artifactDir, `meetings-${theme}.png`),
            animations: "disabled",
          });
        }
        await page.reload();
        await view.getByRole("heading", { name: "Design review", exact: true }).waitFor();
        expect(
          (await gateway.getRequests("transcripts.get")).map((request) => request.params),
        ).toEqual(
          expect.arrayContaining([
            { selector: meeting.selector },
            { selector: meeting.selector, includeUtterances: true, limit: 50 },
          ]),
        );
      },
    );
  });

  it("shows an actionable empty state and refreshes without hiding errors", async () => {
    await suite.withPage({ viewport: { width: 1200, height: 900 } }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        methodResponses: { "transcripts.list": { sessions: [], nextCursor: null } },
      });
      await page.goto(`${suite.server.baseUrl}meetings`);
      const view = page.locator("openclaw-meetings-page");
      await view.getByRole("heading", { name: "Your meeting notes, together" }).waitFor();
      expect(
        await view.getByRole("link", { name: "Set up meeting transcripts" }).getAttribute("href"),
      ).toBe("https://docs.openclaw.ai/cli/transcripts");
      await gateway.setMethodResponse("transcripts.list", {
        __mockError: { code: "UNAVAILABLE", message: "Meetings temporarily unavailable" },
      });
      await view.getByRole("button", { name: "Refresh", exact: true }).click();
      await view.getByRole("alert").waitFor();
      expect(await view.getByRole("alert").textContent()).toContain(
        "Meetings temporarily unavailable",
      );
      expect(
        await view.getByRole("heading", { name: "Your meeting notes, together" }).count(),
      ).toBe(0);
    });
  });
});
