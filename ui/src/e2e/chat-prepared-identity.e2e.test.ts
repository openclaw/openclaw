import type { ModelsSnapshotEvent } from "@openclaw/gateway-protocol";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import type { ApplicationContext } from "../app/context.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Prepared short-chat identity" });
const sessionKey = "agent:main:dashboard:12345678-90ab-cdef-1234-567890abcdef";
const target = { agentId: "main", shortId: "12345678", slugHint: "earlier-title" };
const historyText = "Authoritative prepared conversation.";
const publication = {
  target,
  scope: { agentId: "main", sessionKey },
  catalog: { models: [] },
} satisfies ModelsSnapshotEvent;

async function openPendingChat(page: Page) {
  const gateway = await installMockGateway(page, {
    sessionKey,
    sessions: [{ key: sessionKey, kind: "direct", displayName: "Current title", updatedAt: 1 }],
    historyMessages: [{ role: "assistant", content: historyText }],
    heldMethods: ["sessions.resolve", "chat.startup", "models.list"],
  });
  const href = `${suite.server.baseUrl}chat/main/earlier-title-12345678`;
  await page.goto(href);
  const connect = await gateway.waitForRequest("connect");
  expect(connect.params).toMatchObject({ modelCatalog: target });
  await gateway.waitForRequest("sessions.resolve", { match: target });
  const observation = await page.evaluateHandle(() => {
    const observed = { accepted: false };
    const app = document.querySelector("openclaw-app") as HTMLElement & {
      context: ApplicationContext;
    };
    const stop = app.context.gateway.subscribeEvents((event) => {
      if (event.event === "models.snapshot") {
        observed.accepted = true;
        stop();
      }
    });
    return observed;
  });
  const composer = page.locator(
    ".chat-pane-cache__pane--active .agent-chat__composer-combobox textarea",
  );
  return { gateway, href, observation, composer };
}

suite.define(() => {
  it.each(["matching", "conflicting"] as const)(
    "starts history early and preserves the draft after a delayed %s resolver reply",
    async (reply) => {
      await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
        const { gateway, href, observation, composer } = await openPendingChat(page);
        await gateway.emitGatewayEvent("models.snapshot", publication);
        await expect.poll(() => observation.evaluate((value) => value.accepted)).toBe(true);
        await expect.poll(async () => (await gateway.getRequests("chat.startup")).length).toBe(1);
        await expect.poll(() => composer.isEditable()).toBe(true);
        await composer.fill("Draft retained while the route resolves.");
        expect(page.url()).toBe(href);
        await gateway.resolveDeferred("chat.startup");
        await page.getByText(historyText, { exact: true }).waitFor();
        await gateway.resolveDeferred("sessions.resolve", {
          ok: true,
          key:
            reply === "matching"
              ? sessionKey
              : "agent:main:dashboard:12345678-1111-4111-8111-111111111111",
          agentId: "main",
          displayName: "Current title",
        });
        if (reply === "matching") {
          await expect.poll(() => page.url()).toContain("/chat/main/current-title-12345678");
        } else {
          await page.evaluate(
            () =>
              new Promise<void>((resolve) => {
                requestAnimationFrame(() => resolve());
              }),
          );
          expect(page.url()).toBe(href);
        }
        expect(await composer.inputValue()).toBe("Draft retained while the route resolves.");
        expect(await gateway.getRequests("chat.startup")).toHaveLength(1);
        await observation.dispose();
      });
    },
  );

  it("uses the resolver after a rejected publication and ignores a late accepted event", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const { gateway, observation, composer } = await openPendingChat(page);
      await gateway.emitGatewayEvent("models.snapshot", {
        ...publication,
        target: { ...target, slugHint: "another-route" },
      });
      expect(await observation.evaluate((value) => value.accepted)).toBe(false);
      expect(await gateway.getRequests("chat.startup")).toHaveLength(0);
      await gateway.resolveDeferred("sessions.resolve", {
        ok: true,
        key: sessionKey,
        agentId: "main",
        displayName: "Current title",
      });
      await gateway.waitForRequest("chat.startup");
      await expect.poll(() => composer.isEditable()).toBe(true);
      await composer.fill("Draft from ordinary resolution.");
      await gateway.emitGatewayEvent("models.snapshot", publication);
      await expect.poll(() => observation.evaluate((value) => value.accepted)).toBe(true);
      await gateway.resolveDeferred("chat.startup");
      await page.getByText(historyText, { exact: true }).waitFor();
      expect(await composer.inputValue()).toBe("Draft from ordinary resolution.");
      expect(await gateway.getRequests("chat.startup")).toHaveLength(1);
      await observation.dispose();
    });
  });
});
