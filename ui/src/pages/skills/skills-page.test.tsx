import type { SkillsLibraryListResult } from "@openclaw/gateway-protocol";
import { createSignal, flush } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { createAgentSelectionCapability } from "../../app/agent-selection.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { ApplicationProvider } from "../../lib/reactive/context.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
// @vitest-environment jsdom
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { SkillsPage, type SkillsRouteData } from "./skills-page.tsx";
import { connectedGateway, libraryEntry, libraryList, requestFor } from "./skills.test-support.ts";
import { createSkill } from "./view.test-support.ts";

const personalLibrary = libraryList();

const remoteSkill = {
  score: 1,
  slug: "calendar",
  registry: "https://clawhub.ai",
  installRef: "@alice/calendar",
  displayName: "Calendar",
};
const emptySearch = async (method: string) =>
  method === "skills.library.list" ? personalLibrary : { results: [] };

function agentReport(agentId?: string, disabled = false) {
  return {
    workspaceDir: "/workspace",
    managedSkillsDir: "/managed",
    skills: agentId
      ? [createSkill({ name: `${agentId}-only`, skillKey: `${agentId}-only`, disabled })]
      : [],
  };
}

function scopeRequest(overrides: Parameters<typeof requestFor>[0] = {}) {
  return requestFor({
    "skills.library.list": () => ({ ...personalLibrary, defaultTarget: "workspace" }),
    "skills.status": (params) => agentReport((params as { agentId: string }).agentId),
    ...overrides,
  });
}

function findButton(page: HTMLElement, label: string) {
  return [...page.querySelectorAll<HTMLButtonElement>("button")].find(
    (item) => item.textContent?.trim() === label,
  )!;
}

function enter(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  flush();
}

function mountSkills(
  request: (method: string, params?: unknown) => Promise<unknown>,
  surface: "discovery" | "settings" = "discovery",
) {
  const connection = connectedGateway(request, ["skills.install", "skills.update"]);
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
    report: agentReport(),
    error: null,
  };
  const [routeData, setRouteData] = createSignal(initialRouteData, { ownedWrite: true });
  const [currentSurface, setCurrentSurface] = createSignal(surface);
  const mounted = mountSolid(() => (
    <ApplicationProvider value={context}>
      <SkillsPage routeData={routeData()} surface={currentSurface()} />
    </ApplicationProvider>
  ));
  flush();
  const page = mounted.container.querySelector<HTMLElement>("openclaw-skills-page")!;
  const publishRouteData = (patch: Partial<SkillsRouteData> = {}) => {
    setRouteData({ ...initialRouteData, ...patch });
    flush();
  };
  return {
    page,
    find: <T extends Element = HTMLElement>(selector: string) => page.querySelector<T>(selector),
    findAll: (selector: string) => page.querySelectorAll(selector),
    button: (label: string) => findButton(page, label),
    waitForText: (text: string) => waitForFast(() => expect(page.textContent).toContain(text)),
    connection,
    agents,
    context,
    changeSurface(this: void, next: "discovery" | "settings") {
      setCurrentSurface(next);
      flush();
    },
    publishRouteData,
  };
}

afterEach(() => vi.restoreAllMocks());

it("retains a library draft across reconnect and retires it on client replacement", async () => {
  const request = requestFor({
    "skills.library.save": () => {
      throw new Error("Synthetic save rejection");
    },
    "skills.library.list": () => ({
      ...personalLibrary,
      entries: [libraryEntry({ slug: "retained-library-skill" })],
    }),
    "skills.status": () => ({ skills: [] }),
  });
  const { page, connection, find, button, waitForText } = mountSkills(request, "settings");
  await waitForFast(() => expect(button("Create skill").disabled).toBe(false));
  button("Create skill").click();
  flush();
  const content = find<HTMLTextAreaElement>('textarea[name="library-content"]')!;
  enter(content, "# Offline draft\nKeep this authored content.");
  const slug = find<HTMLInputElement>('input[name="library-slug"]')!;
  enter(slug, "offline-draft");
  const snapshot = connection.gateway.snapshot;
  connection.publish({ ...snapshot, phase: "reconnecting", hello: null });
  flush();
  expect(page.textContent).toContain("retained-library-skill");
  expect(find<HTMLTextAreaElement>('textarea[name="library-content"]')?.value).toBe(content.value);
  connection.publish(snapshot);
  flush();
  expect(find<HTMLTextAreaElement>('textarea[name="library-content"]')?.value).toBe(content.value);
  await waitForFast(() => expect(button("Save skill").disabled).toBe(false));
  button("Save skill").click();
  await waitForFast(() =>
    expect(request).toHaveBeenCalledWith("skills.library.save", {
      expectedRevision: null,
      slug: "offline-draft",
      content: "# Offline draft\nKeep this authored content.",
      files: [],
    }),
  );
  connection.publish({ ...snapshot, client: { request } as unknown as GatewayBrowserClient });
  flush();
  expect(find('textarea[name="library-content"]')).toBeNull();
  await waitForText("retained-library-skill");
  button("Create skill").click();
  flush();
  expect(find('textarea[name="library-content"]')).not.toBeNull();
  connection.publish({
    ...connection.gateway.snapshot,
    hello: gatewayHelloForMethods([], ["operator.read"]),
  });
  flush();
  expect(find('textarea[name="library-content"]')).toBeNull();
  connection.publish({ ...connection.gateway.snapshot, hello: gatewayHelloForMethods([], []) });
  flush();
  expect(page.textContent).not.toContain("retained-library-skill");
});

