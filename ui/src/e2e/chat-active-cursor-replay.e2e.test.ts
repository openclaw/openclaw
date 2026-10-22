import { expect, it } from "vitest";
import {
  chatSessionListResponse,
  createChatFlowE2eSuite,
  controlUiSessionUrl,
  installMockGateway,
  requireRecord,
} from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();

suite.define(() => {
  it("restores active commentary when an evicted session revalidates from its cursor", async () => {
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1280 },
      },
      async ({ page }) => {
        const sessionA = "agent:main:session-a";
        const sessionB = "agent:main:session-b";
        const sessionKeys = [
          sessionA,
          sessionB,
          "agent:main:session-c",
          "agent:main:session-d",
          "agent:main:session-e",
        ];
        const commentary = "Checking the workspace after returning.";
        const runStartedAt = Date.now() - 10_000;
        const pageResponse = (sessionKey: string, label: string) => ({
          deltaCursor: `cursor-${label.toLowerCase()}`,
          messages: [{ role: "user", content: `${label} cached prompt`, timestamp: 1 }],
          sessionId: `${label.toLowerCase()}-session`,
          sessionInfo: {
            key: sessionKey,
            sessionId: `${label.toLowerCase()}-session`,
            kind: "direct",
            updatedAt: 1,
          },
        });
        const historyCases = [
          {
            match: { cursor: "cursor-b", sessionKey: sessionB },
            response: {
              kind: "delta",
              messages: [],
              deltaCursor: "cursor-b-current",
              sessionInfo: {
                ...pageResponse(sessionB, "B").sessionInfo,
                updatedAt: 2,
                hasActiveRun: true,
                activeRunIds: ["run-b"],
                status: "running",
              },
              inFlightRun: {
                runId: "run-b",
                text: "",
                startedAt: runStartedAt,
                events: [
                  {
                    runId: "run-b",
                    seq: 1,
                    stream: "item",
                    ts: runStartedAt,
                    sessionKey: sessionB,
                    data: {
                      kind: "preamble",
                      itemId: "preamble-restored",
                      progressText: commentary,
                    },
                  },
                ],
              },
            },
          },
          ...sessionKeys.map((sessionKey, index) => ({
            match: { sessionKey },
            response: pageResponse(sessionKey, String.fromCharCode(65 + index)),
          })),
        ];
        const sessionRows = sessionKeys.map((key, index) => ({
          key,
          sessionId: `${String.fromCharCode(97 + index)}-session`,
          kind: "direct" as const,
          label: `Session ${String.fromCharCode(65 + index)}`,
          updatedAt: sessionKeys.length - index,
          ...(key === sessionB
            ? { activeRunIds: ["run-b"], hasActiveRun: true, status: "running" as const }
            : {}),
        }));
        const gateway = await installMockGateway(page, {
          methodResponses: {
            "chat.history": { cases: historyCases },
            "chat.startup": { cases: historyCases },
            "sessions.list": chatSessionListResponse(sessionRows),
          },
          sessionKey: sessionA,
        });

        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionA));
        const sessionLink = (sessionKey: string) =>
          page.locator(
            `.sidebar-recent-session[data-session-key="${sessionKey}"] a.sidebar-recent-session__link`,
          );
        await page.getByText("A cached prompt", { exact: true }).waitFor({ timeout: 10_000 });
        await sessionLink(sessionB).click();
        await page.getByText("B cached prompt", { exact: true }).waitFor({ timeout: 10_000 });
        await sessionLink(sessionA).click();
        for (const [index, key] of sessionKeys.slice(2).entries()) {
          await sessionLink(key).click();
          await page
            .getByText(`${String.fromCharCode(67 + index)} cached prompt`, { exact: true })
            .waitFor({ timeout: 10_000 });
        }

        const cursorRequests = async () =>
          [
            ...(await gateway.getRequests("chat.startup")),
            ...(await gateway.getRequests("chat.history")),
          ]
            .map((request) => requireRecord(request.params))
            .filter((params) => params.sessionKey === sessionB && params.cursor === "cursor-b");
        const cursorRequestsBeforeReturn = (await cursorRequests()).length;
        await sessionLink(sessionB).click();
        await expect
          .poll(async () => (await cursorRequests()).length)
          .toBeGreaterThan(cursorRequestsBeforeReturn);
        const activePane = page.locator('openclaw-chat-pane[aria-hidden="false"]');
        const assistantText = activePane.locator(".chat-group.assistant .chat-text");
        await activePane
          .getByRole("button", { name: "Stop generating", exact: true })
          .waitFor({ timeout: 10_000 });
        await assistantText.getByText(commentary, { exact: true }).waitFor({ timeout: 10_000 });
        expect(
          await assistantText.allTextContents().then((texts) => texts.map((text) => text.trim())),
        ).toEqual([commentary]);
        expect(
          await activePane.locator(".chat-bubble").getByText(commentary, { exact: true }).count(),
        ).toBe(1);
      },
    );
  });
});
