import type {
  TranscriptSessionSummary,
  TranscriptsGetResult,
  TranscriptsStatusResult,
} from "@openclaw/gateway-protocol";
import type { Locator } from "playwright";
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

async function expectVisible(locator: Locator) {
  expect(await locator.isVisible()).toBe(true);
}
async function expectAbsent(locator: Locator) {
  expect(await locator.count()).toBe(0);
}
async function expectSummarySelected(view: Locator, name = "Summary") {
  expect(await view.getByRole("tab", { name }).getAttribute("aria-selected")).toBe("true");
}

const desktop = {
  viewport: { width: 1440, height: 1000 },
  timezoneId: "UTC",
  colorScheme: "light",
} as const;
type Gateway = Awaited<ReturnType<typeof installMockGateway>>;
async function publishMeeting(gateway: Gateway, result: TranscriptsGetResult) {
  await gateway.setMethodResponse("transcripts.get", result);
  await gateway.setMethodResponse("transcripts.list", {
    sessions: [result.session, meeting],
    nextCursor: null,
  });
}
function withSummary(
  result: TranscriptsGetResult,
  overview: string,
  extra: Partial<NonNullable<TranscriptsGetResult["summary"]>> = {},
): TranscriptsGetResult {
  const notes = {
    ...detail.summary!,
    generatedAt: "2026-09-18T16:05:00Z",
    participants: ["Ada", "Sam"],
    utteranceCount: 2,
    overview,
    actionItems: ["Sam will test keyboard navigation."],
    markdown: `# Product huddle\n\n## Overview\n${overview}\n\n## Action items\n- Sam will test keyboard navigation.`,
    ...extra,
  };
  return {
    ...result,
    session: {
      ...result.session,
      hasSummary: true,
      summarySource: "model",
      overview: notes.overview,
    },
    summary: notes,
  };
}

async function expectDetailRequests(gateway: Gateway) {
  expect((await gateway.getRequests("transcripts.get")).map((request) => request.params)).toEqual(
    expect.arrayContaining([
      { selector: meeting.selector },
      { selector: meeting.selector, includeUtterances: true, limit: 50 },
    ]),
  );
}

