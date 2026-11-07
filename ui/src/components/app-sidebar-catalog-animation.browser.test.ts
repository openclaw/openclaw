import { expect, it } from "vitest";
import type { GatewaySessionRow } from "../api/types.ts";
import {
  mountRoster,
  settleRoster,
} from "../test-helpers/app-sidebar-cases/roster.test-support.ts";
import { setupSidebarTest } from "../test-helpers/app-sidebar-setup.ts";
import { catalogPage } from "../test-helpers/app-sidebar.ts";
import "../test-helpers/load-styles.ts";
import "./app-sidebar.tsx";

setupSidebarTest();

it("keeps a catalog's active animation across unread changes and shows later status transitions", async () => {
  const row: GatewaySessionRow = {
    key: "agent:main:working",
    agentId: "main",
    kind: "direct",
    label: "Running checks",
    updatedAt: 1_800_000_000_000,
    hasActiveRun: true,
    status: "running",
    unread: false,
  };
  const { sidebar, sessions, result } = await mountRoster(undefined, [row]);
  sidebar.style.cssText =
    "display:block;position:fixed;inset:0 auto auto 0;width:320px;height:900px";
  sidebar.sessionData.sessionCatalogs = catalogPage([
    { threadId: "working", name: "Running checks", sessionKey: row.key },
  ]).catalogs;
  sidebar.sessionData.requestSessionDataUpdate();
  await settleRoster(sidebar);
  // The header spinner only summarizes a closed group.
  sidebar.sessionOrganizer.saveCollapsedSessionSections(new Set(["catalog:codex"]));
  await settleRoster(sidebar);
  const header = sidebar.querySelector<HTMLElement>(
    '[data-session-section="catalog:codex"] .sidebar-session-group-toggle',
  )!;
  expect(header).not.toBeNull();
  const spinner = header.querySelector<HTMLElement>(".session-run-spinner")!;
  expect(spinner).not.toBeNull();
  const animation = spinner.getAnimations()[0]!;
  expect(animation).toBeDefined();
  expect(animation.playState).toBe("running");
  // Freeze the browser timeline so a recreated animation deterministically reads zero.
  animation.pause();
  animation.currentTime = 500;

  for (const unread of [true, false, true]) {
    result.sessions = [{ ...row, unread }];
    sessions.publishList({ result });
    await settleRoster(sidebar);
    const current = header.querySelector<HTMLElement>(".session-run-spinner")!;
    expect(current).not.toBeNull();
    expect(current.getAnimations()[0]!.currentTime).toBe(500);
    expect(current).toBe(spinner);
    expect(current.getAnimations()[0]).toBe(animation);
    expect(header.querySelector(".session-unread-dot")).toBeNull();
  }

  result.sessions = [{ ...row, hasActiveRun: false, status: "done", unread: true }];
  sessions.publishList({ result });
  await settleRoster(sidebar);
  expect(header.querySelector(".session-run-spinner")).toBeNull();
  expect(header.querySelector(".session-unread-dot")).not.toBeNull();

  result.sessions = [{ ...row, hasActiveRun: false, status: "done", unread: false }];
  sessions.publishList({ result });
  await settleRoster(sidebar);
  expect(header.querySelector(".session-run-spinner, .session-unread-dot")).toBeNull();

  result.sessions = [row];
  sessions.publishList({ result });
  await settleRoster(sidebar);
  const restarted = header.querySelector<HTMLElement>(".session-run-spinner")!;
  expect(restarted).not.toBeNull();
  expect(restarted).not.toBe(spinner);
  expect(restarted.getAnimations()).toHaveLength(1);
});
