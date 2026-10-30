import { expect, it } from "vitest";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import {
  chatSessionListResponse,
  controlUiSessionUrl,
  createChatFlowE2eSuite,
  installMockGateway,
} from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();
const now = Date.now();
const selected = sessionRow("agent:main:selected", "Planning desk", now);
type Page = Parameters<typeof installMockGateway>[0];
type Session = ReturnType<typeof sessionRow>;
const rowFor = (page: Page, key: string) =>
  page.locator(`.sidebar-recent-session[data-session-key="${key}"]`);
const channelVisible = (row: ReturnType<typeof rowFor>, name: string) =>
  row.locator(".sidebar-recent-session__channel").getByText(name, { exact: true }).isVisible();
const pageOptions = {
  colorScheme: "dark" as const,
  hasTouch: false,
  locale: "en-US",
  serviceWorkers: "block" as const,
  viewport: { height: 1000, width: 1280 },
};
const whatsappOrigin = (chatType: "direct" | "group", from: string) => ({
  provider: "whatsapp",
  chatType,
  from,
  accountId: "personal",
});

async function withSessions(
  sessions: [Session, ...Session[]],
  run: (context: {
    page: Page;
    gateway: Awaited<ReturnType<typeof installMockGateway>>;
  }) => Promise<void>,
) {
  await suite.withPage(pageOptions, async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem("openclaw:sidebar:sessions:collapsed-sections", "[]");
    });
    const gateway = await installMockGateway(page, {
      sessionKey: sessions[0].key,
      sessions,
      featureMethods: ["chat.metadata", "chat.startup", "progressCard.get"],
      methodResponses: { "progressCard.get": { card: null } },
    });
    await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessions[0].key));
    await run({ page, gateway });
  });
}

suite.define(() => {
  it("distinguishes same-title channel sessions and keeps session contributors separate from chat identity", async () => {
    const groupKey = "agent:main:whatsapp:group:120363000001@g.us";
    const group = sessionRow(groupKey, "Weekend plans", now - 1, {
      kind: "group",
      channel: "whatsapp",
      origin: whatsappOrigin("group", "120363000001@g.us"),
      createdActor: {
        type: "human",
        id: "cli",
        label: "cli",
        identity: { type: "profile", id: "cli" },
      },
      participants: [{ identity: { type: "profile", id: "profile-ada" }, label: "Ada" }],
      participantCount: 1,
      lastMessagePreview: "The picnic is booked for Saturday.",
    });
    const imessage = sessionRow("agent:main:imessage:group:chat123", "Weekend plans", now - 2, {
      kind: "group",
      channel: "imessage",
      origin: { provider: "imessage", chatType: "group", label: "Weekend plans" },
    });
    const direct = sessionRow("agent:main:whatsapp:direct:+15555550123", "Ada", now - 3, {
      channel: "whatsapp",
      origin: whatsappOrigin("direct", "15555550123@s.whatsapp.net"),
    });

    await withSessions([selected, group, imessage, direct], async ({ page, gateway }) => {
      const groupRow = rowFor(page, group.key);
      const imessageRow = rowFor(page, imessage.key);
      await expect.poll(() => channelVisible(groupRow, "WhatsApp")).toBe(true);
      expect(await groupRow.getByRole("link", { name: /Linked to WhatsApp/ }).count()).toBe(1);
      expect(await channelVisible(imessageRow, "iMessage")).toBe(true);
      expect(await imessageRow.getByRole("link", { name: /Linked to iMessage/ }).count()).toBe(1);

      await groupRow.hover();
      const card = page.locator(".session-progress-hovercard");
      const detail = (part: string) => card.locator(`.session-hovercard__${part}`).textContent();
      await card.waitFor({ state: "visible" });
      await expect.poll(async () => (await detail("channel"))?.trim()).toBe("Linked to WhatsApp");
      expect(await detail("conversation")).toContain("Group chat");
      expect(await detail("conversation")).toContain("Via personal");
      expect(await detail("header")).not.toContain("cli");
      expect(await card.textContent()).toContain("In this session");
      expect(await detail("attribution")).toContain("cli");
      expect(await card.textContent()).not.toMatch(/members|120363000001/);
      expect(await card.textContent()).toContain("The picnic is booked for Saturday.");
      await gateway.waitForRequest("progressCard.get", { match: { sessionKey: group.key } });

      await imessageRow.hover();
      await expect.poll(async () => (await detail("channel"))?.trim()).toBe("Linked to iMessage");
      expect(await detail("title")).toBe("Weekend plans");

      await rowFor(page, direct.key).hover();
      await expect.poll(() => detail("title")).toBe("Ada");
      expect(await detail("conversation")).toContain("+15555550123");
      expect(await card.textContent()).not.toContain("@s.whatsapp.net");
    });
  });

  it("refreshes channel details in an already-open hovercard when Gateway metadata changes", async () => {
    const linkedKey = "agent:main:discord:channel:123456789012345678";
    const origin = {
      provider: "discord",
      chatType: "channel",
      label: "Example community #planning channel id:123456789012345678",
      accountId: "community",
    };
    const linked = sessionRow(linkedKey, "Launch checklist", now - 1, {
      kind: "group",
      channel: "discord",
      origin,
    });
    await withSessions([selected, linked], async ({ page, gateway }) => {
      await rowFor(page, linked.key).hover();
      const card = page.locator(".session-progress-hovercard");
      const conversation = () => card.locator(".session-hovercard__conversation").textContent();
      await expect.poll(conversation).toContain("Example community #planning");
      const revised = {
        ...linked,
        origin: {
          ...origin,
          label: "Example community #release channel id:123456789012345678",
          threadId: "987654321098765432",
        },
      };
      await gateway.setSessionsListResponse(chatSessionListResponse([selected, revised]));
      await gateway.emitGatewayEvent("sessions.changed", { agentId: "main", reason: "update" });
      await expect.poll(conversation).toContain("Example community #release");
      expect(await conversation()).toContain("Thread");
      expect(await card.textContent()).not.toContain("#planning");
    });
  });

  it("does not call a dashboard session channel-linked just because it has delivery metadata", async () => {
    const origin = whatsappOrigin("direct", "+15555550123");
    const main = sessionRow("agent:main:main", "Main", now, { channel: "whatsapp", origin });
    const dashboard = sessionRow("agent:main:dashboard:example", "Research desk", now - 1, {
      channel: "whatsapp",
      origin,
    });
    await withSessions([main, dashboard], async ({ page }) => {
      const row = rowFor(page, dashboard.key);
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