it("shows a settings heading with its four actions in one row below it", async () => {
  const { find, findAll } = mountSkills(
    async (method) => (method === "skills.library.list" ? personalLibrary : { skills: [] }),
    "settings",
  );
  await waitForFast(() => {
    expect(find(".content-header h1")).toMatchObject({ textContent: "Skills" });
    expect(
      [...findAll(".plugins-toolbar button")].map((button) => button.textContent?.trim()),
    ).toEqual(["Search skills", "Workshop", "Create skill", "Import skill"]);
  });
});

it("opens Plugins and Skill workshop from the shared tabs", async () => {
  const { page, context } = mountSkills(emptySearch);
  for (const tab of ["plugins", "skill-workshop"]) {
    page
      .querySelector(`#plugins-tab-${tab}`)
      ?.dispatchEvent(new MouseEvent("click", { detail: 1, bubbles: true }));
    expect(context.navigate).toHaveBeenLastCalledWith(tab);
  }
});

it("keeps the discovery input and focus when a query publishes a new view revision", () => {
  const { find } = mountSkills(emptySearch);
  const input = find<HTMLInputElement>('input[name="skills-search"]')!;
  input.focus();
  enter(input, "calendar");
  expect(find('input[name="skills-search"]')).toBe(input);
  expect(document.activeElement).toBe(input);
  expect(input.value).toBe("calendar");
});

it("follows sidebar selection and rejects old scope results before installing", async () => {
  const oldReport = deferred<unknown>();
  const request = scopeRequest({
    "skills.search": () => ({ results: [remoteSkill] }),
    "skills.status": (params) => {
      if ((params as { agentId: string }).agentId === "research") {
        return oldReport.promise;
      }
      return agentReport("main");
    },
    "skills.install": () => ({ message: "Installed" }),
  });
  const { page, context, publishRouteData, find, waitForText } = mountSkills(request);
  await waitForFast(() => expect(find(".plugin-catalog-card__install")).not.toBeNull());
  context.agentSelection.set("research");
  await waitForFast(() =>
    expect(request).toHaveBeenCalledWith("skills.status", { agentId: "research" }),
  );
  context.agentSelection.set("main");
  await waitForText("main-only");
  oldReport.resolve(agentReport("research", true));
  await oldReport.promise;
  flush();
  expect(page.textContent).not.toContain("research-only");
  expect(find('[name="skills-agent"]')).toBeNull();
  context.agentSelection.set("research");
  await waitForText("research-only");
  expect(
    page
      .querySelector('[data-skill-id="local:research-only"] .settings-status')
      ?.getAttribute("title"),
  ).toContain("Disabled");
  publishRouteData();
  expect(context.agentSelection.state.selectedId).toBe("research");
  expect(page.textContent).toContain("research-only");
  find<HTMLButtonElement>(".plugin-catalog-card__install")!.click();
  await waitForFast(() =>
    expect(request).toHaveBeenCalledWith("skills.install", {
      agentId: "research",
      source: "clawhub",
      slug: "@alice/calendar",
    }),
  );
  find<HTMLButtonElement>('[aria-label="Skill settings"]')!.click();
  expect(context.navigate).toHaveBeenCalledWith("skill-settings", { search: "?agent=research" });
});
it("keeps Settings scope independent of discovery and rejects an older route snapshot", async () => {
  const request = scopeRequest();
  const { page, context, publishRouteData, waitForText } = mountSkills(request, "settings");
  context.settingsAgentSelection.set("research");
  await waitForText("research-only");
  expect(page.querySelector("openclaw-agent-select")).toBeNull();
  context.agentSelection.set("research");
  context.agentSelection.set("main");
  publishRouteData();
  expect(page.textContent).toContain("research-only");
  expect(context.settingsAgentSelection.state.selectedId).toBe("research");
  expect(request.mock.calls.filter(([method]) => method === "skills.status")).toEqual([
    ["skills.status", { agentId: "research" }],
  ]);
});

