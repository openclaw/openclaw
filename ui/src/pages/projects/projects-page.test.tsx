import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectRecord } from "../../../../packages/gateway-protocol/src/index.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import { showConfirmChoiceDialog } from "../../components/confirm-dialog.ts";
import { showInputDialog } from "../../components/input-dialog.tsx";
import type { ConfigPatchOptions } from "../../lib/config/config-gateway-operations.ts";
import { projectsForGateway } from "../../lib/projects.ts";
import { projectCallbackOwner } from "../../lib/reactive/callback-owner.ts";
import {
  createApplicationGateway,
  createApplicationGatewaySnapshot,
} from "../../test-helpers/application-context-fixtures.ts";
import { cleanupSolid, mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { ProjectsModel } from "./projects-model.ts";
import { renderProjectsView } from "./projects-page.tsx";

// mock-isolation: Replace imperative dialogs so confirmations and prompts remain deterministic.
vi.mock("../../components/confirm-dialog.ts", () => ({
  showConfirmDialog: vi.fn(),
  showConfirmChoiceDialog: vi.fn(),
}));
vi.mock("../../components/input-dialog.tsx", () => ({ showInputDialog: vi.fn() }));
// mock-isolation: Observe New Session catalog invalidation without its connection lifecycle.
vi.mock("../../lib/projects.ts", () => {
  const refresh = vi.fn(async () => undefined);
  return { projectsForGateway: vi.fn(() => ({ refresh })) };
});

const SITE: ProjectRecord = {
  id: "site",
  displayName: "site",
  source: "registered",
  repositoryIdentity: "openclaw/site",
  repoRoot: "/srv/site",
  originUrl: "https://github.com/openclaw/site.git",
};
const DOCS: ProjectRecord = {
  id: "docs",
  displayName: "docs",
  source: "cloned",
  repoRoot: "/srv/openclaw/projects/docs",
};
const WORKSPACE: ProjectRecord = {
  id: "workspace:main",
  displayName: "main",
  source: "workspace",
  agentId: "main",
  repoRoot: "/home/openclaw/.openclaw/workspace",
};
const ROLES = {
  admin: { sessions: { others: "write" }, agents: "*", scopes: ["operator.admin"] },
  contractor: {
    sessions: { others: "none" },
    agents: ["main"],
    scopes: ["operator.sessions.write"],
    projects: ["site"],
  },
  operator: { sessions: { others: "write" }, agents: "*", scopes: ["operator.write"] },
  viewer: { sessions: { others: "view" }, agents: "*", scopes: ["operator.read"] },
};
const METHODS = ["projects.list", "projects.register", "projects.remove", "projects.add"];

type Request = ReturnType<typeof vi.fn>;

function listRequest(projects: ProjectRecord[] = [SITE, DOCS, WORKSPACE]) {
  return vi.fn(async (method: string) => (method === "projects.list" ? { projects } : {}));
}

function createProjectsPage(
  request: Request,
  options: { scopes?: string[]; readOnly?: boolean; roles?: object | null } = {},
) {
  const snapshot: ApplicationGatewaySnapshot = createApplicationGatewaySnapshot({
    client: { request } as unknown as GatewayBrowserClient,
    phase: "connected",
    sessionKey: "main",
    hello: {
      type: "hello-ok",
      protocol: 1,
      auth: { role: "operator", scopes: options.scopes ?? ["operator.admin"] },
      features: { methods: METHODS },
    } as ApplicationGatewaySnapshot["hello"],
  });
  const { gateway } = createApplicationGateway(snapshot);
  const sourceConfig =
    options.roles === null ? {} : { gateway: { roles: { definitions: options.roles ?? ROLES } } };
  const state = {
    connected: true,
    configSnapshot: { sourceConfig, hash: "base" },
    lastError: null as string | null,
  };
  const patches: ConfigPatchOptions[] = [];
  const runtimeConfig = {
    state,
    canPatch: true,
    subscribe: () => () => undefined,
    ensureDisplayLoaded: vi.fn(async () => undefined),
    patchFromSnapshot: vi.fn(
      async (
        build: (
          config: Record<string, unknown>,
        ) => { options: ConfigPatchOptions } | { error: string },
      ) => {
        const built = build(sourceConfig);
        if ("error" in built) {
          state.lastError = built.error;
          return false;
        }
        patches.push(built.options);
        return true;
      },
    ),
  };
  const context = {
    basePath: "",
    gateway,
    navigate: vi.fn(),
    preload: vi.fn(async () => undefined),
    runtimeConfig,
    config: { current: { readOnlyConfig: options.readOnly ? { message: "" } : undefined } },
    agents: { state: { agentsList: null } },
  } as unknown as ApplicationContext;
  let publish: (() => void) | undefined;
  const model = new ProjectsModel(
    () => context,
    () => publish?.(),
  );
  const element = document.createElement("div");
  document.body.append(element);
  mountSolid(
    () => {
      const { view } = projectCallbackOwner(
        (notify) => {
          publish = notify;
          return model;
        },
        (owner) => owner,
      );
      return renderProjectsView(model, view.read);
    },
    { container: element },
  );
  const buttons = (root: ParentNode = document) => [
    ...root.querySelectorAll<HTMLButtonElement>("button"),
  ];
  return {
    model,
    context,
    element,
    patches,
    runtimeConfig,
    button: (label: string, root?: ParentNode) =>
      buttons(root).find((button) => button.textContent?.trim() === label),
    rowText: (id: string) =>
      [...element.querySelectorAll("tbody tr")]
        .find((row) => row.querySelector("button")?.textContent === id)
        ?.textContent?.replace(/\s+/g, " "),
    dialog: () => document.querySelector<HTMLElement>(".projects-detail"),
    switchFor: (role: string) =>
      document.querySelector<HTMLInputElement>(
        `.projects-detail input[role="switch"][aria-label="${role}"]`,
      )!,
    async ready() {
      await waitForSolid(() => expect(model.listLoaded).toBe(true));
      flush();
    },
  };
}

async function openDetails(page: ReturnType<typeof createProjectsPage>, name: string) {
  page.button(name, page.element)!.click();
  await waitForSolid(() => expect(page.dialog()).not.toBeNull());
}

afterEach(() => {
  cleanupSolid();
  document.body.replaceChildren();
  vi.mocked(showConfirmChoiceDialog).mockReset();
  vi.mocked(showInputDialog).mockReset();
  vi.mocked(projectsForGateway).mockClear();
});

describe("ProjectsPage", () => {
  it("lists projects with their type, location and roles that can use them", async () => {
    const page = createProjectsPage(listRequest());
    await page.ready();
    await waitForSolid(() => expect(page.element.querySelectorAll("tbody tr")).toHaveLength(3));
    expect(page.rowText("site")).toBe(
      "siteopenclaw/siteGit checkout/srv/siteadmincontractoroperator",
    );
    expect(page.rowText("docs")).toBe(
      "docsGit checkout · cloned/srv/openclaw/projects/docsadminoperator",
    );
    expect(page.rowText("main")).toBe(
      "mainAgent workspace/home/openclaw/.openclaw/workspaceadmincontractoroperator",
    );
    const search = page.element.querySelector<HTMLInputElement>('input[type="search"]')!;
    search.value = "openclaw/site";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    await waitForSolid(() => expect(page.element.querySelectorAll("tbody tr")).toHaveLength(1));
  });

  it("explains unrestricted access when named roles aren't configured", async () => {
    const page = createProjectsPage(listRequest([SITE]), { roles: null });
    await page.ready();
    await waitForSolid(() => expect(page.rowText("site")).toContain("Everyone with write access"));
  });

  it("shares a project with a role through the config editor and locks fixed roles", async () => {
    const page = createProjectsPage(listRequest());
    await page.ready();
    await openDetails(page, "docs");
    expect(page.dialog()!.textContent).toContain("Restricted roles always get a new worktree.");
    expect(page.switchFor("admin")).toMatchObject({ checked: true, disabled: true });
    expect(page.switchFor("operator")).toMatchObject({ checked: true, disabled: true });
    expect(page.switchFor("viewer")).toMatchObject({ checked: false, disabled: true });
    expect(page.dialog()!.textContent).toContain("This role can’t start sessions.");
    const contractor = page.switchFor("contractor");
    expect(contractor).toMatchObject({ checked: false, disabled: false });

    contractor.click();
    await waitForSolid(() => expect(page.patches).toHaveLength(1));
    expect(page.patches[0]).toMatchObject({
      raw: { gateway: { roles: { definitions: { contractor: { projects: ["site", "docs"] } } } } },
    });
    expect(page.patches[0]).not.toHaveProperty("replacePaths");
    await waitForSolid(() => expect(page.model.operation).toBeNull());
  });

  it("disables role switches when the Gateway configuration is read-only", async () => {
    const page = createProjectsPage(listRequest(), { readOnly: true });
    await page.ready();
    await openDetails(page, "site");
    expect(page.dialog()!.textContent).toContain("Gateway configuration is read-only.");
    expect(page.switchFor("contractor")).toMatchObject({ checked: true, disabled: true });
    page.switchFor("contractor").click();
    flush();
    expect(page.runtimeConfig.patchFromSnapshot).not.toHaveBeenCalled();
  });

  it("keeps registration and project changes admin-only for writers", async () => {
    const page = createProjectsPage(listRequest(), {
      scopes: ["operator.read", "operator.write"],
    });
    await page.ready();
    expect(page.element.textContent).toContain("only admins can register or change them");
    expect(page.button("Register project", page.element)).toBeUndefined();
    await openDetails(page, "site");
    expect(page.button("Rename", page.dialog()!)).toBeUndefined();
    expect(page.button("Remove", page.dialog()!)).toBeUndefined();
    expect(page.switchFor("contractor").disabled).toBe(true);
  });

  it("renames through projects.rename and refreshes both project lists", async () => {
    const request = listRequest();
    vi.mocked(showInputDialog).mockImplementation(async (options) => {
      expect(options.defaultValue).toBe("site");
      return (await options.submit?.("Website")) === null ? "Website" : null;
    });
    const page = createProjectsPage(request);
    await page.ready();
    await openDetails(page, "site");
    page.button("Rename", page.dialog()!)!.click();
    await waitForSolid(() =>
      expect(request).toHaveBeenCalledWith("projects.rename", {
        projectId: "site",
        name: "Website",
      }),
    );
    await waitForSolid(() =>
      expect(request.mock.calls.filter(([method]) => method === "projects.list")).toHaveLength(2),
    );
    expect(vi.mocked(projectsForGateway).mock.results[0]?.value.refresh).toHaveBeenCalledWith(true);
  });

  it("surfaces the Gateway refusal to delete a referenced clone", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "projects.remove") {
        throw new Error("Project checkout is still referenced by session agent:main:main.");
      }
      return method === "projects.list" ? { projects: [SITE, DOCS] } : {};
    });
    vi.mocked(showConfirmChoiceDialog).mockResolvedValue("alternative");
    const page = createProjectsPage(request);
    await page.ready();
    await openDetails(page, "docs");
    page.button("Remove", page.dialog()!)!.click();
    await waitForSolid(() =>
      expect(request).toHaveBeenCalledWith("projects.remove", { id: "docs", deleteCheckout: true }),
    );
    await waitForSolid(() =>
      expect(page.dialog()!.querySelector('[role="alert"]')?.textContent).toContain(
        "still referenced by session agent:main:main",
      ),
    );
    expect(page.model.selectedId).toBe("docs");
  });

  it("places the Projects tab between Sessions and Worktrees", async () => {
    const page = createProjectsPage(listRequest());
    await page.ready();
    const tabs = [...page.element.querySelectorAll('[role="tab"]')].map((tab) =>
      tab.textContent?.trim(),
    );
    expect(tabs).toEqual(["Sessions", "Projects", "Worktrees"]);
    [...page.element.querySelectorAll<HTMLElement>('[role="tab"]')]
      .find((tab) => tab.textContent?.trim() === "Worktrees")!
      .click();
    expect(page.context.navigate).toHaveBeenCalledWith("worktrees");
  });
});
