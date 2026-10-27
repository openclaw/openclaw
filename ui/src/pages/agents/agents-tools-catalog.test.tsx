/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import type { ToolsCatalogResult } from "../../api/types.ts";
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
import { createBaseParams, createReadToolCatalog } from "./panels-tools-skills.test-support.ts";
import { AgentTools } from "./panels-tools-skills.tsx";

afterEach(cleanupSolid);

async function mountCatalog(
  readCatalog: () => Promise<ToolsCatalogResult>,
  panel: AgentsPanel = "tools",
) {
  const request = vi.fn(async (method: string) => {
    if (method === "agents.list") {
      return {
        ...agentsList,
        agents: [...agentsList.agents, { id: "research", name: "Research" }],
      };
    }
    if (method === "agents.files.list") {
      return { agentId: "main", workspace: "", files: [] };
    }
    if (method === "tools.catalog") {
      return readCatalog();
    }
    if (method === "tools.effective") {
      return { profile: "full", groups: createReadToolCatalog().groups };
    }
    throw new Error(`Unexpected gateway method: ${method}`);
  });
  const client = createTestGatewayClient(request);
  const currentGateway = gateway(snapshot(client));
  const context = await ownedAgentsContext(currentGateway);
  const route = (nextPanel: AgentsPanel) => ({
    ...agentsRouteData(
      currentGateway,
      context.agents.state.agentsList,
      context.settingsAgentSelection.state.selectedId,
      context.settingsAgentSelection,
    ),
    panel: nextPanel,
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
    client,
    currentGateway,
    request,
    preview: () =>
      mounted.container.querySelector(".agent-tools-group__preview .mono")?.textContent?.trim(),
    setPanel(nextPanel: AgentsPanel) {
      page.setRouteData(route(nextPanel));
    },
    catalogCalls: () => request.mock.calls.filter(([method]) => method === "tools.catalog"),
  };
}

describe("Agents tools catalog read", () => {
  it("admits one request per scope, keeps fallback editable on rejection, and retries both regions", async () => {
    const first = deferred<ToolsCatalogResult>();
    const second = deferred<ToolsCatalogResult>();
    const read = vi
      .fn<() => Promise<ToolsCatalogResult>>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const view = await mountCatalog(read, "files");
    expect(view.catalogCalls()).toHaveLength(0);

    view.setPanel("tools");
    view.context.settingsAgentSelection.set("main");
    view.context.settingsAgentSelection.set("main");
    emitGatewaySnapshot(view.currentGateway, snapshot(view.client));
    await waitForSolid(() => expect(view.catalogCalls()).toHaveLength(1));
    expect(view.request).toHaveBeenCalledWith("tools.catalog", {
      agentId: "main",
      includePlugins: true,
    });
    expect(
      view.container.querySelector('.settings-loading-skeleton[aria-busy="true"]'),
    ).not.toBeNull();
    expect(
      view.container.querySelector<HTMLButtonElement>(".agent-tools-buttons button")?.disabled,
    ).toBe(true);
    const identityHost = view.container.querySelector("openclaw-github-identity");
    expect(identityHost).not.toBeNull();

    first.reject(new Error("gateway unavailable"));
    await waitForSolid(() =>
      expect(view.container.textContent).toContain(
        "Could not load runtime tool catalog. Showing built-in fallback list instead.",
      ),
    );
    expect(
      view.container.querySelector<HTMLButtonElement>(".agent-tools-buttons button")?.disabled,
    ).toBe(false);
    expect(view.container.querySelector(".agent-tools-group")).not.toBeNull();
    expect(view.container.querySelector("openclaw-github-identity")).toBe(identityHost);

    view.page.read().agentSkills.onFilterChange("unrelated filter");
    await waitForSolid(() => expect(view.page.read().agentSkills.filter).toBe("unrelated filter"));
    await waitForSolid(() => {
      expect(view.container.textContent).toContain("Showing built-in fallback list instead.");
      expect(
        Array.from(view.container.querySelectorAll("button")).some(
          (button) => button.textContent?.trim() === "Retry",
        ),
      ).toBe(true);
      expect(view.catalogCalls()).toHaveLength(1);
    });

    const retry = Array.from(view.container.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.textContent?.trim() === "Retry",
    );
    expect(retry).toBeDefined();
    retry!.click();
    await waitForSolid(() => {
      expect(view.catalogCalls()).toHaveLength(2);
      expect(view.container.textContent).not.toContain("Showing built-in fallback list instead.");
      expect(
        view.container.querySelector('.settings-loading-skeleton[aria-busy="true"]'),
      ).not.toBeNull();
      expect(
        view.container.querySelector<HTMLButtonElement>(".agent-tools-buttons button")?.disabled,
      ).toBe(true);
    });
    expect(view.container.querySelector("openclaw-github-identity")).toBe(identityHost);
    second.resolve(createReadToolCatalog("main", "read"));
    await waitForSolid(() => {
      expect(view.container.textContent).not.toContain("Showing built-in fallback list instead.");
      expect(view.preview()).toBe("read");
    });
    expect(view.container.querySelector("openclaw-github-identity")).toBe(identityHost);
    const previewLink = view.container.querySelector<HTMLAnchorElement>(
      '.agent-tools-runtime-chip[href="#agent-tool-read"]',
    );
    expect(previewLink).not.toBeNull();
    previewLink!.click();
    await waitForSolid(() =>
      expect(view.container.querySelector<HTMLDetailsElement>("#agent-tool-read")?.open).toBe(true),
    );

    view.setPanel("files");
    view.setPanel("tools");
    await waitForSolid(() => expect(view.catalogCalls()).toHaveLength(2));
  });

  it("retains a successful catalog across a same-client reconnect", async () => {
    const read = vi.fn(async () => createReadToolCatalog("main", "cached-tool"));
    const view = await mountCatalog(read);
    await waitForSolid(() => expect(view.preview()).toBe("cached-tool"));

    emitGatewaySnapshot(view.currentGateway, snapshot(view.client, false));
    emitGatewaySnapshot(view.currentGateway, snapshot(view.client));
    view.context.settingsAgentSelection.set("main");
    await waitForSolid(() => {
      expect(view.catalogCalls()).toHaveLength(1);
      expect(view.preview()).toBe("cached-tool");
    });
  });

  it("retries a rejected read on the next same-agent owner receipt", async () => {
    const first = deferred<ToolsCatalogResult>();
    const second = deferred<ToolsCatalogResult>();
    const read = vi
      .fn<() => Promise<ToolsCatalogResult>>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const view = await mountCatalog(read);
    await waitForSolid(() => expect(view.catalogCalls()).toHaveLength(1));
    first.reject(new Error("temporarily unavailable"));
    await waitForSolid(() =>
      expect(view.container.textContent).toContain("Showing built-in fallback list instead."),
    );

    view.context.settingsAgentSelection.set("main");
    await waitForSolid(() => expect(view.catalogCalls()).toHaveLength(2));
    second.resolve(createReadToolCatalog("main", "recovered-tool"));
    await waitForSolid(() => {
      expect(view.preview()).toBe("recovered-tool");
      expect(view.container.textContent).not.toContain("Showing built-in fallback list instead.");
    });
  });

  it.each([
    { change: "client replacement", outcome: "success" },
    { change: "client replacement", outcome: "failure" },
    { change: "same-client reconnect", outcome: "success" },
    { change: "same-client reconnect", outcome: "failure" },
  ])("ignores stale $outcome after $change", async ({ change, outcome }) => {
    const old = deferred<ToolsCatalogResult>();
    const current = deferred<ToolsCatalogResult>();
    const read = vi
      .fn<() => Promise<ToolsCatalogResult>>()
      .mockReturnValueOnce(old.promise)
      .mockReturnValue(current.promise);
    const view = await mountCatalog(read);
    await waitForSolid(() => expect(view.catalogCalls()).toHaveLength(1));

    if (change === "client replacement") {
      emitGatewaySnapshot(view.currentGateway, snapshot(createTestGatewayClient(view.request)));
    } else {
      emitGatewaySnapshot(view.currentGateway, snapshot(view.client, false));
      emitGatewaySnapshot(view.currentGateway, snapshot(view.client));
    }
    await waitForSolid(() => expect(view.catalogCalls()).toHaveLength(2));
    current.resolve(createReadToolCatalog("main", "current-tool"));
    await waitForSolid(() => expect(view.preview()).toBe("current-tool"));
    if (outcome === "success") {
      old.resolve(createReadToolCatalog("main", "stale-tool"));
    } else {
      old.reject(new Error("retired request failed"));
    }
    await old.promise.catch(() => {});
    await waitForSolid(() => {
      expect(view.preview()).toBe("current-tool");
      expect(view.container.textContent).not.toContain("stale-tool");
      expect(view.container.textContent).not.toContain("Showing built-in fallback list instead.");
    });
  });
});
