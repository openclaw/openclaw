import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { DraftGatewayState } from "./draft-gateway-state.ts";
import { DraftPlaceBrowser } from "./draft-place-browser.ts";
import type { NewSessionRouteData } from "./location.ts";
import { PICKER_INPUT_DEBOUNCE_MS } from "./place-browser-state.ts";
import { loadNewSessionPreference, replaceBrowserPreference } from "./preferences.ts";

afterEach(() => {
  localStorage.clear();
});

const listing = (path = "/workspace", home = "/home/test", entries = true) => ({
  path,
  home,
  entries: entries ? [{ name: "packages", path: `${path}/packages` }] : [],
});
const project = (id: string, displayName = id, repoRoot = `/${id}`) => ({
  id,
  displayName,
  repoRoot,
});
const nextTask = () =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
const calls = (request: ReturnType<typeof vi.fn>, method: string) =>
  request.mock.calls.filter(([called]) => called === method).length;
const requestFor = (
  handlers: Record<string, (params?: { path?: string }) => unknown>,
  fallback: () => unknown = () => ({ projects: [] }),
) =>
  vi.fn(async (method: string, params?: { path?: string }) =>
    (handlers[method] ?? fallback)(params),
  );

function createBrowser(
  request: (method: string) => Promise<unknown>,
  data?: NewSessionRouteData,
  recoveryReady = true,
  isAdmin = false,
  view?: { updateComplete: Promise<unknown>; root: HTMLElement },
) {
  const client = {
    request,
    recoveryScope: recoveryReady ? "principal-a" : "",
    recoveryScopeReady: recoveryReady,
    // The real client retains hello identity before browser recovery migration settles.
    offlineRecoveryScope: "principal-a",
  };
  const onInvalidate = vi.fn((reset: boolean) => {
    browser?.resetProjects(reset);
  });
  const hello = {
    auth: { recoveryScope: "principal-a", role: "operator", scopes: ["operator.read"] },
    features: { methods: ["projects.list"] },
  };
  const context = {
    gateway: {
      subscribe: () => () => undefined,
      subscribeEvents: () => () => undefined,
      connection: { gatewayUrl: "ws://gateway.example" },
      snapshot: { phase: "connected", client, hello },
    },
    agents: { state: { agentsList: { sessionPlacement: {} } } },
    sessions: {
      state: {
        groupSettings: [{ name: "Client", cwd: "/workspace/client", worktree: false }],
      },
      groupsStatus: () => "ready",
    },
  } as unknown as ApplicationContext;
  const gateway = new DraftGatewayState(
    () => ({
      context,
      data,
      isConnected: true,
      isAdmin: false,
      canStartAsDraft: false,
      visibility: "normal",
      cloudProfileId: "",
      pendingPlacement: { sessionKey: "", gatewayUrl: "", recoveryScope: "" },
      agentsHydrated: false,
      runtimeId: "",
    }),
    {
      readAgents: () => context.agents,
      changed: vi.fn(),
      updateComplete: () => Promise.resolve(),
      onInvalidate,
      onVisibilityRetired: vi.fn(),
      onCloudProfileCleared: vi.fn(),
      onCloudState: vi.fn(),
      onPendingPlacementReset: vi.fn(),
      onRecoveryReady: vi.fn(),
      onAdoptAgentDefaults: vi.fn(),
    },
  );
  gateway.synchronize(context.gateway);
  const onProjectMissing = vi.fn();
  const onSelectProject = vi.fn();
  const browser = new DraftPlaceBrowser(gateway, () => ({ context, isAdmin }), {
    changed: vi.fn(),
    updateComplete: () => view?.updateComplete ?? Promise.resolve(),
    onProjectMissing,
    onSelectProject,
    onApprovedListing: vi.fn(),
    activeElement: () => view?.root.ownerDocument.activeElement ?? null,
  });
  onTestFinished(() => {
    gateway.disconnect();
    browser?.disconnect();
  });
  return {
    browser,
    onProjectMissing,
    onSelectProject,
    onInvalidate,
    gateway,
    client,
    context,
    hello,
    synchronize() {
      gateway.synchronizeMetadata();
      browser.synchronize();
    },
    update() {
      gateway.synchronize(context.gateway);
      gateway.synchronizeMetadata();
      browser.synchronize();
    },
  };
}

