/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import type { ToolsEffectiveResult } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { githubIdentityViewFixture } from "../../features/github-connections/github-identity.test-support.ts";
import type { AgentsPanel } from "../../lib/agents/panels.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { cleanupSolid, mountSolid } from "../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import {
  agentsList,
  agentsRouteData,
  createAgentsPage,
  emitGatewaySnapshot,
  gateway,
  ownedAgentsContext,
  snapshot,
} from "./agents-page.test-support.ts";
import { createBaseParams } from "./panels-tools-skills.test-support.ts";
import { AgentTools } from "./panels-tools-skills.tsx";

afterEach(cleanupSolid);

function effective(label: string): ToolsEffectiveResult {
  return {
    agentId: "main",
    profile: "full",
    groups: [
      {
        id: "core",
        label: "Built-in tools",
        source: "core",
        tools: [{ id: "read", label, description: "Read", rawDescription: "Read", source: "core" }],
      },
    ],
  };
}

async function mountEffective(
  read: () => Promise<ToolsEffectiveResult>,
  panel: AgentsPanel = "tools",
) {
  const request = vi.fn(async (method: string) => {
    if (method === "agents.list") {
      return agentsList;
    }
    if (method === "agents.files.list") {
      return { agentId: "main", workspace: "", files: [] };
    }
    if (method === "tools.effective") {
      return read();
    }
    if (method === "tools.catalog") {
      return {
        agentId: "main",
        profiles: [],
        groups: [
          {
            id: "core",
            label: "Built-in tools",
            source: "core",
            tools: [{ id: "read", label: "Read", description: "Read", source: "core" }],
          },
        ],
      };
    }
    throw new Error(`Unexpected gateway method: ${method}`);
  });
  const client = createTestGatewayClient(request);
  const currentGateway = gateway(snapshot(client));
  const listeners = new Set<() => void>();
  const modelOverrides: Record<string, string | null> = {};
  // SAFETY: This fixture supplies the session state and subscription consumed by the Agents page.
  const sessions = {
    state: { result: null, modelOverrides },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  } as unknown as ApplicationContext["sessions"];
  const context = await ownedAgentsContext(currentGateway, { sessions });
  const agents = context.agents;
  const save = vi.fn(async () => true);
  Object.assign(context.runtimeConfig, { save, state: {} });
  const route = (next: AgentsPanel) => ({
    ...agentsRouteData(
      currentGateway,
      agents.state.agentsList,
      context.settingsAgentSelection.state.selectedId,
      context.settingsAgentSelection,
    ),
    panel: next,
  });
  const page = createAgentsPage(context, route(panel));
  const identity = githubIdentityViewFixture();
  const mounted = mountSolid(() => (
    <AgentTools
      {...createBaseParams()}
      {...page.read().tools}
      githubIdentity={identity}
      readData={page.read().readData}
      agentId={page.read().selectedAgentId ?? "main"}
    />
  ));
  return {
    ...mounted,
    page,
    context,
    modelOverrides,
    request,
    save,
    client,
    currentGateway,
    calls: () => request.mock.calls.filter(([method]) => method === "tools.effective"),
    setPanel(next: AgentsPanel) {
      page.setRouteData(route(next));
    },
    publishSessions() {
      for (const notify of listeners) {
        notify();
      }
    },
  };
}

const preview = (container: HTMLElement) =>
  container.querySelector(".agent-tools-runtime-chip")?.textContent;

