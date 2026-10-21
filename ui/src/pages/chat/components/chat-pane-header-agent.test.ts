/* @vitest-environment jsdom */
import { afterEach, expect, it, vi } from "vitest";
import { createTestGatewayClient } from "../../../test-helpers/gateway-client.ts";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { createPaneHeaderWorkspaceFixture, createTestChatPane } from "../chat-pane.test-support.ts";
import {
  mountChatPaneHeader,
  renderPaneHeaderInto,
  selectNativeMenu,
} from "./chat-pane-header.test-support.ts";

const containers: HTMLElement[] = [];
afterEach(() => containers.splice(0).forEach((container) => container.remove()));

function researchHeader(patch: Parameters<typeof mountChatPaneHeader>[1] = {}) {
  return mountChatPaneHeader(containers, {
    agent: { id: "research", name: "Research lead", textAvatar: "🔬" },
    ...patch,
  });
}

const find = (container: Element, selector: string) =>
  container.querySelector<HTMLElement>(`.chat-pane__${selector}`);
const dialogOpen = (container: Element, open: boolean) =>
  waitForSolid(() =>
    expect(container.querySelector("[role=dialog]")?.matches(":popover-open")).toBe(open),
  );

function fixture() {
  const request = vi.fn(async () => ({}));
  const { pane, state } = createTestChatPane({
    client: createTestGatewayClient(request),
  });
  state.sessionKey = "agent:research:main";
  state.assistantAgentId = "main";
  const navigate = vi.fn();
  Object.defineProperty(pane.context, "navigate", { configurable: true, value: navigate });
  state.settings = { ...state.settings, sidebarAgentsMode: "roster" };
  pane.context.agents.state.agentsList = {
    defaultId: "main",
    mainKey: "main",
    scope: "per-sender",
    agents: [
      { id: "main", name: "Chief of Staff", identity: { emoji: "🦊" } },
      { id: "research", name: "Research lead", identity: { emoji: "🔬" } },
    ],
  };
  const container = document.createElement("div");
  document.body.append(container);
  containers.push(container);
  const draw = (catalog = false) => {
    renderPaneHeaderInto(
      pane.renderPaneHeader(
        createPaneHeaderWorkspaceFixture(state),
        { key: state.sessionKey, kind: "direct", updatedAt: 0, label: "What can you do?" },
        catalog,
        "/work/workspace-research",
        false,
        null,
      ),
      container,
    );
  };
  return { pane, state, container, draw, request, navigate };
}

it("keeps workspace actions, parent navigation, and session renaming in secondary context", async () => {
  const { container, props, update } = researchHeader({
    parentSession: { key: "agent:research:parent", title: "Parent conversation" },
  });
  const trigger = find(container, "agent-identity > button")!;
  expect(trigger.getAttribute("aria-label")).toBe("Session and workspace for Research lead");
  expect(find(container, "crumbs")).toBeNull();
  trigger.click();
  await dialogOpen(container, true);
  const dialog = container.querySelector("[role=dialog]")!;
  expect(dialog.textContent).toContain("Session title");
  expect(dialog.textContent).toContain("openclaw");
  find(dialog, "parent-session")!.click();
  expect(props.onOpenParentSession).toHaveBeenCalledWith("agent:research:parent");
  const workspace = find(dialog, "workspace-menu")!;
  await selectNativeMenu(workspace, "copy-path");
  expect(props.onMenuAction).toHaveBeenCalledWith("copy-path");
  await selectNativeMenu(workspace, "reveal");
  expect(props.onMenuAction).toHaveBeenCalledWith("reveal");
  find(dialog, "session-title-button")!.click();
  expect(props.onBeginRename).toHaveBeenCalledOnce();
  update({ editing: true, renameValue: "Updated conversation" });
  const input = dialog.querySelector<HTMLInputElement>(".chat-pane__session-title-input")!;
  expect(input.value).toBe("Updated conversation");
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  expect(props.onCommitRename).toHaveBeenCalledOnce();
});