describe("DraftPlaceBrowser", () => {
  it.each(["current", "closed", "disconnected", "focus moved", "returned"])(
    "focuses only the current project view after rendering (%s)",
    async (change) => {
      const update = createDeferred<boolean>();
      const root = document.body.appendChild(document.createElement("div"));
      onTestFinished(() => root.remove());
      const popover = root.appendChild(document.createElement("div"));
      popover.className = "new-session-page__project-popover";
      const browse = popover.appendChild(document.createElement("button"));
      browse.dataset.value = "browse";
      browse.textContent = "Browse";
      const elsewhere = root.appendChild(document.createElement("button"));
      const { browser } = createBrowser(
        async () => listing("/workspace", "/", false),
        undefined,
        true,
        false,
        { updateComplete: update.promise, root },
      );
      browser.projectFocus.browse = browse;
      browser.popoverCallbacks("project").onPopoverShow();
      browse.focus();
      browser.selectGatewayBrowser("/workspace");
      const path = document.createElement("input");
      path.className = "new-session-page__browser-path";
      popover.replaceChildren(path);
      browser.projectFocus.path = path;
      expect(document.activeElement).toBe(document.body);

      if (change === "closed") {
        browser.close();
      } else if (change === "disconnected") {
        browser.disconnect();
      } else if (change === "focus moved") {
        elsewhere.focus();
      } else if (change === "returned") {
        browser.showRoot();
        popover.replaceChildren(browse);
      }
      update.resolve(true);
      await update.promise;
      expect(document.activeElement).toBe(
        change === "current"
          ? path
          : change === "returned"
            ? browse
            : change === "focus moved"
              ? elsewhere
              : document.body,
      );
      if (change === "current") {
        browser.showRoot();
        popover.replaceChildren(browse);
        await update.promise;
        expect(document.activeElement).toBe(browse);
      }
    },
  );

  it("does not reattach a disposed draft catalog without a connected Gateway", async () => {
    const request = vi.fn(async (_method: string) => ({ projects: [] }));
    const fixture = createBrowser(request);
    await fixture.browser.refreshProjects();
    const reads = request.mock.calls.length;
    fixture.gateway.disconnect();
    fixture.browser.disconnect();
    fixture.synchronize();
    await Promise.resolve();
    expect(request).toHaveBeenCalledTimes(reads);
    fixture.update();
    await fixture.browser.refreshProjects();
    expect(
      request.mock.calls
        .slice(reads)
        .map(([method]) => method)
        .toSorted(),
    ).toEqual(["projects.list"]);
  });
  it("keeps environment search transient and separate from project search", () => {
    const { browser } = createBrowser(async () => ({}));
    const writeStorage = vi.spyOn(Storage.prototype, "setItem");
    onTestFinished(() => writeStorage.mockRestore());
    browser.changeProjectQuery("openclaw");
    browser.popoverCallbacks("where").onPopoverShow();
    browser.changeEnvironmentQuery("runner");

    expect(browser).toMatchObject({ environmentQuery: "runner", projectQuery: "openclaw" });
    expect(writeStorage).not.toHaveBeenCalled();

    browser.popoverCallbacks("where").onPopoverHide();
    browser.popoverCallbacks("where").onPopoverAfterHide();
    browser.popoverCallbacks("where").onPopoverShow();
    expect(browser).toMatchObject({ environmentQuery: "", projectQuery: "openclaw" });

    browser.changeEnvironmentQuery("cloud");
    browser.popoverCallbacks("project").onPopoverShow();
    expect(browser.environmentQuery).toBe("cloud");
    browser.disconnect();
    expect(browser.environmentQuery).toBe("");
    expect(writeStorage).not.toHaveBeenCalled();
  });

  it("keeps the current listing's repository probe while filtering its entries", async () => {
    const branches = createDeferred<{ repositoryStatus: "git" }>();
    const request = requestFor({
      "worktrees.branches": () => branches.promise,
      "fs.listDir": () => listing(),
    });
    const { browser } = createBrowser(request, undefined, true, true);
    browser.selectGatewayBrowser("/workspace");
    await waitForFast(() => expect(browser.browser.listing?.path).toBe("/workspace"));
    browser.browser.setDraft("/workspace/pa");
    branches.resolve({ repositoryStatus: "git" });
    await waitForFast(() => expect(browser.browserProjectPath).toBe("/workspace"));
  });

  it.each([
    "filtering",
    "navigation",
    "navigate away and back",
    "typed directory",
    "typed directory fails",
    "reopen",
    "retry",
  ])("selects a registered project only while its browser remains current (%s)", async (change) => {
    const registered = project("registered-workspace", "Workspace", "/workspace");
    const registration = createDeferred<typeof registered>();
    let directoryPath = "/workspace";
    let registrations = 0;
    const request = requestFor(
      {
        "projects.register": () => {
          registrations += 1;
          if (change === "retry" && registrations === 1) {
            throw new Error("registry unavailable");
          }
          return registration.promise;
        },
        "worktrees.branches": () => ({ repositoryStatus: "git" }),
        "fs.listDir": (params) => {
          if (params?.path === "/elsewhere") {
            throw new Error("directory not found");
          }
          return listing(directoryPath);
        },
      },
      () => ({ projects: [registered] }),
    );
    const { browser, onSelectProject } = createBrowser(request, undefined, true, true);
    browser.selectGatewayBrowser("/workspace");
    await waitForFast(() => expect(browser.browserProjectPath).toBe("/workspace"));
    if (change === "retry") {
      await browser.registerBrowserProject("/workspace");
      expect(browser.browser.error).toContain("registry unavailable");
      expect(browser).toMatchObject({
        browserRegistering: false,
        browserProjectPath: "/workspace",
      });
    }
    const pending = browser.registerBrowserProject("/workspace");
    const initiallyBusy = browser.browserRegistering;
    const failedDirectory = change === "typed directory fails";
    if (failedDirectory) {
      vi.useFakeTimers();
    }
    try {
      if (change === "filtering") {
        browser.browser.setDraft("/workspace/pa");
      } else if (change === "navigation" || change === "navigate away and back") {
        directoryPath = "/other";
        await browser.browser.navigate(directoryPath);
        if (change === "navigate away and back") {
          directoryPath = "/workspace";
          await browser.browser.navigate(directoryPath);
          await waitForFast(() => expect(browser.browserProjectPath).toBe("/workspace"));
        }
      } else if (change === "typed directory" || failedDirectory) {
        browser.browser.setDraft("/elsewhere/x");
        if (failedDirectory) {
          await vi.advanceTimersByTimeAsync(PICKER_INPUT_DEBOUNCE_MS);
          expect(browser).toMatchObject({
            browser: { listing: { path: "/workspace" }, loading: false, error: null },
            browserProjectPath: null,
          });
        } else {
          // Flush request continuations while the directory debounce is still pending.
          await Promise.resolve();
        }
      } else if (change === "reopen") {
        browser.close();
        browser.selectGatewayBrowser("/workspace");
        await waitForFast(() => expect(browser.browserProjectPath).toBe("/workspace"));
      }
      const stillBusy = browser.browserRegistering;
      const duplicate =
        change === "reopen" ? undefined : browser.registerBrowserProject(directoryPath);
      registration.resolve(registered);
      await Promise.all([pending, duplicate]);

      expect(initiallyBusy).toBe(true);
      expect(stillBusy).toBe(change !== "reopen");
      expect(calls(request, "projects.register")).toBe(change === "retry" ? 2 : 1);
      expect(registrations).toBe(change === "retry" ? 2 : 1);
      expect(browser.browserRegistering).toBe(false);
      if (change === "filtering" || change === "retry") {
        expect(onSelectProject).toHaveBeenCalledExactlyOnceWith(registered.id);
      } else {
        expect(onSelectProject).not.toHaveBeenCalled();
      }
    } finally {
      registration.resolve(registered);
      try {
        await pending;
      } finally {
        if (failedDirectory) {
          browser.browser.reset();
          vi.useRealTimers();
        }
      }
    }
  });

  it.each(["loaded", "pending"])(
    "reloads catalogs after owner reset without reconnecting (%s)",
    async (initial) => {
      const retired = project("retired", "Retired");
      const current = project("current", "Current");
      const pending = createDeferred<{ projects: (typeof retired)[] }>();
      const request = vi.fn(() => pending.promise);
      const fixture = createBrowser(request);
      const previous = fixture.browser.refreshProjects();
      if (initial === "loaded") {
        pending.resolve({ projects: [retired] });
        await previous;
      }

      request.mockResolvedValue({ projects: [current] });
      fixture.browser.resetProjects();
      fixture.update();
      await waitForFast(() => expect(fixture.browser.projects).toEqual([current]));
      pending.resolve({ projects: [retired] });
      await previous;
      expect(fixture.browser.projects).toEqual([current]);
    },
  );

  it.each(["disconnect", "failure"])(
    "retains selection until the catalog confirms removal (%s)",
    async (unavailable) => {
      const selected = project("project", "Project");
      const request = vi.fn(async () => ({ projects: [selected] }));
      const fixture = createBrowser(request);
      await fixture.browser.refreshProjects();
      fixture.browser.selectProject({ kind: "local", id: selected.id });

      if (unavailable === "disconnect") {
        fixture.context.gateway.snapshot.phase = "reconnecting";
        fixture.update();
      } else if (unavailable === "failure") {
        request.mockRejectedValue(new Error("projects unavailable"));
      }
      await fixture.browser.refreshProjects();
      expect(fixture.browser.selectedProject()).toEqual(selected);
      expect(fixture.onProjectMissing).not.toHaveBeenCalled();

      fixture.context.gateway.snapshot.phase = "connected";
      request.mockResolvedValue({ projects: [] });
      fixture.update();
      await fixture.browser.refreshProjects();
      expect(fixture.onProjectMissing).toHaveBeenCalled();
    },
  );

  it.each([
    ["the Gateway omits recents", async () => ({ projects: [] })],
    [
      "projects.list fails",
      async () => {
        throw new Error("projects unavailable");
      },
    ],
  ])("keeps roster recents when %s", async (_label, request) => {
    const { browser } = createBrowser(request);

    await browser.refreshProjects();

    expect(
      browser.resolveProjectRecents({
        sessions: [{ execCwd: "/workspace/recent" }],
        workspace: "/workspace",
        workspaceRoots: ["/workspace"],
        isAdmin: false,
      }),
    ).toEqual([{ kind: "folder", folder: "/workspace/recent", displayName: "recent" }]);
  });
});