suite.define(() => {
  it("returns from capture settings to the same meeting and preserves native new-tab links", () =>
    suite.withPage(
      { viewport: { width: 1440, height: 900 }, locale: "en-US" },
      async ({ context, page }) => {
        await installMockGateway(page, {
          methodResponses: {
            "transcripts.list": { sessions: [meeting], nextCursor: null },
            "transcripts.get": detail,
            "transcripts.status": {
              enabled: true,
              providers: [],
              configuredSources: [],
              active: [],
              latestTranscript: meeting,
              omitted: { providers: 0, configuredSources: 0, active: 0 },
            } satisfies TranscriptsStatusResult,
          },
        });
        const meetingUrl = `${suite.server.baseUrl}meetings?query=design&selector=${encodeURIComponent(meeting.selector)}`;
        const capturePath =
          "settings/communications?section=transcripts#settings-communications-meeting-capture";
        const captureUrl = `${suite.server.baseUrl}${capturePath}`;
        await page.goto(meetingUrl);
        const view = page.locator("openclaw-meetings-page");
        await view.getByRole("heading", { name: "Design review", exact: true }).waitFor();
        const capture = view.getByRole("link", { name: "Meeting capture", exact: true });
        expect(await capture.getAttribute("href")).toBe(`/${capturePath}`);
        await capture.click();
        await page.getByRole("heading", { name: "Communications", exact: true }).waitFor();
        expect(page.url()).toBe(captureUrl);
        await page.getByRole("button", { name: "Back to app", exact: true }).click();
        await page.waitForURL(meetingUrl);
        expect(page.url()).toBe(meetingUrl);
        await view.getByRole("heading", { name: "Design review", exact: true }).waitFor();
        expect(
          await view.getByRole("searchbox", { name: "Search meetings", exact: true }).inputValue(),
        ).toBe("design");
        for (const activation of ["modified", "middle"] as const) {
          const [popup] = await Promise.all([
            context.waitForEvent("page"),
            capture.click(
              activation === "modified" ? { modifiers: ["ControlOrMeta"] } : { button: "middle" },
            ),
          ]);
          try {
            await popup.waitForURL(captureUrl);
            expect(page.url()).toBe(meetingUrl);
          } finally {
            await popup.close();
          }
        }
      },
    ));

  it("opens Summary by default and follows speech, interim notes, and final notes across tabs", () =>
    suite.withPage(desktop, async ({ page }) => {
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
      const initial = { session: activeMeeting, utterances: [], nextCursor: null };
      const gateway = await installMockGateway(page, {
        heldMethods: ["transcripts.summarize"],
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
      await expectSummarySelected(view);
      await expectVisible(reader.getByText("Live capture", { exact: true }));
      await view.getByRole("tab", { name: "Transcript", exact: true }).click();
      await reader.getByText("Waiting for speech…", { exact: true }).waitFor();
      await expectSummarySelected(view, "Transcript");

      const speech: TranscriptsGetResult = {
        ...initial,
        session: {
          ...activeMeeting,
          utteranceCount: 2,
          participants: ["Ada", "Sam"],
          updatedAt: "2026-09-18T16:00:12Z",
          lastUtteranceAt: "2026-09-18T16:00:12Z",
        },
        utterances: (
          [
            ["Ada", "2026-09-18T16:00:05Z", "Let's make the setup easier to follow."],
            ["Sam", "2026-09-18T16:00:12Z", "I can test keyboard navigation this afternoon."],
          ] satisfies [string, string, string][]
        ).map(([speakerLabel, startedAt, text], sequence) => ({
          sequence,
          speakerLabel,
          startedAt,
          text,
          final: true,
        })),
      };
      await publishMeeting(gateway, speech);
      await reader.getByText(speech.utterances![1]!.text, { exact: true }).waitFor();
      expect(
        await reader.locator(".transcripts-utterance__byline strong").allTextContents(),
      ).toEqual(["Ada", "Sam"]);
      await expect.poll(() => row.textContent()).toContain("2 saved utterances");
      expect((await gateway.getRequests("transcripts.list")).length).toBeGreaterThan(1);
      await page.setViewportSize({ width: 390, height: 844 });
      await page.emulateMedia({ reducedMotion: "reduce" });
      await expectVisible(reader.getByText("Live capture", { exact: true }));
      await expectVisible(reader.getByText(speech.utterances![1]!.text, { exact: true }));
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.emulateMedia({ reducedMotion: "no-preference" });

      await view.getByRole("tab", { name: "Summary", exact: true }).click();
      await reader.locator(".transcripts-summary").waitFor();
      expect(new URL(page.url()).searchParams.get("tab")).toBe("summary");
      await expectVisible(reader.getByText("Live capture", { exact: true }));
      const interim = withSummary(
        speech,
        "The team is discussing a simpler setup and keyboard navigation.",
      );
      interim.summary!.markdown +=
        "\n\n## Transcript\n- Ada: Let's make the setup easier to follow.";
      await publishMeeting(gateway, interim);
      await gateway.waitForRequest("transcripts.summarize");
      await gateway.setMethodResponse("transcripts.summarize", interim);
      await gateway.resolveDeferred("transcripts.summarize", interim);
      await reader.getByText(interim.summary!.overview, { exact: true }).waitFor();
      await expect.poll(() => row.textContent()).toContain(interim.summary!.overview);
      await expectVisible(reader.getByText(/Summary so far/));
      await expectAbsent(reader.getByRole("heading", { name: "Transcript", exact: true }));
      await expectAbsent(reader.getByText(speech.utterances![0]!.text, { exact: true }));
      await expectSummarySelected(view);
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
      await publishMeeting(gateway, completed);
      await expect.poll(() => reader.getByText("Live capture", { exact: true }).count()).toBe(0);
      await expectVisible(reader.getByText(interim.summary!.overview, { exact: true }));
      await expectSummarySelected(view);
      const notes = withSummary(
        completed,
        "The team agreed to simplify setup and verify keyboard navigation.",
        {
          generatedAt: "2026-09-18T16:06:04Z",
          decisions: ["Simplify setup."],
        },
      );
      await publishMeeting(gateway, notes);
      await reader.getByText(notes.summary!.overview, { exact: true }).waitFor();
      await expect.poll(() => row.textContent()).toContain(notes.summary!.overview);
      await expectSummarySelected(view);
    }));

  it("groups meetings, marks silent captures, and opens shareable notes without duplicate transcripts", () =>
    suite.withPage(desktop, async ({ page }) => {
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
      await expectVisible(view.getByText("Ada: prepare the revised prototype.", { exact: true }));
      await expectSummarySelected(view);
      await expectAbsent(view.getByRole("heading", { name: "Transcript", exact: true }));
      await expectAbsent(view.getByText("Ada: Let's keep the setup simple.", { exact: true }));
      await expectDetailRequests(gateway);
      for (const theme of ["light", "dark"] as const) {
        await page.emulateMedia({ colorScheme: theme });
        await expect.poll(() => page.locator("html").getAttribute("data-theme-mode")).toBe(theme);
        const color = (locator: Locator) =>
          locator.evaluate((element) => getComputedStyle(element).color);
        expect
          .soft(await color(silentRow.locator(".meetings-row__title")))
          .toBe(await color(silentRow.locator(".meetings-row__meta").first()));
      }
      await page.reload();
      await view.getByRole("heading", { name: "Design review", exact: true }).waitFor();
      await expectDetailRequests(gateway);
    }));

  it("shows an actionable empty state and refreshes without hiding errors", () =>
    suite.withPage({ viewport: { width: 1200, height: 900 } }, async ({ page }) => {
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
      await expectAbsent(view.getByRole("heading", { name: "Your meeting notes, together" }));
    }));
});
