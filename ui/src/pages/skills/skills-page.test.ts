// @vitest-environment jsdom
import type { SkillsLibraryListResult } from "@openclaw/gateway-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { createAgentSelectionCapability } from "../../app/agent-selection.ts";
import type { ApplicationContext } from "../../app/context.ts";
import {
  createApplicationContextProvider,
  createApplicationGateway,
} from "../../test-helpers/application-context.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import type { SkillsRouteData } from "./skills-page.ts";
import { createSkill } from "./view.test-support.ts";
import "./skills-page.ts";

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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function mountSkills(request: (method: string, params?: unknown) => Promise<unknown>) {
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
    navigate: vi.fn(),
  } as unknown as ApplicationContext;
  const host = createApplicationContextProvider(context);
  const page = document.createElement("openclaw-skills-page") as HTMLElement & {
    routeData: SkillsRouteData;
    surface: "discovery" | "settings";
    updateComplete: Promise<boolean>;
  };
  page.surface = "discovery";
  page.routeData = {
    gateway: connection.gateway,
    gatewaySnapshot: connection.gateway.snapshot,
    agents,
    agentsList,
    selectedAgentId: "main",
    selection: context.agentSelection.state,
    report: { workspaceDir: "/workspace", managedSkillsDir: "/managed", skills: [] },
    error: null,
  };
  host.append(page);
  document.body.append(host);
  return { page, connection, agents, context };
}

afterEach(() => document.body.replaceChildren());

describe("Skills discovery lifecycle", () => {
  it("opens Plugins and Skill workshop from the shared tabs", async () => {
    const { page, context } = mountSkills(async (method) =>
      method === "skills.library.list" ? personalLibrary : { results: [] },
    );
    await page.updateComplete;
    for (const tab of ["plugins", "skill-workshop"]) {
      page
        .querySelector(`#plugins-tab-${tab}`)
        ?.dispatchEvent(new MouseEvent("click", { detail: 1, bubbles: true }));
      expect(context.navigate).toHaveBeenLastCalledWith(tab);
    }
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
    const { page, context } = mountSkills(request);
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
    await page.updateComplete;
    expect(page.textContent).not.toContain("research-only");
    expect(page.querySelector('[name="skills-agent"]')).toBeNull();
    context.agentSelection.set("research");
    await waitForFast(() => expect(page.textContent).toContain("research-only"));
    expect(
      page
        .querySelector('[data-skill-id="local:research-only"] .settings-status')
        ?.getAttribute("title"),
    ).toContain("Disabled");
    page.routeData = { ...page.routeData };
    await page.updateComplete;
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
    await page.updateComplete;
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
        await page.updateComplete;
        expect(page.querySelector('input[name="library-import-slug"]')).not.toBeNull();
        expect(request.mock.calls.some(([method]) => method === "skills.install")).toBe(false);
      }
    },
  );
});
