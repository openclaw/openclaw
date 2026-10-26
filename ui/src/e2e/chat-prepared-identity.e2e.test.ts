import type { ModelsSnapshotEvent } from "@openclaw/gateway-protocol";
import { GATEWAY_SERVER_CAPS } from "@openclaw/gateway-protocol/frame-guards";
import { expect, it } from "vitest";
import { getControlUiContextHandle } from "../test-helpers/control-ui-e2e-context.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { newChatPage } from "./chat-flow.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Prepared short-chat identity",
  trackBrowserContexts: true,
});
const sessionKey = "agent:main:dashboard:12345678-90ab-cdef-1234-567890abcdef";
const target = { agentId: "main", shortId: "12345678", slugHint: "earlier-title" };
const historyText = "Authoritative prepared conversation.";
const publication = {
  target,
  scope: { agentId: "main", sessionKey },
  catalog: { models: [] },
} satisfies ModelsSnapshotEvent;

async function openPendingChat() {
  const page = await newChatPage(suite);
  const gateway = await installMockGateway(page, {
    subscriptionInitialHistory: false,
    connectCapabilities: [GATEWAY_SERVER_CAPS.MODEL_CATALOG_SNAPSHOT],
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
  const context = await getControlUiContextHandle(page);
  const observation = await context.evaluateHandle((appContext) => {
    const observed = { accepted: false };
    const stop = appContext.gateway.subscribeEvents((event) => {
      if (event.event === "models.snapshot") {
        observed.accepted = true;
        stop();
      }
    });
    return observed;
  });
  await context.dispose();
  const composer = page.locator(
    ".chat-pane-cache__pane--active .agent-chat__composer-combobox textarea",
  );
  const resolve = (key = sessionKey) =>
    gateway.resolveDeferred("sessions.resolve", {
      ok: true,
      key,
      agentId: "main",
      displayName: "Current title",
    });
  return { page, gateway, href, observation, composer, resolve };
}

suite.define(() => {
  it.each(["matching", "conflicting", "rejected"] as const)(
    "preserves prepared history and drafts with a %s initial resolution",
    async (reply) => {
      const { page, gateway, href, observation, composer, resolve } = await openPendingChat();
      const rejected = reply === "rejected";
      await gateway.emitGatewayEvent(
        "models.snapshot",
        rejected
          ? { ...publication, target: { ...target, slugHint: "another-route" } }
          : publication,
      );
      if (rejected) {
        expect(await observation.evaluate((value) => value.accepted)).toBe(false);
        expect(await gateway.getRequests("chat.startup")).toHaveLength(0);
        await resolve();
        await gateway.waitForRequest("chat.startup");
      } else {
        await expect.poll(() => observation.evaluate((value) => value.accepted)).toBe(true);
        await expect.poll(async () => (await gateway.getRequests("chat.startup")).length).toBe(1);
      }
      await expect.poll(() => composer.isEditable()).toBe(true);
      const draft = "Draft retained while the route resolves.";
      await composer.fill(draft);
      if (rejected) {
        await gateway.emitGatewayEvent("models.snapshot", publication);
        await expect.poll(() => observation.evaluate((value) => value.accepted)).toBe(true);
        await gateway.resolveDeferred("chat.startup");
        await page.getByText(historyText, { exact: true }).waitFor();
      } else {
        expect(page.url()).toBe(href);
        await gateway.resolveDeferred("chat.startup");
        await page.getByText(historyText, { exact: true }).waitFor();
        await resolve(
          reply === "matching"
            ? sessionKey
            : "agent:main:dashboard:12345678-1111-4111-8111-111111111111",
        );
        if (reply === "matching") {
          await expect.poll(() => page.url()).toContain("/chat/main/current-title-12345678");
        } else {
          await page.evaluate(
            () =>
              new Promise<void>((done) => {
                requestAnimationFrame(() => done());
              }),
          );
          expect(page.url()).toBe(href);
        }
      }
      expect(await composer.inputValue()).toBe(draft);
      expect(await gateway.getRequests("chat.startup")).toHaveLength(1);
      await observation.dispose();
    },
  );
});
