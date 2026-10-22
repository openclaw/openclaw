import { expect, it } from "vitest";
import type { AgentsListResult } from "../api/types.ts";
import {
  controlUiSessionUrl,
  createChatFlowE2eSuite,
  installMockGateway,
  requireRecord,
  requireString,
} from "./chat-flow.test-support.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";

const suite = createChatFlowE2eSuite();
const initialName = "Atlas";
const nextName = "Cedar";
const initialAvatar = "🦞";
const nextAvatar = "🌻";
const draft = "Keep this unsent garden note.";
const reply = "The garden note stayed in this chat.";
const identity = (name: string, avatar: string) => ({
  agentId: "main",
  name,
  avatar,
  avatarStatus: "none",
  nameSource: "agent",
});
const roster = (name: string, avatar: string): AgentsListResult => ({
  defaultId: "main",
  mainKey: "main",
  scope: "per-sender",
  agents: [
    { id: "main", name, identity: { name, emoji: avatar }, model: { primary: "openai/gpt-5.5" } },
  ],
});

suite.define(() => {
  it.each(["config.changed", "agent.identity.changed"])("%s refreshes chat", async (event) => {
    const context = await suite.newBrowserContext({
      ...createControlUiE2eContextOptions(),
      locale: "en-US",
      viewport: { width: 1440, height: 900 },
    });
    const page = await context.newPage();
    try {
      const gateway = await installMockGateway(page, {
        assistantName: initialName,
        historyMessages: [],
        communityInvite: false,
        methodResponses: {
          "agent.identity.get": identity(initialName, initialAvatar),
          "agents.list": roster(initialName, initialAvatar),
        },
      });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, "main"));
      const heading = page.locator(".agent-chat__welcome-identity h2");
      const avatar = page.locator(".agent-chat__welcome-avatar");
      const avatarText = avatar.locator(".identity-avatar__text");
      const composer = page.locator(".agent-chat__composer-combobox textarea");
      await expect.poll(() => heading.textContent()).toBe(initialName);
      await expect.poll(() => avatarText.getAttribute("data-avatar")).toBe(initialAvatar);
      await expect.poll(() => composer.getAttribute("placeholder")).toContain(initialName);
      await composer.fill(draft);
      const sessionUrl = page.url();
      expect(await page.locator(".chat-group").count()).toBe(0);

      const refreshes = [];
      for (const [method, response] of [
        ["agent.identity.get", identity(nextName, nextAvatar)],
        ["agents.list", roster(nextName, nextAvatar)],
      ] as const) {
        refreshes.push({ method, after: (await gateway.getRequests(method)).length });
        await gateway.setMethodResponse(method, response);
      }

      await gateway.emitGatewayEvent(
        event,
        event === "config.changed" ? { hash: "synthetic-identity-change" } : { agentId: "main" },
      );
      for (const refresh of refreshes) {
        await gateway.waitForRequest(refresh.method, { after: refresh.after });
      }
      await expect.poll(() => heading.textContent()).toBe(nextName);
      await expect.poll(() => avatarText.getAttribute("data-avatar")).toBe(nextAvatar);
      await expect.poll(() => page.title()).toContain(nextName);
      const observed = {
        name: (await heading.textContent())?.trim(),
        avatar: await avatarText.getAttribute("data-avatar"),
        avatarLabel: await avatar.getAttribute("aria-label"),
        placeholder: await composer.getAttribute("placeholder"),
      };
      expect(await composer.inputValue()).toBe(draft);
      expect(page.url()).toBe(sessionUrl);
      expect(await page.locator(".chat-group").count()).toBe(0);
      expect((await gateway.getRequests("chat.send")).length).toBe(0);

      await page.getByRole("button", { name: "Send message" }).click();
      const request = await gateway.waitForRequest("chat.send");
      const params = requireRecord(request.params);
      expect(params).toMatchObject({ sessionKey: "agent:main:main", message: draft });
      const runId = requireString(params.idempotencyKey, "chat run id");
      await gateway.emitChatFinal({ runId, text: reply });
      await page.locator(".chat-group.assistant .chat-text", { hasText: reply }).waitFor();
      const sender = (
        await page.locator(".chat-group.assistant .chat-sender-name").first().textContent()
      )?.trim();
      expect(page.url()).toBe(sessionUrl);
      expect((await gateway.getRequests("chat.send")).length).toBe(1);
      expect({ ...observed, sender }, "config identity display follows committed identity").toEqual(
        {
          name: nextName,
          avatar: nextAvatar,
          avatarLabel: nextName,
          placeholder: "Message Cedar",
          sender: nextName,
        },
      );
    } finally {
      await suite.closeBrowserContext(context);
    }
  });
});
