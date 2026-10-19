import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it, vi } from "vitest";
import type { SessionCatalogSession } from "../../../../packages/gateway-protocol/src/index.ts";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow } from "../../api/types.ts";
import {
  createTestSessionCapability,
  sessionsResult,
} from "../../lib/sessions/session-capability.test-support.ts";
import {
  catalogPage,
  createGateway,
  createGatewayHarness,
  createSessionsHarness,
  mountSidebar,
} from "../app-sidebar.ts";
import { createGatewayRequestMock, createTestGatewayClient } from "../gateway-client.ts";
import { settleLitElement } from "../lit-settle.ts";
import "../../components/app-sidebar.tsx";

const key = "agent:main:adopted";
const seed = { threadId: "native", name: "Native session", sessionKey: key };
type Sidebar = Awaited<ReturnType<typeof mountSidebar>>["sidebar"];

async function publish(sidebar: Sidebar, catalogs: ReturnType<typeof catalogPage>["catalogs"]) {
  sidebar.sessionData.sessionCatalogs = catalogs;
  sidebar.sessionData.requestSessionDataUpdate();
  await settleLitElement(sidebar);
}

async function fixture(
  native: Partial<SessionCatalogSession> = {},
  live: Partial<GatewaySessionRow> = {},
  archive = true,
  terminalAvailable = false,
) {
  const { sessions } = createSessionsHarness("main", ["agent:main:main", key]);
  Object.assign(sessions.state.result!.sessions[1]!, live);
  const { sidebar } = await mountSidebar(createGateway({} as GatewayBrowserClient), sessions);
  sidebar.terminalAvailable = terminalAvailable;
  const catalogs = catalogPage([seed]).catalogs;
  catalogs[0]!.capabilities.archive = archive;
  const nativeRow = catalogs[0]!.hosts[0]!.sessions[0]!;
  Object.assign(nativeRow, native);
  const update = async (patch: Partial<SessionCatalogSession>) => {
    Object.assign(nativeRow, patch);
    await publish(sidebar, structuredClone(catalogs));
  };
  await update({});
  const query: Sidebar["querySelector"] = sidebar.querySelector.bind(sidebar);
  return { sidebar, sessions, query, update };
}

