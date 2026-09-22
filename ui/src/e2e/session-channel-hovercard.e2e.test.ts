import { expect, it } from "vitest";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import {
  chatSessionListResponse,
  controlUiSessionUrl,
  createChatFlowE2eSuite,
  installMockGateway,
} from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();
const pageOptions = {
  colorScheme: "dark" as const,
  hasTouch: false,
  locale: "en-US",
  serviceWorkers: "block" as const,
  viewport: { height: 1000, width: 1280 },
};

suite.define(() => {
  it("distinguishes same-title channel sessions and keeps session contributors separate from chat identity", async () => {
    const now = Date.now();
    const selected = sessionRow("agent:main:selected", "Planning desk", now);
    const group = sessionRow(
      "agent:main:whatsapp:group:120363000001@g.us",
      "Weekend plans",
      now - 1,
      {
        kind: "group",
        channel: "whatsapp",
        origin: {
          provider: "whatsapp",
          chatType: "group",
          label: "Weekend plans",
          from: "120363000001@g.us",
          accountId: "personal",
        },
        createdActor: {
          type: "human",
          id: "cli",
          label: "cli",
          identity: { type: "profile", id: "cli" },
        },
        participants: [{ identity: { type: "profile", id: "profile-ada" }, label: "Ada" }],
        participantCount: 1,
        lastMessagePreview: "The picnic is booked for Saturday.",
      },
    );
    const imessage = sessionRow("agent:main:imessage:group:chat123", "Weekend plans", now - 2, {
      kind: "group",
      channel: "imessage",
      origin: { provider: "imessage", chatType: "group", label: "Weekend plans" },
    });
    const direct = sessionRow("agent:main:whatsapp:direct:+15555550123", "Ada", now - 3, {
      channel: "whatsapp",
      origin: {
        provider: "whatsapp",
        chatType: "direct",
        label: "Ada",
        from: "15555550123@s.whatsapp.net",
        accountId: "personal",
      },
    });

    await suite.withPage(pageOptions, async ({ page }) => {
      await page.addInitScript(() => {
        localStorage.setItem("openclaw:sidebar:sessions:collapsed-sections", "[]");
      });
      const gateway = await installMockGateway(page, {
        sessionKey: selected.key,
        sessions: [selected, group, imessage, direct],
        featureMethods: ["chat.metadata", "chat.startup", "progressCard.get"],
        methodResponses: { "progressCard.get": { card: null } },
      });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, selected.key));
      const groupRow = page.locator(`.sidebar-recent-session[data-session-key="${group.key}"]`);
      const imessageRow = page.locator(
        `.sidebar-recent-session[data-session-key="${imessage.key}"]`,
      );
      await expect
        .poll(() => groupRow.locator(".sidebar-recent-session__channel").textContent())
        .toBe("WhatsApp");
      expect(await imessageRow.locator(".sidebar-recent-session__channel").textContent()).toBe(
        "iMessage",
      );

      await groupRow.hover();
      const card = page.locator(".session-progress-hovercard");
      await card.waitFor({ state: "visible" });
      await expect
        .poll(async () => (await card.locator(".session-hovercard__channel").textContent())?.trim())
        .toBe("Linked to WhatsApp");
      expect(await card.locator(".session-hovercard__conversation").textContent()).toContain(
        "Group chat",
      );
      expect(await card.locator(".session-hovercard__conversation").textContent()).toContain(
        "Via personal",
      );
      expect(await card.locator(".session-hovercard__header").textContent()).not.toContain("cli");
      expect(await card.textContent()).toContain("In this session");
      expect(await card.locator(".session-hovercard__attribution").textContent()).toContain("cli");
      expect(await card.textContent()).not.toMatch(/members|120363000001/);
      expect(await card.textContent()).toContain("The picnic is booked for Saturday.");
      await gateway.waitForRequest("progressCard.get", { match: { sessionKey: group.key } });

      await imessageRow.hover();
      await expect
        .poll(async () => (await card.locator(".session-hovercard__channel").textContent())?.trim())
        .toBe("Linked to iMessage");
      expect(await card.locator(".session-hovercard__title").textContent()).toBe("Weekend plans");

      await page.locator(`.sidebar-recent-session[data-session-key="${direct.key}"]`).hover();
      await expect.poll(() => card.locator(".session-hovercard__title").textContent()).toBe("Ada");
      expect(await card.locator(".session-hovercard__conversation").textContent()).toContain(
        "+15555550123",
      );
      expect(await card.textContent()).not.toContain("@s.whatsapp.net");
    });
  });

  it("refreshes channel details in an already-open hovercard when Gateway metadata changes", async () => {
    const now = Date.now();
    const selected = sessionRow("agent:main:selected", "Planning desk", now);
    const linked = sessionRow(
      "agent:main:discord:channel:123456789012345678",
      "Launch checklist",
      now - 1,
      {
        kind: "group",
        channel: "discord",
        origin: {
          provider: "discord",
          chatType: "channel",
          label: "Example community #planning channel id:123456789012345678",
          accountId: "community",
        },
      },
    );
    await suite.withPage(pageOptions, async ({ page }) => {
      await page.addInitScript(() => {
        localStorage.setItem("openclaw:sidebar:sessions:collapsed-sections", "[]");
      });
      const gateway = await installMockGateway(page, {
        sessionKey: selected.key,
        sessions: [selected, linked],
        featureMethods: ["chat.metadata", "chat.startup", "progressCard.get"],
        methodResponses: { "progressCard.get": { card: null } },
      });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, selected.key));
      await page.locator(`.sidebar-recent-session[data-session-key="${linked.key}"]`).hover();
      const card = page.locator(".session-progress-hovercard");
      await expect
        .poll(() => card.locator(".session-hovercard__conversation").textContent())
        .toContain("Example community #planning");
      const revised = {
        ...linked,
        origin: {
          provider: "discord",
          chatType: "channel",
          accountId: "community",
          label: "Example community #release channel id:123456789012345678",
          threadId: "987654321098765432",
        },
      };
      await gateway.setSessionsListResponse(chatSessionListResponse([selected, revised]));
      await gateway.emitGatewayEvent("sessions.changed", { agentId: "main", reason: "update" });
      await expect
        .poll(() => card.locator(".session-hovercard__conversation").textContent())
        .toContain("Example community #release");
      expect(await card.locator(".session-hovercard__conversation").textContent()).toContain(
        "Thread",
      );
      expect(await card.textContent()).not.toContain("#planning");
    });
  });

  it("does not call a dashboard session channel-linked just because it has delivery metadata", async () => {
    const now = Date.now();
    const origin = {
      provider: "whatsapp",
      chatType: "direct",
      from: "+15555550123",
      accountId: "personal",
    };
    const main = sessionRow("agent:main:main", "Main", now, { channel: "whatsapp", origin });
    const dashboard = sessionRow("agent:main:dashboard:example", "Research desk", now - 1, {
      channel: "whatsapp",
      origin,
    });
    await suite.withPage(pageOptions, async ({ page }) => {
      await page.addInitScript(() => {
        localStorage.setItem("openclaw:sidebar:sessions:collapsed-sections", "[]");
      });
      await installMockGateway(page, {
        sessionKey: main.key,
        sessions: [main, dashboard],
        featureMethods: ["chat.metadata", "chat.startup", "progressCard.get"],
        methodResponses: { "progressCard.get": { card: null } },
      });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, main.key));
      const row = page.locator(`.sidebar-recent-session[data-session-key="${dashboard.key}"]`);
      await row.waitFor({ state: "visible" });
      expect(await row.locator(".sidebar-recent-session__channel").count()).toBe(0);
      await row.hover();
      const card = page.locator(".session-progress-hovercard");
      await card.waitFor({ state: "visible" });
      await expect
        .poll(() => card.locator(".session-hovercard__title").textContent())
        .toBe(dashboard.label);
      expect(await card.locator(".session-hovercard__channel").count()).toBe(0);
      expect(await card.textContent()).not.toContain("+15555550123");
    });
  });
});
