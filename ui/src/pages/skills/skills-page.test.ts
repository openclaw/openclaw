// @vitest-environment jsdom
import type { SkillsLibraryListResult } from "@openclaw/gateway-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext } from "../../app/context.ts";
import {
  createApplicationContextProvider,
  createApplicationGateway,
} from "../../test-helpers/application-context.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import type { SkillsRouteData } from "./skills-page.ts";
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
    agents: [{ id: "main" }],
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
    report: { workspaceDir: "/workspace", managedSkillsDir: "/managed", skills: [] },
    error: null,
  };
  host.append(page);
  document.body.append(host);
  return { page, connection, agents };
}

afterEach(() => document.body.replaceChildren());

describe("Skills discovery lifecycle", () => {
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
