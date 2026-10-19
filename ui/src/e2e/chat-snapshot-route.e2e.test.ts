import path from "node:path";
import { expect, it } from "vitest";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiSessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Snapshot route admission" });
const id = "b1c2cd3c-1234-4321-9876-123456789abc";
const sessionKey = `agent:main:chat:${id}`;
const transcript = "The cached conversation is ready before route resolution.";
const row = createControlUiSessionRow(sessionKey, "Snapshot conversation", 1);

suite.define(() => {
  it.each(["same", "deleted", "moved"] as const)(
    "renders off-roster cached rows before resolve and reconciles %s authority",
    async (outcome) => {
      await suite.withPage(
        { viewport: { width: 1280, height: 900 }, serviceWorkers: "block" },
        async ({ page }) => {
          const gateway = await installMockGateway(page, {
            sessionKey,
            authMethod: "trusted-proxy",
            authMode: "trusted-proxy",
            sessions: [],
            heldMethods: ["sessions.resolve", "chat.startup"],
            historyMessages: [{ role: "assistant", content: transcript }],
            methodResponses: {
              "sessions.describe": { session: row },
              "sessions.resolve": { ok: true, ...row },
            },
          });
          await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
          await gateway.waitForRequest("chat.startup");
          await gateway.resolveDeferred("chat.startup");
          await page.getByText(transcript, { exact: true }).waitFor();
          await page.waitForFunction(() =>
            Object.keys(localStorage).some((key) =>
              key.startsWith("openclaw.control.bootRecord.v1:"),
            ),
          );
          await page.evaluate(async () => {
            const pane = document.querySelector(".chat-pane-cache__pane--active");
            await Reflect.get(pane!, "sessionSnapshotStore").flush();
          });
          await page.goto(
            new URL(`/chat/main/${id.replaceAll("-", "")}`, suite.server.baseUrl).href,
          );
          await page.getByText(transcript, { exact: true }).waitFor();
          await gateway.waitForRequest("sessions.resolve");
          await gateway.waitForRequest("chat.startup");
          await page.screenshot({ path: path.join(suite.artifactDir, `cached-${outcome}.png`) });
          const movedKey = `agent:other:chat:${id}`;
          if (outcome === "moved") {
            await gateway.setMethodResponse("sessions.describe", {
              session: { ...row, key: movedKey, agentId: "other" },
            });
          }
          const resolution =
            outcome === "deleted"
              ? { ok: false }
              : {
                  ok: true,
                  ...row,
                  ...(outcome === "moved" ? { key: movedKey, agentId: "other" } : {}),
                };
          await gateway.setMethodResponse("sessions.resolve", resolution);
          await gateway.resolveDeferred("sessions.resolve", resolution);
          if (outcome === "deleted") {
            await page.locator(".session-route-not-found").waitFor();
            expect(await page.getByText(transcript, { exact: true }).count()).toBe(0);
          } else if (outcome === "moved") {
            await page.waitForURL((url) => url.pathname.startsWith("/chat/other/"));
            await page
              .locator(".chat-pane-cache__pane--visible")
              .getByText(transcript, { exact: true })
              .waitFor({ state: "hidden" });
          } else {
            await gateway.resolveDeferred("chat.startup");
            await page.getByText(transcript, { exact: true }).waitFor();
          }
        },
      );
    },
  );
});
