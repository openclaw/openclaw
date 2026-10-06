import { describe, expect, it } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import "../../components/app-sidebar.ts";
import { createGateway, createSessions, mountSidebar } from "../app-sidebar.ts";

describe("AppSidebar outbox attention badges", () => {
  it("shows active and inactive draft pencils while suppressing Incognito roster rows", async () => {
    const draftKey = "agent:main:draft-thread";
    const activeDraftKey = "agent:main:active-draft-thread";
    const plainKey = "agent:main:plain-thread";
    const incognitoKey = "agent:main:private-thread";
    const gateway = createGateway({} as GatewayBrowserClient);
    const sessions = createSessions("main", [draftKey, activeDraftKey, plainKey, incognitoKey]);
    sessions.state.result!.sessions.find((row) => row.key === incognitoKey)!.incognito = true;
    const { sidebar } = await mountSidebar(gateway, sessions);
    sidebar.activeRouteId = "chat";
    sidebar.sessionKey = activeDraftKey;
    sidebar.storedOutboxes = {
      total: 0,
      attentionCountForSession: () => 0,
      hasSessionDraft: (sessionKey) => sessionKey !== plainKey,
    };
    await sidebar.updateComplete;

    const draftBadge = sidebar.querySelector<HTMLElement>(
      `[data-session-key="${draftKey}"] .session-row-badge--draft`,
    );
    expect(draftBadge?.getAttribute("aria-label")).toBe("Unsent draft");
    expect(
      sidebar.querySelector(`[data-session-key="${activeDraftKey}"] .session-row-badge--draft`),
    ).not.toBeNull();
    expect(
      sidebar.querySelector(`[data-session-key="${plainKey}"] .session-row-badge--draft`),
    ).toBeNull();
    const incognitoRow = sidebar.querySelector(`[data-session-key="${incognitoKey}"]`);
    expect(incognitoRow).not.toBeNull();
    expect(incognitoRow?.querySelector(".session-row-badge--draft")).toBeNull();
  });

  it("shows delivery attention and removes the badge when empty", async () => {
    const sessionKey = "agent:main:attention-thread";
    const gateway = createGateway({} as GatewayBrowserClient);
    const { sidebar } = await mountSidebar(gateway, createSessions("main", [sessionKey]));
    sidebar.connected = true;
    sidebar.storedOutboxes = {
      total: 3,
      attentionCountForSession: (rowSessionKey) => (rowSessionKey === sessionKey ? 3 : 0),
      hasSessionDraft: () => false,
    };
    await sidebar.updateComplete;

    const badge = sidebar.querySelector<HTMLElement>(
      `[data-session-key="${sessionKey}"] .session-row-badge--attention`,
    );
    expect(badge?.textContent).toContain("3");
    expect(badge?.getAttribute("aria-label")).toBe("3 messages need attention");

    sidebar.storedOutboxes = undefined;
    await sidebar.updateComplete;
    expect(
      sidebar.querySelector(`[data-session-key="${sessionKey}"] .session-row-badge--attention`),
    ).toBeNull();
  });

  it("resolves agent-main aliases to one attention badge count", async () => {
    const gateway = createGateway({} as GatewayBrowserClient);
    const { sidebar } = await mountSidebar(
      gateway,
      createSessions("main", ["agent:main:main"]),
      "panel",
      {
        defaultId: "main",
        mainKey: "main",
        scope: "per-sender",
        agents: [{ id: "main" }],
      },
    );
    sidebar.storedOutboxes = {
      total: 3,
      attentionCountForSession: () => 3,
      hasSessionDraft: () => true,
    };
    await sidebar.updateComplete;

    const badges = sidebar.querySelectorAll(".nav-item--home .session-row-badge--attention");
    expect(badges).toHaveLength(1);
    expect(badges[0]?.textContent).toContain("3");
    expect(
      sidebar.querySelector('.nav-item--home .session-row-badge--draft[aria-label="Unsent draft"]'),
    ).not.toBeNull();
  });
});
