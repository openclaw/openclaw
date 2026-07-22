import { describe, expect, it } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import "../../components/app-sidebar.ts";
import { storedChatOutboxScopeKey } from "../../pages/chat/composer-persistence.ts";
import { createGateway, createSessions, mountSidebar } from "../app-sidebar.ts";

describe("AppSidebar outbox badges", () => {
  it("shows connected session outbox counts and removes the badge when empty", async () => {
    const sessionKey = "agent:main:queued-thread";
    const gateway = createGateway({} as GatewayBrowserClient);
    const { sidebar } = await mountSidebar(gateway, createSessions("main", [sessionKey]));
    sidebar.connected = true;
    sidebar.outboxCountsByScope = new Map([
      [storedChatOutboxScopeKey({ sessionKey, agentId: "main" }), 3],
    ]);
    await sidebar.updateComplete;

    const badge = sidebar.querySelector<HTMLElement>(
      `[data-session-key="${sessionKey}"] .session-row-badge--queued`,
    );
    expect(badge?.textContent).toContain("3");
    expect(badge?.getAttribute("aria-label")).toBe("3 messages queued to send");

    sidebar.outboxCountsByScope = new Map();
    await sidebar.updateComplete;
    expect(
      sidebar.querySelector(`[data-session-key="${sessionKey}"] .session-row-badge--queued`),
    ).toBeNull();
  });

  it("resolves agent-main aliases to one queued badge count", async () => {
    const gateway = createGateway({} as GatewayBrowserClient);
    const { sidebar } = await mountSidebar(
      gateway,
      createSessions("main", ["agent:main:main"]),
      "panel",
      {
        defaultId: "main",
        mainKey: "main",
        scope: "agent",
        agents: [{ id: "main" }],
      },
    );
    sidebar.outboxCountsByScope = new Map([
      [storedChatOutboxScopeKey({ sessionKey: "global", agentId: "main" }), 3],
      [storedChatOutboxScopeKey({ sessionKey: "main" }), 3],
    ]);
    await sidebar.updateComplete;

    const badges = sidebar.querySelectorAll(".nav-item--home .session-row-badge--queued");
    expect(badges).toHaveLength(1);
    expect(badges[0]?.textContent).toContain("3");
  });
});
