import type { SkillsLibraryListResult } from "@openclaw/gateway-protocol";
import { createSignal, flush } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { createAgentSelectionCapability } from "../../app/agent-selection.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { ApplicationProvider } from "../../lib/reactive/context.ts";
import { createApplicationGateway } from "../../test-helpers/application-context.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
// @vitest-environment jsdom
import { mountSolid, cleanupSolid } from "../../test-helpers/mount-solid.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { SkillsPage, type SkillsRouteData } from "./skills-page.tsx";
import { createSkill } from "./view.test-support.ts";

const personalLibrary = {
  entries: [],
  profileId: "alice",
  multipleProfiles: true,
  defaultTarget: "personal",
  canManageWorkspace: true,
  defaultSelectionLimit: 64,
} satisfies SkillsLibraryListResult;

const remoteSkill = {
  score: 1,
  slug: "calendar",
  registry: "https://clawhub.ai",
  installRef: "@alice/calendar",
  displayName: "Calendar",
};

function mountSkills(
  request: (method: string, params?: unknown) => Promise<unknown>,
  surface: "discovery" | "settings" = "discovery",
) {
  const client = { request } as unknown as GatewayBrowserClient;
  const connection = createApplicationGateway({
    client,
    phase: "connected",
    offlineStable: false,
    hello: gatewayHelloForMethods(["skills.install", "skills.update"]),
    canvasPluginSurfaceUrl: null,
    assistantAgentId: "main",
    sessionKey: "main",
    lastError: null,
    lastErrorCode: null,
  });
  const agentsList = {
    defaultId: "main",
    mainKey: "main",
    scope: "global" as const,
    agents: [{ id: "main" }, { id: "research" }],
  };
  const agents = {
    state: { agentsList, agentsLoading: false, agentsError: null },
    ensureList: vi.fn(async () => agentsList),
    subscribe: () => () => undefined,
  } as unknown as ApplicationContext["agents"];
  const context = {
    basePath: "",
    gateway: connection.gateway,
    agents,
    agentSelection: createAgentSelectionCapability(connection.gateway, agents),
    settingsAgentSelection: createAgentSelectionCapability(
      connection.gateway,
      agents,
      undefined,
      undefined,
      { requireConfiguredAgent: true },
    ),
    navigate: vi.fn(),
  } as unknown as ApplicationContext;
  const selection =
    surface === "settings" ? context.settingsAgentSelection : context.agentSelection;
  const initialRouteData: SkillsRouteData = {
    gateway: connection.gateway,
    gatewaySnapshot: connection.gateway.snapshot,
    agents,
    selectedAgentId: "main",
    selectionIntentRevision: selection.intentRevision,
    report: { workspaceDir: "/workspace", managedSkillsDir: "/managed", skills: [] },
    error: null,
  };
  const [routeData, setRouteData] = createSignal(initialRouteData, { ownedWrite: true });
  const mounted = mountSolid(() => (
    <ApplicationProvider value={context}>
      <SkillsPage routeData={routeData()} surface={surface} />
    </ApplicationProvider>
  ));
  flush();
  const page = mounted.container.querySelector<HTMLElement>("openclaw-skills-page")!;
  return {
    page,
    connection,
    agents,
    context,
    refreshRouteData: () => {
      setRouteData({ ...initialRouteData });
      flush();
    },
  };
}

afterEach(() => {
  cleanupSolid();
  document.body.replaceChildren();
});

