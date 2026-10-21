import path from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiSessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Snapshot route admission" });
const id = "b1c2cd3c-1234-4321-9876-123456789abc";
const sessionKey = `agent:main:chat:${id}`;
const transcript = "The cached conversation is ready before route resolution.";
const row = createControlUiSessionRow(sessionKey, "Snapshot conversation", 1);

async function openCachedRoute(page: Page) {
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
    Object.keys(localStorage).some((key) => key.startsWith("openclaw.control.bootRecord.v1:")),
  );
  await page.evaluate(async () => {
    const pane = document.querySelector(".chat-pane-cache__pane--active");
    await Reflect.get(pane!, "sessionSnapshotStore").flush();
  });
  return gateway;
}

suite.define(() => {
  it("rejects stale route confirmation across reconnect while cached rows are admitted", async () => {
    await suite.withPage(
      { viewport: { width: 1280, height: 900 }, serviceWorkers: "block" },
      async ({ page }) => {
        const gateway = await openCachedRoute(page);
        await page.goto(new URL(`/chat/main/${id}`, suite.server.baseUrl).href);
        await page.getByText(transcript, { exact: true }).waitFor();
        await gateway.waitForRequest("sessions.resolve");
        const connects = (await gateway.getRequests("connect")).length;
        await gateway.deferNext("connect");
        await gateway.closeLatest(4000, "synthetic reconnect during route confirmation");
        await gateway.waitForRequest("connect", { after: connects });
        await gateway.resolveDeferred("sessions.resolve", {
          ok: true,
          ...row,
          key: `agent:other:chat:${id}`,
          agentId: "other",
        });
        expect(new URL(page.url()).pathname).toBe(`/chat/main/${id}`);
        await gateway.setMethodResponse("sessions.resolve", { ok: true, ...row });
        await gateway.deferNext("sessions.resolve");
        await gateway.resolveDeferred("connect");
        await gateway.waitForRequest("sessions.resolve", { after: 1 });
        await gateway.resolveDeferred("sessions.resolve", { ok: true, ...row });
        await gateway.resolveDeferred("chat.startup");
        await page.getByText(transcript, { exact: true }).waitFor();
        await page.waitForFunction(() => window.openclawControlUi?.snapshot().routeReady === true);
        expect(new URL(page.url()).pathname).toMatch(/^\/chat\/main\//);
        expect(await gateway.getRequests("chat.send")).toHaveLength(0);
      },
    );
  });

  it.each(["same", "deleted", "moved", "mismatch"] as const)(
    "renders off-roster cached rows before resolve and reconciles %s authority",
    async (outcome) => {
      await suite.withPage(
        { viewport: { width: 1280, height: 900 }, serviceWorkers: "block" },
        async ({ page }) => {
          const gateway = await openCachedRoute(page);
          const reference = outcome === "same" ? id : id.replaceAll("-", "");
          await page.goto(new URL(`/chat/main/${reference}`, suite.server.baseUrl).href);
          await page.getByText(transcript, { exact: true }).waitFor();
          await gateway.waitForRequest("sessions.resolve");
          await gateway.waitForRequest("chat.startup");
          await page.screenshot({ path: path.join(suite.artifactDir, `cached-${outcome}.png`) });
          const movedKey =
            outcome === "mismatch"
              ? "agent:main:chat:98765432-1234-4321-9876-123456789abc"
              : `agent:other:chat:${id}`;
          const movedAgent = outcome === "mismatch" ? "main" : "other";
          if (outcome === "moved" || outcome === "mismatch") {
            await gateway.setMethodResponse("sessions.describe", {
              session: { ...row, key: movedKey, agentId: movedAgent },
            });
          }
          const resolution =
            outcome === "deleted"
              ? { ok: false }
              : {
                  ok: true,
                  ...row,
                  ...(outcome === "moved" || outcome === "mismatch"
                    ? { key: movedKey, agentId: movedAgent }
                    : {}),
                };
          await gateway.setMethodResponse("sessions.resolve", resolution);
          await gateway.resolveDeferred("sessions.resolve", resolution);
          if (outcome === "deleted") {
            await page.locator(".session-route-not-found").waitFor();
            expect(await page.getByText(transcript, { exact: true }).count()).toBe(0);
          } else if (outcome === "moved" || outcome === "mismatch") {
            await page.waitForURL(
              (url) =>
                url.pathname.startsWith(`/chat/${movedAgent}/`) && !url.pathname.includes(id),
            );
            await page
              .locator(".chat-pane-cache__pane--visible")
              .getByText(transcript, { exact: true })
              .waitFor({ state: "hidden" });
          } else {
            await gateway.resolveDeferred("chat.startup");
            await page.getByText(transcript, { exact: true }).waitFor();
            await page.waitForFunction(
              () => window.openclawControlUi?.snapshot().routeReady === true,
            );
            expect(await gateway.getRequests("sessions.resolve")).toHaveLength(1);
          }
        },
      );
    },
  );

  it.each(["same", "deleted", "moved", "mismatch"] as const)(
    "holds sends after empty startup until %s route authority settles",
    async (outcome) => {
      await suite.withPage(
        { viewport: { width: 1280, height: 900 }, serviceWorkers: "block" },
        async ({ page }) => {
          const gateway = await openCachedRoute(page);
          await page.goto(new URL(`/chat/main/${id}`, suite.server.baseUrl).href);
          await page.getByText(transcript, { exact: true }).waitFor();
          await gateway.waitForRequest("sessions.resolve");
          await gateway.waitForRequest("chat.startup");
          await gateway.resolveDeferred("chat.startup", { messages: [] });
          const pane = page.locator(".chat-pane-cache__pane--active");
          await page.waitForFunction(() => {
            const active = document.querySelector(".chat-pane-cache__pane--active");
            return active && Reflect.get(active, "transcriptReady") === true;
          });
          const draft = "Keep this draft until the route is confirmed";
          await pane.locator(".agent-chat__composer-combobox textarea").fill(draft);
          const send = pane.locator(".chat-send-btn--send");
          expect(await send.isDisabled()).toBe(true);
          await pane.locator(".agent-chat__composer-combobox textarea").press("Enter");
          expect(
            (await pane.locator(".agent-chat__composer-combobox textarea").inputValue()).trimEnd(),
          ).toBe(draft);
          expect(await gateway.getRequests("chat.send")).toHaveLength(0);
          const movedKey =
            outcome === "mismatch"
              ? "agent:main:chat:98765432-1234-4321-9876-123456789abc"
              : `agent:other:chat:${id}`;
          const movedAgent = outcome === "mismatch" ? "main" : "other";
          const resolution =
            outcome === "deleted"
              ? { ok: false }
              : {
                  ok: true,
                  ...row,
                  ...(outcome === "moved" || outcome === "mismatch"
                    ? { key: movedKey, agentId: movedAgent }
                    : {}),
                };
          await gateway.setMethodResponse("sessions.resolve", resolution);
          await gateway.resolveDeferred("sessions.resolve", resolution);
          if (outcome === "same") {
            await page.waitForFunction(
              () => window.openclawControlUi?.snapshot().routeReady === true,
            );
            expect(await send.isEnabled()).toBe(true);
          } else if (outcome === "deleted") {
            await page.locator(".session-route-not-found").waitFor();
          } else {
            await page.waitForURL(
              (url) =>
                url.pathname.startsWith(`/chat/${movedAgent}/`) && !url.pathname.includes(id),
            );
          }
          expect(await gateway.getRequests("chat.send")).toHaveLength(0);
        },
      );
    },
  );
});
