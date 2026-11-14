import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installNativePluginMockGateway } from "../test-helpers/control-ui-plugin-e2e.ts";
import { requireRecord, requireString } from "./chat-flow.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
const suite = createControlUiE2eSuite({ name: "Knowledge uncertain settings outcomes" });
suite.define(() => {
  it.each(["assignment", "access"])(
    "reads back an uncertain %s without resubmission",
    async (kind) => {
      await suite.withPage(
        {
          viewport: { width: 1280, height: 1000 },
          colorScheme: "light",
          reducedMotion: "reduce",
          locale: "en-US",
        },
        async ({ page }) => {
          let applied = false;
          let mutations = 0;
          const sessionKey = "agent:main:discord:channel:team";
          const snapshot = () => ({
            revision: (applied ? "b" : "a").repeat(64),
            grants: {
              revision: (applied ? "b" : "a").repeat(64),
              entries: [
                {
                  sessionKey,
                  agent: "main",
                  access: applied && kind === "access" ? "read-write" : "read",
                },
              ],
            },
            defaultAgent: "main",
            canChange: true,
            issues: [],
            agents: [
              {
                id: "main",
                name: "Research",
                supported: true,
                binding: applied && kind === "assignment" ? "named:team" : "agent:main",
              },
            ],
            stores: [
              {
                binding: "agent:main",
                kind: "isolated",
                owner: "main",
                label: "Research",
                members: applied && kind === "assignment" ? [] : ["main"],
                retained: false,
                state: "ready",
                records: 4,
              },
              {
                binding: "named:team",
                kind: "named",
                key: "team",
                label: "Team",
                members: applied && kind === "assignment" ? ["main"] : [],
                retained: false,
                state: "ready",
                records: 8,
              },
            ],
          });
          await installNativePluginMockGateway(
            page,
            {
              nativePlugins: [
                {
                  pluginId: "knowledge",
                  rootDir: path.resolve("extensions/knowledge"),
                  source: "./src/control-ui.ts",
                },
              ],
              operatorScopes: ["operator.admin", "operator.read", "operator.write"],
              methodResponses: {
                "agents.list": { defaultId: "main", agents: [{ id: "main", name: "Research" }] },
                "sessions.list": {
                  ts: 1,
                  count: 1,
                  defaults: {},
                  sessions: [
                    {
                      key: sessionKey,
                      kind: "group",
                      chatType: "channel",
                      label: "Team discussion",
                      updatedAt: 1,
                    },
                  ],
                },
                "cron.list": { jobs: [] },
              },
            },
            {
              requestHandlers: {
                "plugins.sessionAction": (params) => {
                  const action = requireString(requireRecord(params).actionId, "feature action");
                  if (action === "stores_change" || action === "stores_grant") {
                    applied = true;
                    mutations += 1;
                    return {
                      __mockError: { code: "UNAVAILABLE", message: "Response interrupted" },
                    };
                  }
                  const answers: Record<string, unknown> = {
                    stores_snapshot: snapshot(),
                    status: {
                      agent: "main",
                      vault: "vault-fixture",
                      scope: "private",
                      store: "ready",
                      snapshot: "s1",
                    },
                    ontology: { view: "catalog", nextOffset: null, definitions: [] },
                    recent: { items: [], upperSequence: 0, nextBefore: null },
                  };
                  if (!(action in answers)) {
                    throw new Error("Unexpected fixture action: " + action);
                  }
                  return { ok: true, result: answers[action] };
                },
              },
            },
          );
          await page.goto(
            new URL(
              "/plugin?plugin=knowledge&id=overview&p.view=settings",
              suite.server.baseUrl,
            ).toString(),
          );
          const root = page.locator(".knowledge-page");
          await root.getByRole("heading", { name: "Stores & sharing", exact: true }).waitFor();
          let panel;
          if (kind === "assignment") {
            await root
              .getByRole("button", { name: /Change store for/ })
              .first()
              .click();
            await root.getByRole("menuitem", { name: /^Use shared store/ }).click();
            panel = root.locator(".knowledge-store-dialog");
            await panel.getByRole("button", { name: "Use Team", exact: true }).click();
          } else {
            panel = root.locator(".knowledge-grants");
            await panel
              .getByLabel("Access for Team discussion", { exact: true })
              .selectOption("read-write");
          }
          const feedback = panel.locator(".knowledge-dialog-feedback");
          await expect
            .poll(() => feedback.textContent())
            .toContain(
              kind === "assignment"
                ? "Could not confirm the assignment."
                : "Could not confirm the access change.",
            );
          expect(applied).toBe(true);
          expect(mutations).toBe(1);
          if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
            const frame = await takeControlUiScreenshotFrame(page, panel, [feedback], {
              animations: "disabled",
              elements: [panel],
            });
            await writeFile(path.join(suite.artifactDir, "outcome-full.png"), frame.png);
            await writeFile(
              path.join(suite.artifactDir, "outcome-detail.png"),
              frame.elements[0]!.png,
            );
          }
          if (kind === "assignment") {
            await panel.getByRole("button", { name: "Cancel", exact: true }).click();
          }
          await root.getByRole("button", { name: "Stores & sharing", exact: true }).click();
          if (kind === "assignment") {
            await expect
              .poll(() => root.locator(".knowledge-store-bar").textContent())
              .toContain("Team");
          } else {
            await expect
              .poll(() =>
                root.getByLabel("Access for Team discussion", { exact: true }).inputValue(),
              )
              .toBe("read-write");
          }
          expect(mutations).toBe(1);
        },
      );
    },
  );
});
