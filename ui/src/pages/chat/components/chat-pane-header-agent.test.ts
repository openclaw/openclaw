/* @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
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

function fixture() {
  const request = vi.fn(async () => ({}));
  const { pane, state } = createTestChatPane({
    client: createTestGatewayClient(request),
  });
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

describe("agent-first chat header", () => {
  it("keeps workspace actions, parent navigation, and session renaming in secondary context", async () => {
    const { container, props, update } = mountChatPaneHeader(containers, {
      agent: { id: "research", name: "Research lead", textAvatar: "🔬" },
      parentSession: { key: "agent:research:parent", title: "Parent conversation" },
    });
    const trigger = container.querySelector<HTMLButtonElement>(
      ".chat-pane__agent-identity > button",
    )!;
    expect(trigger.getAttribute("aria-label")).toBe("Session and workspace for Research lead");
    expect(container.querySelector(".chat-pane__crumbs")).toBeNull();
    trigger.click();
    await waitForSolid(() =>
      expect(container.querySelector("[role=dialog]")?.matches(":popover-open")).toBe(true),
    );
    const dialog = container.querySelector("[role=dialog]")!;
    expect(dialog.textContent).toContain("Session title");
    expect(dialog.textContent).toContain("openclaw");
    dialog.querySelector<HTMLButtonElement>(".chat-pane__parent-session")!.click();
    expect(props.onOpenParentSession).toHaveBeenCalledWith("agent:research:parent");
    const workspace = dialog.querySelector(".chat-pane__workspace-menu")!;
    await selectNativeMenu(workspace, "copy-path");
    expect(props.onMenuAction).toHaveBeenCalledWith("copy-path");
    await selectNativeMenu(workspace, "reveal");
    expect(props.onMenuAction).toHaveBeenCalledWith("reveal");
    dialog.querySelector<HTMLButtonElement>(".chat-pane__session-title-button")!.click();
    expect(props.onBeginRename).toHaveBeenCalledOnce();
    update({ editing: true, renameValue: "Updated conversation" });
    const input = dialog.querySelector<HTMLInputElement>(".chat-pane__session-title-input")!;
    expect(input.value).toBe("Updated conversation");
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(props.onCommitRename).toHaveBeenCalledOnce();
  });

  it("opens secondary context for overflow-menu rename and retires it on agent changes", async () => {
    const { container, update } = mountChatPaneHeader(containers, {
      agent: { id: "research", name: "Research lead", textAvatar: "🔬" },
    });
    update({ editing: true });
    await waitForSolid(() =>
      expect(container.querySelector("[role=dialog]")?.matches(":popover-open")).toBe(true),
    );
    expect(container.querySelector(".chat-pane__session-title-input")).not.toBeNull();
    update({ editing: false, agent: { id: "main", name: "Chief of Staff", textAvatar: "🦊" } });
    await waitForSolid(() =>
      expect(container.querySelector("[role=dialog]")?.matches(":popover-open")).toBe(false),
    );
    expect(container.querySelector(".chat-pane__crumbs")).toBeNull();
    expect(container.querySelector(".chat-pane__agent-name")?.textContent).toBe("Chief of Staff");
    container.querySelector<HTMLButtonElement>(".chat-pane__agent-identity > button")!.click();
    await waitForSolid(() =>
      expect(container.querySelector("[role=dialog]")?.matches(":popover-open")).toBe(true),
    );
    update({ presented: false });
    await waitForSolid(() =>
      expect(container.querySelector("[role=dialog]")?.matches(":popover-open")).toBe(false),
    );
  });

  it("opens the current agent settings from a separate header control", () => {
    const { container, props } = mountChatPaneHeader(containers, {
      agent: { id: "research", name: "Research lead", textAvatar: "🔬" },
    });
    const settings = container.querySelector<HTMLButtonElement>(".chat-pane__agent-settings")!;
    expect(settings.getAttribute("aria-label")).toBe("Research lead settings");
    settings.click();
    expect(props.onOpenAgentSettings).toHaveBeenCalledWith("research");
    expect(container.querySelector("[role=dialog]")?.matches(":popover-open")).not.toBe(true);
  });

  it("uses the pane agent on direct navigation and retained agent switches, only in roster mode", () => {
    const { state, container, draw, navigate } = fixture();
    state.sessionKey = "agent:research:main";
    state.assistantAgentId = "main";
    state.assistantName = "Stale assistant";
    draw();
    const leading = () => container.querySelector(".chat-pane__header-leading")!;
    const centered = () => container.querySelector(".chat-pane__header-agent");
    expect(centered()?.textContent).toContain("Research lead");
    expect(leading().textContent).not.toContain("What can you do?");
    expect(leading().textContent).not.toContain("workspace-research");
    expect(centered()?.querySelector("[data-avatar]")?.getAttribute("data-avatar")).toBe("🔬");
    container.querySelector<HTMLButtonElement>(".chat-pane__agent-settings")!.click();
    expect(navigate).toHaveBeenCalledWith("agents", {
      pathname: "/settings/agents/research",
    });

    state.sessionKey = "global";
    state.assistantAgentId = "main";
    draw();
    expect(centered()?.textContent).toContain("Chief of Staff");
    expect(centered()?.textContent).not.toContain("Research lead");
    expect(centered()?.querySelector("[data-avatar]")?.getAttribute("data-avatar")).toBe("🦊");

    state.settings = { ...state.settings, sidebarAgentsMode: "chip" };
    draw();
    expect(leading().textContent).toContain("workspace-research");
    expect(leading().textContent).toContain("What can you do?");
    expect(centered()).toBeNull();
    expect(leading().querySelector(".chat-pane__agent-identity")).toBeNull();

    state.settings = { ...state.settings, sidebarAgentsMode: "roster" };
    draw(true);
    expect(centered()).toBeNull();
    expect(leading().querySelector(".chat-pane__agent-identity")).toBeNull();
    expect(leading().querySelector(".chat-pane__session-title")).not.toBeNull();
  });

  it("keeps the requested agent ID while its roster is loading or missing", () => {
    const { pane, state, container, draw } = fixture();
    state.sessionKey = "agent:research:main";
    state.assistantAgentId = "main";
    state.assistantName = "Wrong agent";
    pane.context.agents.state.agentsList = null;
    draw();
    expect(container.querySelector(".chat-pane__agent-identity")?.textContent).toContain(
      "research",
    );
    expect(container.querySelector(".chat-pane__header-leading")?.textContent).not.toContain(
      "Wrong agent",
    );

    pane.context.agents.state.agentsList = {
      defaultId: "main",
      mainKey: "main",
      scope: "per-sender",
      agents: [{ id: "main", name: "Wrong agent" }],
    };
    draw();
    expect(container.querySelector(".chat-pane__agent-identity")?.textContent).toContain(
      "research",
    );
    expect(container.querySelector(".chat-pane__header-leading")?.textContent).not.toContain(
      "Wrong agent",
    );
  });

  it("updates a hydrated avatar and name without restoring a removed image", async () => {
    const { pane, state, container, draw, request } = fixture();
    state.sessionKey = "agent:research:main";
    pane.context.agents.state.agentsList!.agents = [
      { id: "research", identity: { avatarUrl: "/avatar/research?v=1" } },
    ];
    draw();
    const avatar = () => container.querySelector<HTMLImageElement>(".chat-pane__agent-avatar img");
    expect(avatar()?.getAttribute("src")).toBe("/avatar/research?v=1");

    request.mockResolvedValueOnce({
      agentId: "research",
      name: "Research partner",
      avatar: "/avatar/research?v=2",
    });
    await pane.context.agentIdentity.ensure(["research"]);
    draw();
    expect(container.querySelector(".chat-pane__agent-name")?.textContent).toBe("Research partner");
    expect(avatar()?.getAttribute("src")).toBe("/avatar/research?v=2");

    pane.context.agentIdentity.invalidate(["research"]);
    request.mockResolvedValueOnce({ agentId: "research", name: "Research partner" });
    await pane.context.agentIdentity.ensure(["research"]);
    draw();
    expect(avatar()).toBeNull();
    expect(container.querySelector(".chat-pane__agent-name")?.textContent).toBe("Research partner");
  });
});
