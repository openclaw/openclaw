/* @vitest-environment jsdom */
import { flush } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { createGatewayHarness, client } from "../app/overlays-access.test-support.ts";
import { disposeSidebarContextLifecycles } from "../test-helpers/app-sidebar-context-lifecycle.ts";
import { createContext, createSessions } from "../test-helpers/app-sidebar.ts";
import { cleanupSolid, mountSolid } from "../test-helpers/mount-solid.ts";
import type { SidebarInboxEntry } from "./sidebar-attention-entries.ts";
import { renderSidebarOutboxItem } from "./sidebar-outbox-item.tsx";

afterEach(() => {
  cleanupSolid();
  disposeSidebarContextLifecycles();
});

it.each([
  ["reconnecting", false, true, "Your message may not have arrived"],
  ["connected", false, false, "Your message wasn’t sent"],
  ["connected", true, true, "Your command may not have run"],
  ["connected", true, false, "Your command failed"],
] as const)("reviews %s command=%s unconfirmed=%s: %s", (phase, command, unconfirmed, title) => {
  const request = vi.fn(async () => ({}));
  const harness = createGatewayHarness(client(request));
  harness.update({ phase });
  const entry: Extract<SidebarInboxEntry, { type: "outbox" }> = {
    type: "outbox",
    category: "system",
    id: "pending-1",
    sessionKey: "agent:writer:review",
    agentId: "writer",
    unconfirmed,
    command,
    severity: unconfirmed ? "warning" : "error",
    requiresAction: true,
    dismissal: { kind: "outbox", signature: "pending-1" },
  };
  let entries: readonly SidebarInboxEntry[] = [entry];
  const navigate = vi.fn();
  const context = {
    ...createContext(harness.gateway, createSessions("writer", [entry.sessionKey])),
    basePath: "/team",
    navigate,
    sidebarAttention: {
      get entries() {
        return entries;
      },
      activate() {
        throw new Error("not used by renderer");
      },
      dismiss: vi.fn(),
      subscribe: () => () => {},
      dispose() {},
    },
  };
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
  expect(tooltip?.content).toContain(
    unconfirmed ? (command ? "may already have run" : "check whether it arrived") : "review it",
  );
  expect(container.querySelector("p, .sidebar-issues-panel__actions, button")).toBeNull();
  expect(container.querySelector(".sidebar-outbox-row__offline")?.textContent ?? null).toBe(
    phase === "reconnecting" ? "· Offline" : null,
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