describe("DraftGatewayState", () => {
  it("does not start preference reads after the draft disconnects during module loading", async () => {
    const request = vi.fn(async () => ({ status: "ok", entries: {} }));
    const fixture = createBrowser(request);
    fixture.context.gateway.snapshot.selfUser = { id: "profile-one" };
    fixture.hello.features.methods.push("users.prefs.get", "users.prefs.set");
    fixture.gateway.synchronize(fixture.context.gateway);
    expect(fixture.gateway.preferenceLoading).toBe(true);
    fixture.gateway.disconnect();
    await vi.dynamicImportSettled();
    expect(request).not.toHaveBeenCalled();
  });

  it.each(["disconnect", "credential", "gateway"])(
    "rejects late place catalogs synchronously after %s invalidation",
    async (change) => {
      const pending = createDeferred<{
        projects: { id: string }[];
        environments: { id: string }[];
        profiles: [];
      }>();
      const request = vi.fn(() => pending.promise);
      const fixture = createBrowser(request);
      fixture.hello.auth.scopes.push("operator.write");
      fixture.update();
      await waitForFast(() => expect(request).toHaveBeenCalledTimes(2));

      if (change === "disconnect") {
        fixture.context.gateway.snapshot.phase = "reconnecting";
      }
      if (change === "credential") {
        fixture.hello.auth.recoveryScope = "principal-b";
      }
      if (change === "gateway") {
        fixture.context.gateway.connection.gatewayUrl = "ws://gateway-b.example";
      }
      const current = createDeferred<Awaited<typeof pending.promise>>();
      request.mockReturnValue(current.promise);
      // Retirement must happen in synchronize, before the next view update.
      fixture.gateway.synchronize(fixture.context.gateway);
      pending.resolve({
        projects: [{ id: "retired" }],
        environments: [{ id: "retired" }],
        profiles: [],
      });
      await pending.promise;
      await nextTask();
      expect(fixture).toMatchObject({ browser: { projects: [] }, gateway: { environments: null } });
      current.resolve({ projects: [], environments: [], profiles: [] });
    },
  );

  it("discovers places from authenticated hello without refetching or losing input during migration", async () => {
    const request = requestFor(
      {
        "system.info": () => ({ machineName: "Gateway A" }),
        "projects.list": () => ({ projects: [{ id: "project", displayName: "Project" }] }),
      },
      () => ({ environments: [], profiles: [] }),
    );
    const fixture = createBrowser(request, undefined, false);
    fixture.hello.features.methods.push("system.info");
    fixture.hello.auth.scopes.push("operator.write");
    fixture.browser.browser.setDraft("/draft-folder");
    fixture.update();
    // Adding write access retires the old policy scope, independently of recovery migration.
    expect(fixture.onInvalidate).toHaveBeenCalledWith(true, "gateway-changed");
    fixture.onInvalidate.mockClear();
    await waitForFast(() => expect(fixture.gateway.gatewayName).toBe("Gateway A"));
    await waitForFast(() => expect(fixture.browser.projects).toHaveLength(1));
    await waitForFast(() => expect(fixture.gateway.cloudProfilesReady).toBe(true));
    fixture.browser.selectProject({ kind: "local", id: "project" });

    fixture.client.recoveryScope = "principal-a";
    fixture.client.recoveryScopeReady = true;
    fixture.update();
    expect(fixture.gateway.gatewayName).toBe("Gateway A");
    expect(fixture.onInvalidate).not.toHaveBeenCalled();
    expect(fixture.browser).toMatchObject({
      browser: { draft: "/draft-folder" },
      projectId: "project",
    });
    expect(calls(request, "projects.list")).toBe(1);
    expect(calls(request, "environments.list")).toBe(1);

    fixture.context.gateway.snapshot.phase = "reconnecting";
    fixture.client.recoveryScopeReady = false;
    fixture.update();
    fixture.context.gateway.snapshot.phase = "connected";
    fixture.update();
    await waitForFast(() => expect(calls(request, "projects.list")).toBe(2));
    fixture.client.recoveryScopeReady = true;
    fixture.update();
    expect(fixture.browser.projectId).toBe("project");
    await waitForFast(() => expect(calls(request, "environments.list")).toBe(2));

    fixture.hello.auth.recoveryScope = "principal-b";
    fixture.update();
    expect(fixture.onInvalidate).toHaveBeenLastCalledWith(true, "gateway-changed");
    expect(fixture.browser.projectId).toBe("");
  });

  it("ignores a late name from the replaced client", async () => {
    const oldName = createDeferred<{ machineName: string }>();
    const newName = createDeferred<{ machineName: string }>();
    const fixture = createBrowser((method) =>
      method === "projects.list" ? Promise.resolve({ projects: [] }) : oldName.promise,
    );
    fixture.hello.features.methods.push("system.info");
    fixture.update();
    fixture.context.gateway.snapshot.client = createTestGatewayClient((method) =>
      method === "projects.list" ? Promise.resolve({ projects: [] }) : newName.promise,
    );
    fixture.update();
    oldName.resolve({ machineName: "Retired Gateway" });
    // Flush the retired request's promise continuations before checking the active owner.
    await nextTask();
    expect(fixture.gateway.gatewayName).toBe("");
    newName.resolve({ machineName: "Active Gateway" });
    await waitForFast(() => expect(fixture.gateway.gatewayName).toBe("Active Gateway"));
  });

  it.each([
    [true, { machineName: "Gateway B" }, "Gateway B", "operator.read"],
    [false, { machineName: "Hidden Gateway" }, "", "operator.read"],
    [true, { hostname: "host.example" }, "host", "operator.read"],
    [true, null, "", "operator.read"],
    [true, { machineName: "Private Gateway" }, "", "operator.sessions.read"],
  ] as const)(
    "settles name discovery (advertised: %s, response: %j)",
    async (advertised, response, name, scope) => {
      const pending = createDeferred<typeof response>();
      let current: typeof response | Promise<typeof response> = { machineName: "Current Gateway" };
      const request = vi.fn(async (method: string) => {
        if (method === "projects.list") {
          return { projects: [] };
        }
        const result = await current;
        if (!result) {
          throw new Error("System info unavailable");
        }
        return result;
      });
      const fixture = createBrowser(request);
      fixture.hello.features.methods.push("system.info");
      fixture.update();
      await waitForFast(() => expect(fixture.gateway.gatewayName).toBe("Current Gateway"));
      current = pending.promise;
      fixture.context.gateway.snapshot.phase = "reconnecting";
      fixture.update();
      expect(fixture.gateway.gatewayName).toBe("");
      fixture.hello.features.methods = advertised ? ["system.info"] : [];
      fixture.hello.auth.scopes = [scope];
      fixture.context.gateway.snapshot.phase = "connected";
      fixture.update();
      expect(fixture.gateway.gatewayName).toBe("");
      pending.resolve(response);
      await nextTask();
      await waitForFast(() => expect(fixture.gateway.gatewayName).toBe(name));
      expect(calls(request, "system.info")).toBe(advertised && scope === "operator.read" ? 2 : 1);
    },
  );

  it("keeps group route defaults isolated from ordinary New Session preferences", async () => {
    replaceBrowserPreference("ws://gateway.example", "main", {
      folder: "/workspace/ordinary",
      worktree: true,
    });
    const { gateway } = createBrowser(async () => ({}), {
      agentId: "main",
      requestedAgentId: "main",
      catalogId: "",
      group: "Client",
      groupStatus: "resolved",
      groupCwd: "/workspace/client",
      groupWorktree: false,
      catalogLabel: "",
      startTerminal: false,
    });

    expect(gateway.readPreference("main")).toBeNull();
    await gateway.persistPreference("main", "/workspace", {
      folder: "/workspace/client",
      worktree: false,
    });
    expect(loadNewSessionPreference("ws://gateway.example", "main")).toEqual({
      folder: "/workspace/ordinary",
      worktree: true,
      freshWorkspace: false,
    });
  });
});
