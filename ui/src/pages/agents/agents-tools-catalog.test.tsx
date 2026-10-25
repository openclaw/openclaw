/* @vitest-environment jsdom */
import { describe, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import type { ToolsCatalogResult, ToolsEffectiveResult } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { githubIdentityViewFixture } from "../../features/github-connections/github-identity.test-support.ts";
import type { AgentsPanel } from "../../lib/agents/panels.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
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

type Kind = "catalog" | "effective";
type Result = ToolsCatalogResult | ToolsEffectiveResult;
function result(kind: Kind, label: string): Result {
  const group = { id: "core" as const, label: "Built-in tools", source: "core" as const };
  const tool = { id: "read", label, description: "Read", source: "core" as const };
  return kind === "catalog"
    ? {
        agentId: "main",
        profiles: [],
        groups: [{ ...group, tools: [{ ...tool, defaultProfiles: [] }] }],
      }
    : {
        agentId: "main",
        profile: "full",
        groups: [{ ...group, tools: [{ ...tool, rawDescription: "Read" }] }],
      };
}

async function mountTools(kind: Kind, read: () => Promise<Result>, panel: AgentsPanel = "tools") {
  const request = vi.fn(async (method: string) => {
    if (method === "agents.list") {
      return agentsList;
    }
    if (method === "agents.files.list") {
      return { agentId: "main", workspace: "", files: [] };
    }
    if (method === `tools.${kind}`) {
      return read();
    }
    if (method === `tools.${kind === "catalog" ? "effective" : "catalog"}`) {
      return result(kind === "catalog" ? "effective" : "catalog", "Read");
    }
    throw new Error(`Unexpected gateway method: ${method}`);
  });
  const client = createTestGatewayClient(request);
  const currentGateway = gateway(snapshot(client));
  const listeners = new Set<() => void>();
  const modelOverrides: Record<string, string | null> = {};
  const sessions = {
    state: { result: null, modelOverrides },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as unknown as ApplicationContext["sessions"];
  const context = await ownedAgentsContext(currentGateway, { sessions });
  const save = vi.fn(async () => true);
  Object.assign(context.runtimeConfig, { save, state: {} });
  const route = (next: AgentsPanel) => ({
    ...agentsRouteData(
      currentGateway,
      context.agents.state.agentsList,
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
  const query = <T extends Element = HTMLElement>(selector: string): T | null =>
    mounted.container.querySelector<T>(selector);
  return {
    ...mounted,
    query,
    page,
    context,
    client,
    currentGateway,
    request,
    save,
    modelOverrides,
    calls: () => request.mock.calls.filter(([method]) => method === `tools.${kind}`),
    value: () =>
      query(
        kind === "catalog" ? ".agent-tool-title" : ".agent-tools-runtime-chip",
      )?.textContent?.trim(),
    setPanel: (next: AgentsPanel) => page.setRouteData(route(next)),
    publishSessions: () => listeners.forEach((notify) => notify()),
    reconnect() {
      emitGatewaySnapshot(currentGateway, snapshot(client, false));
      emitGatewaySnapshot(currentGateway, snapshot(client));
    },
  };
}
const fallback = "Showing built-in fallback list instead.";
const presets = ".agent-tools-buttons button";

describe("Agents tool reads", () => {
  it.each(["catalog", "effective"] as const)(
    "loads %s on demand, joins pending receipts, and caches panel revisits",
    async (kind) => {
      const pending = deferred<Result>();
      const view = await mountTools(kind, () => pending.promise, "files");
      expect(view.calls()).toHaveLength(0);
      view.setPanel("tools");
      view.context.settingsAgentSelection.set("main");
      view.context.settingsAgentSelection.set("main");
      await waitForSolid(() => expect(view.calls()).toHaveLength(1));
      expect(view.request).toHaveBeenCalledWith(
        `tools.${kind}`,
        kind === "catalog"
          ? { agentId: "main", includePlugins: true }
          : { agentId: "main", sessionKey: "main" },
      );
      await waitForSolid(() => {
        if (kind === "catalog") {
          expect(view.query('.settings-loading-skeleton[aria-busy="true"]')).not.toBeNull();
        } else {
          expect(view.container.textContent).toContain("Loading…");
          expect(view.query(".agent-tool-card")).not.toBeNull();
        }
        expect(view.query<HTMLButtonElement>(presets)?.disabled).toBe(kind === "catalog");
      });
      const identity = view.query("openclaw-github-identity");
      expect(identity).not.toBeNull();
      pending.resolve(result(kind, "Accepted"));
      await waitForSolid(() => expect(view.value()).toContain("Accepted"));
      view.setPanel("files");
      view.setPanel("tools");
      await waitForSolid(() => expect(view.calls()).toHaveLength(1));
      expect(view.query("openclaw-github-identity")).toBe(identity);
    },
  );

  it("keeps catalog fallback editable after rejection and retries both regions", async () => {
    const first = deferred<Result>(),
      second = deferred<Result>();
    const view = await mountTools(
      "catalog",
      vi
        .fn<() => Promise<Result>>()
        .mockReturnValueOnce(first.promise)
        .mockReturnValueOnce(second.promise),
    );
    const identity = view.query("openclaw-github-identity");
    first.reject(new Error("gateway unavailable"));
    await waitForSolid(() => expect(view.container.textContent).toContain(fallback));
    expect(view.query<HTMLButtonElement>(presets)?.disabled).toBe(false);
    expect(view.query(".agent-tool-card")).not.toBeNull();
    view.page.read().agentSkills.onFilterChange("unrelated filter");
    await waitForSolid(() => {
      expect(view.container.textContent).toContain(fallback);
      expect(view.calls()).toHaveLength(1);
    });
    const retry = view.getByRole("button", { name: /^Retry$/ });
    retry.click();
    await waitForSolid(() => {
      expect(view.calls()).toHaveLength(2);
      expect(view.container.textContent).not.toContain(fallback);
      expect(view.query('.settings-loading-skeleton[aria-busy="true"]')).not.toBeNull();
      expect(view.query<HTMLButtonElement>(presets)?.disabled).toBe(true);
    });
    expect(view.query("openclaw-github-identity")).toBe(identity);
    second.resolve(result("catalog", "read"));
    await waitForSolid(() => expect(view.value()).toBe("read"));
    expect(view.container.textContent).not.toContain(fallback);
    expect(view.query("openclaw-github-identity")).toBe(identity);
    view.query<HTMLAnchorElement>('.agent-tools-runtime-chip[href="#agent-tool-read"]')!.click();
    expect(view.query<HTMLDetailsElement>("#agent-tool-read")?.open).toBe(true);
  });

  it("retains an accepted catalog through reconnect", async () => {
    const view = await mountTools("catalog", async () => result("catalog", "Cached"));
    await waitForSolid(() => expect(view.value()).toBe("Cached"));
    view.reconnect();
    view.context.settingsAgentSelection.set("main");
    await waitForSolid(() => {
      expect(view.calls()).toHaveLength(1);
      expect(view.value()).toBe("Cached");
    });
  });

  it.each([
    ["catalog", "replace", "success"],
    ["catalog", "replace", "failure"],
    ["catalog", "reconnect", "success"],
    ["catalog", "reconnect", "failure"],
    ["effective", "replace", "success"],
    ["effective", "replace", "failure"],
    ["effective", "reconnect", "success"],
    ["effective", "reconnect", "failure"],
  ] as const)("retires %s %s %s results", async (kind, change, outcome) => {
    const stale = deferred<Result>();
    const view = await mountTools(
      kind,
      vi
        .fn<() => Promise<Result>>()
        .mockReturnValueOnce(stale.promise)
        .mockResolvedValue(result(kind, "Current")),
    );
    await waitForSolid(() => expect(view.calls()).toHaveLength(1));
    const client = change === "replace" ? createTestGatewayClient(view.request) : view.client;
    if (change === "reconnect") {
      emitGatewaySnapshot(view.currentGateway, snapshot(client, false));
    }
    emitGatewaySnapshot(view.currentGateway, snapshot(client));
    await waitForSolid(() => expect(view.value()).toContain("Current"));
    if (outcome === "success") {
      stale.resolve(result(kind, "Retired"));
    } else {
      stale.reject(new Error("retired failure"));
    }
    await stale.promise.catch(() => {});
    await waitForSolid(() => {
      expect(view.value()).toContain("Current");
      expect(view.container.textContent).not.toContain(
        kind === "catalog" ? fallback : "Unavailable",
      );
    });
    if (kind === "effective") {
      emitGatewaySnapshot(view.currentGateway, snapshot(client, false));
      emitGatewaySnapshot(view.currentGateway, snapshot(client));
      await waitForSolid(() => expect(view.calls()).toHaveLength(3));
    }
  });

  it("retains disclosures, focus and controls through effective refresh, failure and recovery", async () => {
    const next = deferred<Result>(),
      recovered = deferred<Result>();
    const view = await mountTools(
      "effective",
      vi
        .fn<() => Promise<Result>>()
        .mockResolvedValueOnce(result("effective", "Accepted"))
        .mockReturnValueOnce(next.promise)
        .mockReturnValue(recovered.promise),
    );
    await waitForSolid(() => expect(view.value()).toContain("Accepted"));
    const card = view.query<HTMLDetailsElement>("#agent-tool-read")!;
    const group = card.closest<HTMLDetailsElement>(".agent-tools-group")!;
    const toggle = card.querySelector<HTMLInputElement>("input.settings-toggle__input")!;
    const identity = view.query("openclaw-github-identity");
    const preset = view.query<HTMLButtonElement>(presets)!;
    group.open = card.open = true;
    toggle.focus();
    const retained = () => {
      expect(view.query("#agent-tool-read")).toBe(card);
      expect([card.open, group.open, preset.disabled]).toEqual([true, true, false]);
      expect(document.activeElement).toBe(toggle);
      expect(view.query("openclaw-github-identity")).toBe(identity);
      expect(view.query(presets)).toBe(preset);
    };
    view.publishSessions();
    await waitForSolid(() => expect(view.calls()).toHaveLength(2));
    expect(view.container.textContent).toContain("Loading…");
    retained();
    next.reject(new Error("gateway unavailable"));
    await waitForSolid(() => expect(view.container.textContent).toContain("Unavailable"));
    view.page.read().agentSkills.onFilterChange("unrelated filter");
    await waitForSolid(() => {
      expect(view.container.textContent).toContain("Unavailable");
      expect(view.calls()).toHaveLength(2);
    });
    retained();
    expect(view.query(".agent-tools-runtime-chip")).toBeNull();
    view.context.settingsAgentSelection.set("main");
    await waitForSolid(() => expect(view.calls()).toHaveLength(3));
    recovered.resolve(result("effective", "Recovered"));
    await waitForSolid(() => expect(view.value()).toContain("Recovered"));
    expect(view.container.textContent).not.toContain("Unavailable");
    expect(view.query("#agent-tool-read")).toBe(card);
    expect(document.activeElement).toBe(toggle);
  });

  it("refreshes effective tools after saving configuration", async () => {
    const view = await mountTools(
      "effective",
      vi
        .fn<() => Promise<Result>>()
        .mockResolvedValueOnce(result("effective", "Before"))
        .mockResolvedValue(result("effective", "After")),
    );
    await waitForSolid(() => expect(view.value()).toContain("Before"));
    await view.page.read().onConfigSave();
    await waitForSolid(() => expect(view.value()).toContain("After"));
    expect(view.save).toHaveBeenCalledOnce();
  });

  it.each(["session", "model"] as const)(
    "clears accepted hints when the %s changes",
    async (scope) => {
      const next = deferred<Result>();
      const initial = {
        ...result("effective", "Old"),
        notices: [{ id: "old-notice", severity: "info" as const, message: "Old notice" }],
      };
      const view = await mountTools(
        "effective",
        vi.fn<() => Promise<Result>>().mockResolvedValueOnce(initial).mockReturnValue(next.promise),
      );
      await waitForSolid(() => expect(view.value()).toContain("Old"));
      expect(view.container.textContent).toContain("Old notice");
      if (scope === "session") {
        emitGatewaySnapshot(view.currentGateway, {
          ...snapshot(view.client),
          sessionKey: "agent:main:replacement",
        });
        view.setPanel("tools");
      } else {
        view.modelOverrides.main = "openai/gpt-5-mini";
        view.publishSessions();
      }
      await waitForSolid(() => {
        expect(view.calls()).toHaveLength(2);
        expect(view.container.textContent).not.toContain("Old notice");
        expect(view.value()).toBeUndefined();
      });
      expect(view.query("#agent-tool-read")?.textContent).not.toContain("Included in preview");
      next.resolve(result("effective", "New"));
      await waitForSolid(() => expect(view.value()).toContain("New"));
      if (scope === "session") {
        expect(view.request).toHaveBeenLastCalledWith("tools.effective", {
          agentId: "main",
          sessionKey: "agent:main:replacement",
        });
      }
    },
  );
});