describe("Agents effective-tools read", () => {
  it("loads only on demand, joins pending receipts, and retains the accepted result across panel visits", async () => {
    const pending = deferred<ToolsEffectiveResult>();
    const view = await mountEffective(() => pending.promise, "files");
    expect(view.calls()).toHaveLength(0);
    view.setPanel("tools");
    view.context.settingsAgentSelection.set("main");
    view.context.settingsAgentSelection.set("main");
    await waitForSolid(() => expect(view.calls()).toHaveLength(1));
    expect(view.request).toHaveBeenCalledWith("tools.effective", {
      agentId: "main",
      sessionKey: "main",
    });
    expect(view.container.textContent).toContain("Loading…");
    await waitForSolid(() =>
      expect(view.container.querySelector(".agent-tool-card")).not.toBeNull(),
    );
    expect(
      view.container.querySelector<HTMLButtonElement>(".agent-tools-buttons button")?.disabled,
    ).toBe(false);
    const github = view.container.querySelector("openclaw-github-identity");
    pending.resolve(effective("Accepted preview"));
    await waitForSolid(() => expect(preview(view.container)).toContain("Accepted preview"));
    view.setPanel("files");
    view.setPanel("tools");
    await waitForSolid(() => expect(view.calls()).toHaveLength(1));
    expect(view.container.querySelector("openclaw-github-identity")).toBe(github);
  });

  it("keeps catalog disclosures and focus through refresh, failure, and recovery", async () => {
    const next = deferred<ToolsEffectiveResult>();
    const recovered = deferred<ToolsEffectiveResult>();
    const read = vi
      .fn<() => Promise<ToolsEffectiveResult>>()
      .mockResolvedValueOnce(effective("Accepted preview"))
      .mockReturnValueOnce(next.promise)
      .mockReturnValue(recovered.promise);
    const view = await mountEffective(read);
    await waitForSolid(() => expect(preview(view.container)).toContain("Accepted preview"));
    const github = view.container.querySelector("openclaw-github-identity");
    const preset = view.container.querySelector<HTMLButtonElement>(".agent-tools-buttons button")!;
    const card = view.container.querySelector<HTMLDetailsElement>("#agent-tool-read")!;
    const group = card.closest<HTMLDetailsElement>(".agent-tools-group")!;
    const toggle = card.querySelector<HTMLInputElement>("input.settings-toggle__input")!;
    group.open = true;
    card.open = true;
    toggle.focus();
    view.publishSessions();
    await waitForSolid(() => expect(view.calls()).toHaveLength(2));
    expect(view.container.textContent).toContain("Loading…");
    expect(view.container.querySelector("#agent-tool-read")).toBe(card);
    expect(card.open).toBe(true);
    expect(group.open).toBe(true);
    expect(document.activeElement).toBe(toggle);
    expect(view.container.querySelector("openclaw-github-identity")).toBe(github);
    expect(view.container.querySelector(".agent-tools-buttons button")).toBe(preset);
    expect(preset.disabled).toBe(false);
    next.reject(new Error("gateway unavailable"));
    await waitForSolid(() => expect(view.container.textContent).toContain("Unavailable"));
    view.page.read().agentSkills.onFilterChange("unrelated filter");
    await waitForSolid(() => {
      expect(view.container.textContent).toContain("Unavailable");
      expect(view.calls()).toHaveLength(2);
    });
    expect(view.container.querySelector("#agent-tool-read")).toBe(card);
    expect(card.open).toBe(true);
    expect(group.open).toBe(true);
    expect(document.activeElement).toBe(toggle);
    expect(view.container.querySelector("openclaw-github-identity")).toBe(github);
    expect(view.container.querySelector(".agent-tools-buttons button")).toBe(preset);
    expect(preset.disabled).toBe(false);
    expect(view.container.querySelector(".agent-tools-runtime-chip")).toBeNull();
    view.context.settingsAgentSelection.set("main");
    await waitForSolid(() => expect(view.calls()).toHaveLength(3));
    recovered.resolve(effective("Recovered preview"));
    await waitForSolid(() => expect(preview(view.container)).toContain("Recovered preview"));
    expect(view.container.textContent).not.toContain("Unavailable");
    expect(view.container.querySelector("#agent-tool-read")).toBe(card);
    expect(document.activeElement).toBe(toggle);
  });

  it.each([
    { change: "reconnect", outcome: "success" },
    { change: "reconnect", outcome: "failure" },
    { change: "client replacement", outcome: "success" },
    { change: "client replacement", outcome: "failure" },
  ])(
    "ignores retired $outcome across $change and refreshes accepted data",
    async ({ change, outcome }) => {
      const stale = deferred<ToolsEffectiveResult>();
      const read = vi
        .fn<() => Promise<ToolsEffectiveResult>>()
        .mockReturnValueOnce(stale.promise)
        .mockResolvedValue(effective("Current connection"));
      const view = await mountEffective(read);
      await waitForSolid(() => expect(view.calls()).toHaveLength(1));
      const currentClient =
        change === "client replacement" ? createTestGatewayClient(view.request) : view.client;
      if (change === "reconnect") {
        emitGatewaySnapshot(view.currentGateway, snapshot(view.client, false));
      }
      emitGatewaySnapshot(view.currentGateway, snapshot(currentClient));
      await waitForSolid(() => expect(preview(view.container)).toContain("Current connection"));
      if (outcome === "success") {
        stale.resolve(effective("Retired connection"));
      } else {
        stale.reject(new Error("retired failure"));
      }
      await stale.promise.catch(() => {});
      await waitForSolid(() => {
        expect(preview(view.container)).toContain("Current connection");
        expect(view.container.textContent).not.toContain("Unavailable");
      });
      emitGatewaySnapshot(view.currentGateway, snapshot(currentClient, false));
      emitGatewaySnapshot(view.currentGateway, snapshot(currentClient));
      await waitForSolid(() => expect(view.calls()).toHaveLength(3));
    },
  );

  it("refreshes after saving tool settings and sends the current session after navigation", async () => {
    const read = vi
      .fn<() => Promise<ToolsEffectiveResult>>()
      .mockResolvedValueOnce(effective("Before save"))
      .mockResolvedValue(effective("After save"));
    const view = await mountEffective(read);
    await waitForSolid(() => expect(preview(view.container)).toContain("Before save"));
    await view.page.read().onConfigSave();
    await waitForSolid(() => expect(preview(view.container)).toContain("After save"));
    expect(view.save).toHaveBeenCalledOnce();
    expect(view.calls()).toHaveLength(2);
    emitGatewaySnapshot(view.currentGateway, {
      ...snapshot(view.client),
      sessionKey: "agent:main:next",
    });
    view.setPanel("tools");
    await waitForSolid(() => expect(view.calls()).toHaveLength(3));
    expect(view.request).toHaveBeenLastCalledWith("tools.effective", {
      agentId: "main",
      sessionKey: "agent:main:next",
    });
  });

  it("clears accepted effective hints when the session scope changes", async () => {
    const next = deferred<ToolsEffectiveResult>();
    const old = {
      ...effective("Old session preview"),
      notices: [{ id: "old-notice", severity: "info" as const, message: "Old session notice" }],
    };
    const read = vi
      .fn<() => Promise<ToolsEffectiveResult>>()
      .mockResolvedValueOnce(old)
      .mockReturnValue(next.promise);
    const view = await mountEffective(read);
    await waitForSolid(() => expect(preview(view.container)).toContain("Old session preview"));
    expect(view.container.textContent).toContain("Old session notice");
    emitGatewaySnapshot(view.currentGateway, {
      ...snapshot(view.client),
      sessionKey: "agent:main:replacement",
    });
    view.setPanel("tools");
    await waitForSolid(() => expect(view.calls()).toHaveLength(2));
    await waitForSolid(() =>
      expect(view.container.textContent).not.toContain("Old session notice"),
    );
    expect(preview(view.container)).toBeUndefined();
    expect(view.container.querySelector("#agent-tool-read")?.textContent).not.toContain(
      "Included in preview",
    );
    next.resolve(effective("New session preview"));
    await waitForSolid(() => expect(preview(view.container)).toContain("New session preview"));
    expect(view.request).toHaveBeenLastCalledWith("tools.effective", {
      agentId: "main",
      sessionKey: "agent:main:replacement",
    });
  });

  it("clears accepted effective hints when an owner model override changes", async () => {
    const next = deferred<ToolsEffectiveResult>();
    const read = vi
      .fn<() => Promise<ToolsEffectiveResult>>()
      .mockResolvedValueOnce(effective("Initial model preview"))
      .mockReturnValue(next.promise);
    const view = await mountEffective(read);
    await waitForSolid(() => expect(preview(view.container)).toContain("Initial model preview"));
    view.modelOverrides.main = "openai/gpt-5-mini";
    view.publishSessions();
    await waitForSolid(() => expect(view.calls()).toHaveLength(2));
    await waitForSolid(() => expect(preview(view.container)).toBeUndefined());
    expect(view.container.querySelector("#agent-tool-read")?.textContent).not.toContain(
      "Included in preview",
    );
    next.resolve(effective("Current model preview"));
    await waitForSolid(() => expect(preview(view.container)).toContain("Current model preview"));
  });
});