it("keeps each selection owner when a retained page changes surface", async () => {
  const warnings = vi.spyOn(console, "warn");
  const request = scopeRequest({
    "skills.search": () => ({ results: [] }),
  });
  const { context, publishRouteData, changeSurface, waitForText } = mountSkills(request);
  context.agentSelection.set("research");
  await waitForText("research-only");
  publishRouteData({
    selectedAgentId: "research",
    selectionIntentRevision: context.agentSelection.intentRevision,
    report: agentReport("research"),
  });
  // Independent owners can have equal intent revisions while selecting different agents.
  context.settingsAgentSelection.set("main");
  changeSurface("settings");
  await waitForText("main-only");
  expect(context.settingsAgentSelection.state.selectedId).toBe("main");
  expect(context.agentSelection.state.selectedId).toBe("research");
  request.mockClear();
  context.agentSelection.set("main");
  flush();
  expect(request).not.toHaveBeenCalled();
  expect(
    warnings.mock.calls.filter(
      ([message]) =>
        typeof message === "string" &&
        message.includes("STRICT_READ_UNTRACKED") &&
        message.includes("effect callback"),
    ),
  ).toEqual([]);
});

it("reloads empty-query results after a same-client reconnect and ignores the previous search", async () => {
  const staleSearch = deferred<{ results: (typeof remoteSkill)[] }>();
  const search = vi
    .fn()
    .mockReturnValueOnce(staleSearch.promise)
    .mockResolvedValue({ results: [remoteSkill] });
  const request = requestFor({
    "skills.search": () => search(),
    "skills.library.list": () => personalLibrary,
    "skills.status": () => ({ skills: [] }),
  });
  const { connection, agents, find } = mountSkills(request);
  await waitForFast(() => expect(search).toHaveBeenCalledOnce());

  connection.publish({ ...connection.gateway.snapshot, phase: "reconnecting" });
  connection.publish({ ...connection.gateway.snapshot, phase: "connected" });

  await waitForFast(() => {
    expect(search).toHaveBeenCalledTimes(2);
    expect(find('[data-skill-id="remote:@alice/calendar"]')).not.toBeNull();
  });
  staleSearch.resolve({
    results: [{ ...remoteSkill, installRef: "@old/calendar", displayName: "Old calendar" }],
  });
  await staleSearch.promise;
  flush();
  expect(find('[data-skill-id="remote:@old/calendar"]')).toBeNull();
  expect(agents.ensureList).not.toHaveBeenCalled();
  expect(request.mock.calls.filter(([method]) => method === "skills.search")).toHaveLength(2);
});

it.each(["personal", "failure"] as const)(
  "waits for the library destination before allowing installation (%s)",
  async (outcome) => {
    const library = deferred<SkillsLibraryListResult>();
    const request = requestFor({
      "skills.library.list": () => library.promise,
      "skills.search": () => ({ results: [remoteSkill] }),
    });
    const { find, waitForText } = mountSkills(request);
    const install = () => find<HTMLButtonElement>(".plugin-catalog-card__install");
    await waitForFast(() => expect(install()).not.toBeNull());
    expect(install()!.disabled).toBe(true);
    install()!.click();
    expect(request.mock.calls.some(([method]) => method === "skills.install")).toBe(false);

    if (outcome === "failure") {
      library.reject(new Error("Library unavailable"));
      await waitForText("Library unavailable");
      expect(install()!.disabled).toBe(true);
    } else {
      library.resolve(personalLibrary);
      await waitForFast(() => expect(install()!.disabled).toBe(false));
      install()!.click();
      flush();
      expect(find('input[name="library-import-slug"]')).not.toBeNull();
      expect(request.mock.calls.some(([method]) => method === "skills.install")).toBe(false);
    }
  },
);