describe("AppSidebar catalog row lifecycle", () => {
  it("keeps an adopted catalog row archived after it leaves the active roster", async () => {
    const row: GatewaySessionRow = { key, sessionId: "adopted-id", kind: "direct", updatedAt: 1 };
    let archived = false;
    const request = createGatewayRequestMock(async (method, params) => {
      if (method === "sessions.list") {
        return sessionsResult(archived ? [] : [row], archived ? 2 : 1);
      }
      if (method === "sessions.patch") {
        expect(params).toMatchObject({ key, expectedSessionId: row.sessionId, archived: true });
        archived = isRecord(params) && params.archived === true;
        return { ok: true, key, entry: { sessionId: row.sessionId, updatedAt: 2, archivedAt: 2 } };
      }
      return {};
    });
    const gateway = createGatewayHarness(createTestGatewayClient(request));
    const sessions = createTestSessionCapability(gateway.gateway);
    await sessions.refresh({ agentId: "main", force: true });
    const { sidebar } = await mountSidebar(gateway.gateway, sessions);
    sidebar.connected = true;
    await publish(sidebar, catalogPage([seed]).catalogs);
    const archive = sidebar.querySelector<HTMLButtonElement>(
      `[data-session-key="${key}"] [data-sidebar-session-archive]`,
    );
    expect(archive?.disabled).toBe(false);
    const operation = vi.spyOn(sidebar.sessionOrganizer, "archiveSessionWithUndo");
    archive!.click();
    await operation.mock.results[0]!.value;
    await sidebar.updateComplete;
    expect(archived).toBe(true);
    expect(sessions.state.result?.sessions).toEqual([]);
    expect(sessions.archiveVisibility(key)).toBe("archived");
    expect(sidebar.querySelector(`[data-session-key="${key}"]`)).toBeNull();
  });

  it.each([
    { label: undefined, expected: "Captured native title" },
    { label: "Operator chosen label", expected: "Operator chosen label" },
  ])(
    "keeps the adopted session name $expected after a native rename",
    async ({ label, expected }) => {
      const { query } = await fixture(
        { name: "Renamed upstream" },
        { label, displayName: "Captured native title", boardFace: "dashboard" },
      );
      const row = query(`[data-session-key="${key}"]`);
      expect(row?.querySelector(".sidebar-recent-session__name")?.textContent).toBe(expected);
      expect(
        row?.querySelector("[data-sidebar-session-archive]")?.getAttribute("aria-label"),
      ).toContain(expected);
      expect(row?.querySelector("a")?.getAttribute("href")).toBe("/dashboard/main/adopted");
    },
  );

  it("uses catalog colors only until the live session owns the row", async () => {
    const { query, update } = await fixture({ sessionKey: undefined, color: "cyan" });
    const row = () => query<HTMLElement>("[data-catalog-session-key]");
    expect(row()?.classList.contains("sidebar-recent-session--colored")).toBe(true);
    expect(row()?.style.getPropertyValue("--session-color")).toBe("var(--session-color-cyan)");
    await update({ sessionKey: key });
    expect(row()?.classList.contains("sidebar-recent-session--colored")).toBe(false);
    expect(row()?.style.getPropertyValue("--session-color")).toBe("");
  });

  it.each(["open", "closed"])(
    "keeps %s menu focus through row adoption and release",
    async (menuState) => {
      const { sidebar, query, update } = await fixture({ sessionKey: undefined });
      const trigger = query<HTMLButtonElement>("[data-catalog-session-menu]")!;
      trigger.focus();
      expect(document.activeElement).toBe(trigger);
      if (menuState === "open") {
        trigger.click();
      }
      await sidebar.updateComplete;
      const originalPopup = query("openclaw-catalog-session-menu");
      await update({ sessionKey: key });
      await Promise.resolve();
      await sidebar.updateComplete;
      const adoptedMenu = query<HTMLAnchorElement>(
        `[data-session-key="${key}"] .sidebar-recent-session__link`,
      );
      const popup = query<HTMLElement & { trigger?: HTMLElement }>("openclaw-catalog-session-menu");
      if (menuState === "open") {
        expect(popup).not.toBeNull();
        expect(popup).toBe(originalPopup);
        expect(popup?.trigger).toBe(adoptedMenu);
        popup?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        await sidebar.updateComplete;
      } else {
        expect(popup).toBeNull();
      }
      expect(document.activeElement).toBe(adoptedMenu);

      if (menuState === "open") {
        adoptedMenu!.dispatchEvent(
          new MouseEvent("contextmenu", {
            bubbles: true,
            cancelable: true,
            clientX: 20,
            clientY: 30,
          }),
        );
        await sidebar.updateComplete;
      }
      const adoptedPopup = query("openclaw-catalog-session-menu");
      await update({ sessionKey: undefined });
      await Promise.resolve();
      await sidebar.updateComplete;
      const releasedLink = query<HTMLAnchorElement>(
        "[data-catalog-session-key] .sidebar-recent-session__link",
      );
      const releasedMenu = query<HTMLButtonElement>("[data-catalog-session-menu]");
      expect(releasedLink).not.toBe(adoptedMenu);
      if (menuState === "open") {
        const releasedPopup = query<HTMLElement & { trigger?: HTMLElement }>(
          "openclaw-catalog-session-menu",
        );
        expect(releasedPopup).toBe(adoptedPopup);
        expect(releasedPopup?.trigger).toBe(releasedMenu);
        releasedPopup?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        await sidebar.updateComplete;
        expect(document.activeElement).toBe(releasedMenu);
      } else {
        expect(query("openclaw-catalog-session-menu")).toBeNull();
        expect(document.activeElement).toBe(releasedLink);
      }
    },
  );

  it.each([
    { catalog: false, session: true, canRemove: false },
    { catalog: true, session: false, canRemove: false },
    { catalog: true, session: true, canRemove: true },
  ])(
    "preserves native menus when catalog archive=$catalog and session archive=$session",
    async ({ catalog, session, canRemove }) => {
      const { sidebar, query } = await fixture(
        { canArchive: session, canOpenTerminal: true },
        {},
        catalog,
        true,
      );
      const row = query<HTMLElement>(`[data-session-key="${key}"]`);
      expect(row).not.toBeNull();
      const eventOptions = { bubbles: true, cancelable: true };
      for (const event of [
        new MouseEvent("contextmenu", { ...eventOptions, clientX: 20, clientY: 30 }),
        new KeyboardEvent("keydown", { ...eventOptions, key: "ContextMenu" }),
        new KeyboardEvent("keydown", { ...eventOptions, key: "F10", shiftKey: true }),
      ]) {
        row!.dispatchEvent(event);
        await sidebar.updateComplete;
        const menu = query("openclaw-catalog-session-menu");
        expect(menu?.querySelector('[data-value="viewer"]')).not.toBeNull();
        const terminal = menu?.querySelector('[data-value="terminal"]');
        expect(terminal?.hasAttribute("disabled")).toBe(false);
        expect(menu?.querySelector('[data-value="delete"]') !== null).toBe(canRemove);
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        await sidebar.updateComplete;
        expect(query("openclaw-catalog-session-menu")).toBeNull();
      }
    },
  );

  it("clears marquee state when a catalog label changes", async () => {
    const { query, update } = await fixture({
      sessionKey: undefined,
      name: "A long catalog session title",
    });
    const selector = "[data-catalog-session-key] .sidebar-recent-session__name";
    const oldLabel = query<HTMLElement>(selector);
    expect(oldLabel?.textContent).toBe("A long catalog session title");
    oldLabel?.classList.add("hover-marquee--scrolling");
    oldLabel?.style.setProperty("--hover-marquee-shift", "-80px");
    await update({ name: "Short" });
    const label = query<HTMLElement>(selector);
    expect(label?.textContent).toBe("Short");
    expect(label?.classList.contains("hover-marquee--scrolling")).toBe(false);
    expect(label?.style.getPropertyValue("--hover-marquee-shift")).toBe("");
  });

  it("clears adopted marquee state when its live pull request appears", async () => {
    const { sidebar, sessions, query } = await fixture();
    const row = query<HTMLElement>(`[data-session-key="${key}"]`);
    const oldLabel = row?.querySelector<HTMLElement>(".hover-marquee");
    oldLabel?.classList.add("hover-marquee--scrolling");
    oldLabel?.style.setProperty("--hover-marquee-shift", "-80px");
    sessions.setPullRequestSummary(key, { numbers: [125820], state: "open" });
    await settleLitElement(sidebar);
    const label = row?.querySelector<HTMLElement>(".hover-marquee");
    expect(label).not.toBe(oldLabel);
    expect(label?.classList.contains("hover-marquee--scrolling")).toBe(false);
    expect(row?.querySelector(".session-row-badge--pull-request")).not.toBeNull();
  });
});
