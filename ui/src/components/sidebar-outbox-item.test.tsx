/* @vitest-environment jsdom */
import { flush } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import type { ApplicationContext } from "../app/context.ts";
import { createGatewayHarness, client } from "../app/overlays-access.test-support.ts";
import { disposeSidebarContextLifecycles } from "../test-helpers/app-sidebar-context-lifecycle.ts";
import { createContext, createSessionsHarness } from "../test-helpers/app-sidebar.ts";
import { cleanupSolid, mountSolid } from "../test-helpers/mount-solid.ts";
import type { SidebarInboxEntry } from "./sidebar-attention-entries.ts";
import { renderSidebarOutboxItem } from "./sidebar-outbox-item.tsx";

afterEach(() => {
  cleanupSolid();
  disposeSidebarContextLifecycles();
});

it.each([
  ["reconnecting", false, true, "Your message needs review", "Edited title"],
  ["connected", false, false, "Couldn’t send your message.", "Generated title"],
  ["connected", true, true, "Your message needs review", "Display title"],
  ["connected", true, false, "Couldn’t complete your command.", "Conversation"],
] as const)("reviews %s command=%s held=%s: %s", (phase, command, held, title, conversation) => {
  const request = vi.fn(async () => ({}));
  const harness = createGatewayHarness(client(request));
  harness.update({ phase });
  const entry: Extract<SidebarInboxEntry, { type: "outbox" }> = {
    type: "outbox",
    category: "system",
    id: "pending-1",
    sessionKey: "agent:writer:review",
    agentId: "writer",
    held,
    command,
    severity: held ? "warning" : "error",
    requiresAction: true,
    dismissal: { kind: "outbox", signature: "pending-1" },
  };
  let entries: readonly SidebarInboxEntry[] = [entry];
  const navigate = vi.fn();
  const sessions = createSessionsHarness("writer", [entry.sessionKey]);
  sessions.publish({
    result: {
      ...sessions.result,
      sessions: [
        {
          ...sessions.row(entry.sessionKey),
          label: phase === "reconnecting" ? "Edited title" : undefined,
          displayName: held ? "Display title" : entry.sessionKey,
          derivedTitle: command && !held ? undefined : "Generated title",
        },
      ],
    },
  });
  const context = {
    ...createContext(harness.gateway, sessions.sessions),
    basePath: "/team",
    navigate,
    sidebarAttention: {
      hasFailedAutomation: false,
      get entries() {
        return entries;
      },
      activate() {
        throw new Error("not used by renderer");
      },
      refreshOpenClawId: vi.fn(),
      dismiss: vi.fn(),
      subscribe: () => () => {},
      dispose() {},
    },
  } satisfies ApplicationContext;
  const { container } = mountSolid(() =>
    renderSidebarOutboxItem({ entry, onNavigate: navigate }, context),
  );
  flush();
  const link = container.querySelector<HTMLAnchorElement>("a")!;
  expect(link.textContent).toBe("Review");
  expect(link.getAttribute("aria-label")).toBe("Review in chat");
  expect(link.getAttribute("href")).toBe("/team/chat/writer/review");
  const tooltip = container.querySelector<HTMLElement & { content: string }>("openclaw-tooltip");
  expect(container.querySelector(".sidebar-issues-panel__entity")?.textContent).toBe(title);
  expect(container.querySelector(".sidebar-issues-panel__state")?.textContent).toBe(conversation);
  expect(tooltip?.content).toContain("review it");
  expect(container.querySelector("p, .sidebar-issues-panel__actions, button")).toBeNull();
  expect(container.querySelector(".sidebar-outbox-row__offline")?.textContent ?? null).toBe(
    phase === "reconnecting" ? "· Disconnected" : null,
  );
  link.click();
  expect(navigate).toHaveBeenCalledExactlyOnceWith("chat", {
    pathname: "/team/chat/writer/review",
    search: "?__openclawComposerFocus=1",
  });
  expect(request).not.toHaveBeenCalled();
  expect(context.sidebarAttention.dismiss).toHaveBeenCalledExactlyOnceWith(entry.dismissal);
  expect(entries).toEqual([entry]);
  entries = [];
  link.click();
  expect(navigate).toHaveBeenCalledOnce();
  entries = [entry];
  harness.gateway.connectionRevision += 1;
  link.click();
  expect(navigate).toHaveBeenCalledOnce();
});