describe("Skills discovery lifecycle", () => {
  it("shows a settings heading with its four actions in one row below it", async () => {
    const { page } = mountSkills(
      async (method) => (method === "skills.library.list" ? personalLibrary : { skills: [] }),
      "settings",
    );
    await waitForFast(() =>
      expect(
        page.querySelectorAll<HTMLButtonElement>(".plugins-toolbar button").length,
      ).toBeGreaterThanOrEqual(4),
    );

    expect(page.querySelector(".content-header h1")?.textContent).toBe("Skills");
    const actions = page.querySelector(".plugins-toolbar");
    expect(
      Array.from(actions?.querySelectorAll("button") ?? [], (button) => button.textContent?.trim()),
    ).toEqual(["Search skills", "Workshop", "Create skill", "Import skill"]);
  });

  it("opens Plugins and Skill workshop from the shared tabs", async () => {
    const { page, context } = mountSkills(async (method) =>
      method === "skills.library.list" ? personalLibrary : { results: [] },
    );
    flush();
    for (const tab of ["plugins", "skill-workshop"]) {
      page
        .querySelector(`#plugins-tab-${tab}`)
        ?.dispatchEvent(new MouseEvent("click", { detail: 1, bubbles: true }));
      expect(context.navigate).toHaveBeenLastCalledWith(tab);
    }
  });

  it("keeps the discovery input and focus when a query publishes a new view revision", () => {
    const { page } = mountSkills(async (method) =>
      method === "skills.library.list" ? personalLibrary : { results: [] },
    );
    const input = page.querySelector<HTMLInputElement>('input[name="skills-search"]')!;
    input.focus();
    input.value = "calendar";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    flush();
    expect(page.querySelector('input[name="skills-search"]')).toBe(input);
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe("calendar");
  });

  it("follows sidebar selection and rejects old scope results before installing", async () => {
    const oldReport = deferred<unknown>();
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "skills.search") {
        return { results: [remoteSkill] };
      }
      if (method === "skills.library.list") {
        return { ...personalLibrary, defaultTarget: "workspace" };
      }
      if (method === "skills.status") {
        if ((params as { agentId: string }).agentId === "research") {
          return oldReport.promise;
        }
        return { skills: [createSkill({ name: "main-only", skillKey: "main-only" })] };
      }
      if (method === "skills.install") {
        return { message: "Installed" };
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const { page, context, refreshRouteData } = mountSkills(request);
    await waitForFast(() =>
      expect(page.querySelector(".plugin-catalog-card__install")).not.toBeNull(),
    );
    context.agentSelection.set("research");
    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith("skills.status", { agentId: "research" }),
    );
    context.agentSelection.set("main");
    await waitForFast(() => expect(page.textContent).toContain("main-only"));
    oldReport.resolve({
      skills: [createSkill({ name: "research-only", skillKey: "research-only", disabled: true })],
    });
    await oldReport.promise;
    flush();
    expect(page.textContent).not.toContain("research-only");
    expect(page.querySelector('[name="skills-agent"]')).toBeNull();
    context.agentSelection.set("research");
    await waitForFast(() => expect(page.textContent).toContain("research-only"));
    expect(
      page
        .querySelector('[data-skill-id="local:research-only"] .settings-status')
        ?.getAttribute("title"),
    ).toContain("Disabled");
    refreshRouteData();
    flush();
    expect(context.agentSelection.state.selectedId).toBe("research");
    expect(page.textContent).toContain("research-only");
    page.querySelector<HTMLButtonElement>(".plugin-catalog-card__install")!.click();
    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith("skills.install", {
        agentId: "research",
        source: "clawhub",
        slug: "@alice/calendar",
      }),
    );
    page.querySelector<HTMLButtonElement>('[aria-label="Skill settings"]')!.click();
    expect(context.navigate).toHaveBeenCalledWith("skill-settings", { search: "?agent=research" });
  });
  it("keeps Settings scope independent of discovery and rejects an older route snapshot", async () => {
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "skills.library.list") {
        return { ...personalLibrary, defaultTarget: "workspace" };
      }
      if (method === "skills.status") {
        const agentId = (params as { agentId: string }).agentId;
        return { skills: [createSkill({ name: `${agentId}-only`, skillKey: `${agentId}-only` })] };
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const { page, context, refreshRouteData } = mountSkills(request, "settings");
    flush();
    context.settingsAgentSelection.set("research");
    await waitForFast(() => expect(page.textContent).toContain("research-only"));
    expect(page.querySelector("openclaw-agent-select")).toBeNull();
    context.agentSelection.set("research");
    context.agentSelection.set("main");
    refreshRouteData();
    flush();
    expect(page.textContent).toContain("research-only");
    expect(context.settingsAgentSelection.state.selectedId).toBe("research");
    expect(request.mock.calls.filter(([method]) => method === "skills.status")).toEqual([
      ["skills.status", { agentId: "research" }],
    ]);
  });

  it("reloads empty-query results after a same-client reconnect and ignores the previous search", async () => {
    const staleSearch = deferred<{ results: (typeof remoteSkill)[] }>();
    const search = vi
      .fn()
      .mockReturnValueOnce(staleSearch.promise)
      .mockResolvedValue({ results: [remoteSkill] });
    const request = vi.fn(async (method: string) => {
      if (method === "skills.search") {
        return search();
      }
      if (method === "skills.library.list") {
        return personalLibrary;
      }
      if (method === "skills.status") {
        return { skills: [] };
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const { page, connection, agents } = mountSkills(request);
    await waitForFast(() => expect(search).toHaveBeenCalledOnce());

    connection.publish({ ...connection.gateway.snapshot, phase: "reconnecting" });
    connection.publish({ ...connection.gateway.snapshot, phase: "connected" });

    await waitForFast(() => {
      expect(search).toHaveBeenCalledTimes(2);
      expect(page.querySelector('[data-skill-id="remote:@alice/calendar"]')).not.toBeNull();
    });
    staleSearch.resolve({
      results: [{ ...remoteSkill, installRef: "@old/calendar", displayName: "Old calendar" }],
    });
    await staleSearch.promise;
    flush();
    expect(page.querySelector('[data-skill-id="remote:@old/calendar"]')).toBeNull();
    expect(agents.ensureList).not.toHaveBeenCalled();
    expect(request.mock.calls.filter(([method]) => method === "skills.search")).toHaveLength(2);
  });

  it.each(["personal", "failure"] as const)(
    "waits for the library destination before allowing installation (%s)",
    async (outcome) => {
      const library = deferred<SkillsLibraryListResult>();
      const request = vi.fn(async (method: string) => {
        if (method === "skills.library.list") {
          return library.promise;
        }
        if (method === "skills.search") {
          return { results: [remoteSkill] };
        }
        throw new Error(`Unexpected method: ${method}`);
      });
      const { page } = mountSkills(request);
      const install = () => page.querySelector<HTMLButtonElement>(".plugin-catalog-card__install");
      await waitForFast(() => expect(install()).not.toBeNull());
      expect(install()!.disabled).toBe(true);
      install()!.click();
      expect(request.mock.calls.some(([method]) => method === "skills.install")).toBe(false);

      if (outcome === "failure") {
        library.reject(new Error("Library unavailable"));
        await waitForFast(() => expect(page.textContent).toContain("Library unavailable"));
        expect(install()!.disabled).toBe(true);
      } else {
        library.resolve(personalLibrary);
        await waitForFast(() => expect(install()!.disabled).toBe(false));
        install()!.click();
        flush();
        expect(page.querySelector('input[name="library-import-slug"]')).not.toBeNull();
        expect(request.mock.calls.some(([method]) => method === "skills.install")).toBe(false);
      }
    },
  );
});
