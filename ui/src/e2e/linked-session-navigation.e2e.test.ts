import { expect, it } from "vitest";
import { evaluateControlUiContext } from "../test-helpers/control-ui-e2e-context.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "linked-session-navigation" });
const targetKey = "agent:main:thread:12345678-aaaa-4000-8000-000000000001";
const targetText = "Selected owner transcript 741";
const otherText = "Different owner transcript 982";
const timestamp = Date.parse("2026-09-16T12:00:00.000Z");
const makeTranscript = (text: string) => ({
  messages: [{ role: "assistant", content: [{ type: "text", text }], timestamp }],
});
const scenarios = [
  { surface: "worktrees", activation: "click", collision: true },
  { surface: "worktrees", activation: "href", collision: true },
  { surface: "worktrees", activation: "click", collision: false },
];

suite.define(() => {
  it.each(scenarios)(
    "preserves selected identity: $surface $activation collision=$collision",
    async (scenario) =>
      suite.withPage(
        { locale: "en-US", serviceWorkers: "block", viewport: { width: 1440, height: 900 } },
        async ({ page }) => {
          const target = {
            key: targetKey,
            sessionId: "target-generation",
            kind: "direct",
            displayName: "Synthetic owner review",
            boardFace: "chat",
            updatedAt: timestamp,
          };
          const other = {
            ...target,
            key: `agent:main:thread:${scenario.collision ? "12345678" : "87654321"}-bbbb-4000-8000-000000000002`,
            sessionId: "other-generation",
          };
          const gateway = await installMockGateway(page, {
            featureMethods: ["chat.metadata", "chat.startup", "worktrees.list"],
            sessions: [target, other],
            sessionKey: "agent:main:main",
            sessionTranscripts: {
              [target.key]: makeTranscript(targetText),
              [other.key]: makeTranscript(otherText),
            },
            methodResponses: {
              "sessions.list": {
                sessions: [],
                count: 0,
                totalCount: 0,
                hasMore: false,
                offset: 0,
                defaults: { contextTokens: null, model: null, modelProvider: null },
                path: "",
                ts: timestamp,
              },
              "worktrees.list": {
                worktrees: [
                  {
                    id: "synthetic-owner-worktree",
                    name: "synthetic-owner-worktree",
                    ownerKind: "session",
                    ownerId: targetKey,
                    repoRoot: "/synthetic/repository",
                    path: "/synthetic/worktrees/owner",
                    repoFingerprint: "0123456789abcdef",
                    baseRef: "main",
                    branch: "openclaw/synthetic-owner",
                    createdAt: timestamp,
                    lastActiveAt: timestamp,
                  },
                ],
              },
            },
          });
          await page.goto(`${suite.server.baseUrl}settings/worktrees`);
          const link = page
            .locator("openclaw-worktrees-page")
            .getByRole("link", { name: "Session", exact: true });
          await link.waitFor({ state: "visible" });
          const primaryKeys = () =>
            evaluateControlUiContext(
              page,
              (context) => context.sessions.state.result?.sessions.map((row) => row.key) ?? null,
            );
          await expect.poll(primaryKeys).toEqual([]);
          const href = await link.getAttribute("href");
          expect(href).toBe("/chat/main/12345678aaaa40008000000000000001");
          expect(href).not.toContain("__openclaw");
          if (scenario.activation === "href") {
            await page.goto(new URL(href!, page.url()).href);
          } else {
            await link.click();
          }
          const chooser = page.getByRole("heading", { name: "Choose a session", exact: true });
          const transcript = page.getByText(targetText, { exact: true });
          const settle = () => chooser.or(transcript).first().waitFor({ state: "visible" });
          await settle();
          const observe = async () => ({
            chooser: await chooser.isVisible(),
            targetVisible: await transcript.isVisible(),
            otherVisible: await page.getByText(otherText, { exact: true }).isVisible(),
            startupRequests: await gateway.getRequests("chat.startup"),
          });
          const afterClick = await observe();
          await page.reload();
          await settle();
          const afterReload = await observe();
          for (const stage of [afterClick, afterReload]) {
            expect(stage).toMatchObject({
              chooser: false,
              targetVisible: true,
              otherVisible: false,
            });
            expect(stage.startupRequests.map((request) => request.params)).toContainEqual(
              expect.objectContaining({ sessionKey: targetKey }),
            );
            expect(stage.startupRequests.map((request) => request.params)).not.toContainEqual(
              expect.objectContaining({ sessionKey: other.key }),
            );
          }
          expect(
            afterReload.startupRequests.every((request) =>
              afterClick.startupRequests.every((previous) => previous.id !== request.id),
            ),
          ).toBe(true);
        },
      ),
  );
});
