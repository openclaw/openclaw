/* @vitest-environment jsdom */

import { afterEach, expect, it, vi } from "vitest";
import type { GatewaySessionRow } from "../api/types.ts";
import type { ApplicationContext } from "../app/context.ts";
import { showToast } from "../lib/toast.ts";
import { createTestGatewayClient } from "../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../test-helpers/gateway-methods.ts";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { waitForSolid } from "../test-helpers/solid-settle.ts";
import {
  enhanceMarkdownTables,
  handleMarkdownTableInteraction,
  releaseMarkdownTables,
} from "./markdown-tables.ts";
import { moveSessionFromMenu } from "./session-placement-action.ts";
import { renderSidebarAgentCreateDialogForMenus } from "./sidebar-menus-render.tsx";
import type { SidebarMenusOwner } from "./sidebar-menus-types.ts";
import type { SidebarMenus } from "./sidebar-menus.tsx";

// mock-isolation: Observe feedback without creating document-global toast hosts.
vi.mock("../lib/toast.ts", () => ({ showToast: vi.fn() }));
// mock-isolation: Reject the lazy module before its custom-element registration can run.
vi.mock("./modal-dialog.tsx", () => {
  throw new Error("Dialog module unavailable. Try again.");
});
// mock-isolation: Reject picker loading before its modal or placement reads can run.
vi.mock("./session-placement-move-dialog.tsx", () => {
  throw new Error("Placement picker unavailable. Try again.");
});
// mock-isolation: Reject activation before the agent owner can issue any requests.
vi.mock("../app/create-agent.ts", () => {
  throw new Error("Agent creation module unavailable. Try again.");
});
// mock-isolation: Supply only the user trigger; the real dialog has an independent lazy owner.
vi.mock("./agent-create-dialog.tsx", () => ({
  AgentCreateDialog: (props: { onCreate(identity: { name: string; avatar: null }): void }) => (
    <button onClick={() => props.onCreate({ name: "Scout", avatar: null })}>Create Scout</button>
  ),
}));

afterEach(() => {
  document.body.replaceChildren();
  vi.mocked(showToast).mockClear();
});

it("reports a failed table dialog import and releases the open reservation", async () => {
  const owner = document.createElement("div");
  owner.innerHTML =
    '<div class="chat-text"><div class="markdown-table" data-table-interactions><div class="markdown-table__viewport"><table><tbody><tr><td>Scout</td></tr></tbody></table></div><button class="markdown-table__expand"></button><button class="markdown-table__copy"></button></div></div>';
  document.body.append(owner);
  enhanceMarkdownTables(owner);
  owner.addEventListener("click", handleMarkdownTableInteraction);
  const trigger = owner.querySelector<HTMLButtonElement>(".markdown-table__expand")!;
  trigger.click();
  await waitForSolid(() => expect(showToast).toHaveBeenCalledOnce());
  expect(showToast).toHaveBeenLastCalledWith({
    message:
      "Panel failed to load. Some interface files could not be downloaded. Check your connection, then reload.",
    severity: "error",
  });
  expect(owner.querySelector("openclaw-modal-dialog")).toBeNull();
  trigger.click();
  await waitForSolid(() => expect(showToast).toHaveBeenCalledTimes(2));
  releaseMarkdownTables(owner);
});

it("reports an agent creation import failure after closing the picker", async () => {
  const closeAgentCreateDialog = vi.fn();
  // SAFETY: This renderer only reads the context and close operation supplied here.
  const menus = { closeAgentCreateDialog } as unknown as SidebarMenus;
  const host = { sessionDataContext: {} } as SidebarMenusOwner;
  const view = mountSolid(() => renderSidebarAgentCreateDialogForMenus(menus, host));
  await waitForSolid(() => expect(view.container.querySelector("button")).not.toBeNull());
  view.container.querySelector<HTMLButtonElement>("button")!.click();
  await waitForSolid(() => expect(showToast).toHaveBeenCalledOnce());
  expect(closeAgentCreateDialog).toHaveBeenCalledOnce();
  expect(vi.mocked(showToast).mock.calls[0]?.[0].message).toContain(
    "Agent creation module unavailable. Try again.",
  );
  view.unmount();
});

it("reports a placement picker import failure through the menu's error owner without issuing a move", async () => {
  const request = vi.fn(async () => ({}));
  const client = createTestGatewayClient(request);
  const row: GatewaySessionRow = {
    key: "agent:main:scout",
    sessionId: "scout",
    kind: "direct",
    label: "Scout",
    updatedAt: 1,
    worktree: { id: "scout", branch: "scout", repoRoot: "/synthetic/scout" },
  };
  const publishError = vi.fn();
  const reconcileMutation = vi.fn();
  // SAFETY: The placement entry uses only these owner capabilities before choosing a target.
  const context = {
    gateway: {
      snapshot: {
        phase: "connected",
        client,
        hello: gatewayHelloForMethods(["sessions.move", "sessions.dispatch"]),
      },
      connectionRevision: 1,
    },
    sessions: { reconcileMutation },
    agents: { state: { agentsList: null } },
  } as unknown as ApplicationContext;
  await moveSessionFromMenu({
    context,
    row,
    fallbackAgentId: "main",
    currentRow: () => row,
    isCurrent: () => true,
    publishError,
  });
  expect(publishError).toHaveBeenCalledOnce();
  expect(publishError.mock.calls[0]?.[0]).toMatchObject({
    cause: { message: "Placement picker unavailable. Try again." },
  });
  expect(request).not.toHaveBeenCalled();
  expect(reconcileMutation).not.toHaveBeenCalled();
});