it("opens secondary context for overflow-menu rename and retires it on agent changes", async () => {
  const { container, update } = researchHeader();
  update({ editing: true });
  await dialogOpen(container, true);
  expect(find(container, "session-title-input")).not.toBeNull();
  update({ editing: false, agent: { id: "main", name: "Chief of Staff", textAvatar: "🦊" } });
  await dialogOpen(container, false);
  expect(find(container, "crumbs")).toBeNull();
  expect(find(container, "agent-name")?.textContent).toBe("Chief of Staff");
  find(container, "agent-identity > button")!.click();
  await dialogOpen(container, true);
  update({ presented: false });
  await dialogOpen(container, false);
});

it("uses the pane agent on direct navigation and retained agent switches, only in roster mode", () => {
  const { state, container, draw, navigate } = fixture();
  state.assistantName = "Stale assistant";
  draw();
  const leading = () => find(container, "header-leading")!;
  const centered = () => find(container, "header-agent");
  expect(centered()?.textContent).toContain("Research lead");
  expect(leading().textContent).not.toContain("What can you do?");
  expect(leading().textContent).not.toContain("workspace-research");
  expect(centered()?.querySelector("[data-avatar]")?.getAttribute("data-avatar")).toBe("🔬");
  const settings = find(container, "agent-settings")!;
  expect(settings.getAttribute("aria-label")).toBe("Research lead settings");
  settings.click();
  expect(navigate).toHaveBeenCalledWith("agents", {
    pathname: "/settings/agents/research",
  });
  expect(container.querySelector("[role=dialog]")?.matches(":popover-open")).not.toBe(true);

  state.sessionKey = "global";
  draw();
  expect(centered()?.textContent).toContain("Chief of Staff");
  expect(centered()?.textContent).not.toContain("Research lead");
  expect(centered()?.querySelector("[data-avatar]")?.getAttribute("data-avatar")).toBe("🦊");

  state.settings = { ...state.settings, sidebarAgentsMode: "chip" };
  draw();
  expect(leading().textContent).toContain("workspace-research");
  expect(leading().textContent).toContain("What can you do?");
  expect(centered()).toBeNull();
  expect(find(leading(), "agent-identity")).toBeNull();

  state.settings = { ...state.settings, sidebarAgentsMode: "roster" };
  draw(true);
  expect(centered()).toBeNull();
  expect(find(leading(), "agent-identity")).toBeNull();
  expect(find(leading(), "session-title")).not.toBeNull();
});

it("keeps the requested agent ID while its roster is loading or missing", () => {
  const { pane, state, container, draw } = fixture();
  state.assistantName = "Wrong agent";
  pane.context.agents.state.agentsList = null;
  draw();
  expect(find(container, "agent-identity")?.textContent).toContain("research");
  expect(find(container, "header-leading")?.textContent).not.toContain("Wrong agent");

  pane.context.agents.state.agentsList = {
    defaultId: "main",
    mainKey: "main",
    scope: "per-sender",
    agents: [{ id: "main", name: "Wrong agent" }],
  };
  draw();
  expect(find(container, "agent-identity")?.textContent).toContain("research");
  expect(find(container, "header-leading")?.textContent).not.toContain("Wrong agent");
});

it("updates a hydrated avatar and name without restoring a removed image", async () => {
  const { pane, container, draw, request } = fixture();
  pane.context.agents.state.agentsList!.agents = [
    { id: "research", identity: { avatarUrl: "/avatar/research?v=1" } },
  ];
  draw();
  const avatar = () => find(container, "agent-avatar img");
  expect(avatar()?.getAttribute("src")).toBe("/avatar/research?v=1");

  request.mockResolvedValueOnce({
    agentId: "research",
    name: "Research partner",
    avatar: "/avatar/research?v=2",
  });
  await pane.context.agentIdentity.ensure(["research"]);
  draw();
  expect(find(container, "agent-name")?.textContent).toBe("Research partner");
  expect(avatar()?.getAttribute("src")).toBe("/avatar/research?v=2");

  pane.context.agentIdentity.invalidate(["research"]);
  request.mockResolvedValueOnce({ agentId: "research", name: "Research partner" });
  await pane.context.agentIdentity.ensure(["research"]);
  draw();
  expect(avatar()).toBeNull();
  expect(find(container, "agent-name")?.textContent).toBe("Research partner");
});
