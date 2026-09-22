import path from "node:path";
import { expect, it } from "vitest";
import type { GatewaySessionRow, SessionsListResult } from "../api/types.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Established session reconnect" });
const sessionId = "b1c2cd3c-1234-4321-9876-123456789abc";
const sessionKey = `agent:main:chat:${sessionId}`;
const row = {
  key: sessionKey,
  sessionId,
  agentId: "main",
  kind: "direct",
  displayName: "Temporary research",
  incognito: true,
  updatedAt: 1,
} satisfies GatewaySessionRow;
const sessionList = {
  ts: 1,
  path: "",
  count: 1,
  defaults: { contextTokens: null, model: "gpt-5.5", modelProvider: "openai" },
  sessions: [row],
} satisfies SessionsListResult;
const transcript = "This temporary conversation is available until the Gateway restarts.";
const history = {
  sessionKey,
  sessionId,
  sessionInfo: row,
  messages: [{ role: "assistant", content: [{ type: "text", text: transcript }] }],
};

suite.define(() => {
  it.each([
    { missing: false, width: 1280, height: 900 },
    { missing: true, width: 1280, height: 900 },
    { missing: true, width: 390, height: 844 },
  ])(
    "reconciles an established session after reconnect (missing: $missing, width: $width)",
    async ({ missing, width, height }) => {
      await suite.withPage({ viewport: { width, height } }, async ({ page }) => {
        const pageErrors: string[] = [];
        page.on("pageerror", (error) => pageErrors.push(error.message));
        const gateway = await installMockGateway(page, {
          sessionKey,
          methodResponses: {
            "sessions.resolve": { ok: true, ...row },
            "sessions.list": sessionList,
            "chat.startup": history,
            "chat.history": history,
          },
        });
        await page.goto(`${suite.server.baseUrl}chat/main/temporary-research-b1c2cd3c`);
        await page.getByText(transcript, { exact: true }).waitFor();
        const composer = page.locator(".agent-chat__composer-combobox textarea");
        await composer.fill("Keep my unsent research question.");
        await gateway.setOnline(false);
        await page.getByText(transcript, { exact: true }).waitFor();
        expect(await composer.inputValue()).toBe("Keep my unsent research question.");

        // A filtered roster omits both surviving and expired sessions. Only the
        // exact Gateway resolution may retire the established route.
        await gateway.setMethodResponse("sessions.list", {
          ...sessionList,
          count: 0,
          sessions: [],
        } satisfies SessionsListResult);
        await gateway.setMethodResponse(
          "sessions.resolve",
          missing ? { ok: false } : { ok: true, ...row },
        );
        if (missing) {
          const empty = { sessionKey, sessionInfo: { key: sessionKey }, messages: [] };
          await gateway.setMethodResponse("chat.startup", empty);
          await gateway.setMethodResponse("chat.history", empty);
        }
        const startupCount = (await gateway.getRequests("chat.startup")).length;
        await gateway.setOnline(true);
        await gateway.waitForRequest("chat.startup", { after: startupCount });
        if (missing) {
          await expect.poll(() => page.getByText(transcript, { exact: true }).count()).toBe(0);
          try {
            await expect.poll(() => page.locator(".session-route-not-found").count()).toBe(1);
          } finally {
            await page.screenshot({ path: path.join(suite.artifactDir, `missing-${width}.png`) });
          }
          expect(await composer.count()).toBe(0);
          await page.getByRole("button", { name: "Go to main session", exact: true }).waitFor();
          await page.getByRole("button", { name: "View sessions", exact: true }).waitFor();
        } else {
          await page.getByText(transcript, { exact: true }).waitFor();
          expect(await composer.inputValue()).toBe("Keep my unsent research question.");
          expect(await page.locator(".session-route-not-found").count()).toBe(0);
        }
        expect(pageErrors).toEqual([]);
      });
    },
  );
});
