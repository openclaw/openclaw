import { describe, expect, it, onTestFinished, vi } from "vitest";
import type { WorktreesBranchesResult } from "../../../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import type { GatewayAgentRow } from "../../api/types.ts";
import { settleModelCatalogRequests } from "../../lib/model-catalog-store.ts";
import type { DraftCloudProfile } from "./discovery.ts";
import { DraftCloudMachineState } from "./draft-cloud-machine-state.ts";
import { buildSelectedSessionCreateParams } from "./draft-create-params.ts";
import { createRepositoryFixture } from "./draft-place-state.test-support.ts";
import type { NewSessionRouteData } from "./location.ts";
import { renderControl } from "./model-control.test-support.ts";
import type { NewSessionPreference } from "./preferences.ts";

const REMOTE_PROJECT = {
  identity: "openclaw/openclaw",
  cloneUrl: "https://github.com/openclaw/openclaw.git",
  defaultBranch: "main",
};
const GIT: WorktreesBranchesResult = {
  repositoryStatus: "git",
  branches: [],
  defaultBranch: "main",
};
type Place = ReturnType<typeof createRepositoryFixture>["state"];
function nextChange(
  changed: ReturnType<typeof createRepositoryFixture>["changed"],
  ready: () => boolean,
) {
  const published = createDeferred();
  changed.mockImplementation(() => {
    if (ready()) {
      published.resolve();
    }
  });
  return published.promise;
}
const routeData = (overrides: Partial<NewSessionRouteData>): NewSessionRouteData => ({
  agentId: "main",
  requestedAgentId: "main",
  catalogId: "",
  catalogLabel: "",
  startTerminal: false,
  ...overrides,
});
const models = (...ids: string[]) =>
  ids.map((id) => ({
    id,
    provider: "example",
    name: id,
    available: true,
  }));
const repositoryReady = (state: Place, kind = "git") =>
  vi.waitFor(() => expect(state.repository.kind).toBe(kind));
const emptyWorkspace = {
  agentId: "main",
  message: "",
  titleSource: "Start empty",
  worktree: true,
  worktreeSource: "empty",
};

function createParams(state: Place, message = "") {
  return buildSelectedSessionCreateParams(state, { message, visibility: "normal" });
}

function pendingRepository(preference: NewSessionPreference) {
  const fixture = createRepositoryFixture({ workspaceGit: true });
  const discovery = createDeferred<WorktreesBranchesResult>();
  fixture.request.mockReturnValue(discovery.promise);
  fixture.readPreference.mockReturnValue(preference);
  return { ...fixture, discovery };
}

function machineProfile(id = "aws", machines = ["standard", "fast"]): DraftCloudProfile {
  return {
    id,
    providerId: "crabbox",
    machines: machines.map((name, index) => ({
      id: name,
      label: name[0]!.toUpperCase() + name.slice(1),
      ...(index === 0 ? { default: true } : {}),
    })),
  };
}

describe("DraftPlaceState repository selection", () => {
  it.each([
    { source: "registered", redacted: false, current: false, savedWorktree: false },
    { source: "registered", redacted: true, current: false, savedWorktree: false },
    { source: "workspace", redacted: true, current: true, savedWorktree: true },
  ] as const)(
    "restores permitted $source checkout (redacted=$redacted)",
    async ({ source, redacted, current, savedWorktree }) => {
      const f = createRepositoryFixture({
        models: models("first", "selected").map((model) =>
          Object.assign(model, {
            reasoning: true,
            thinkingLevels: [{ id: "high", label: "High" }],
          }),
        ),
      });
      onTestFinished(() => f.state.modelControl.reset());
      const eligibility = createDeferred<{ current: boolean; worktree: boolean }>();
      const projectId = source === "workspace" ? "workspace:main" : "registered";
      const project = {
        id: projectId,
        displayName: "Selected Project",
        source,
        ...(redacted ? {} : { repoRoot: "/project" }),
      };
      vi.spyOn(f.browser, "projects", "get").mockReturnValue([project]);
      vi.spyOn(f.browser, "projectsReady", "get").mockReturnValue(true);
      f.readPreference.mockReturnValue({ projectId, worktree: savedWorktree });
      f.request.mockImplementation(async (method) =>
        method === "projects.checkoutOptions"
          ? eligibility.promise
          : { repositoryStatus: "git", branches: [] },
      );
      const settled = nextChange(f.changed, () => f.state.worktree && f.state.worktreeAvailable());
      f.state.adoptAgentDefaults();
      f.state.restorePreferenceSelections();
      await settleModelCatalogRequests(f.context.gateway.snapshot.client!, { agentId: "main" });
      f.state.modelControl.selectModel("example/selected");
      f.state.modelControl.thinkingLevel = "high";
      expect(f.state.folderSubmissionBlocked()).toBe(true);
      eligibility.resolve({ current, worktree: true });
      await settled;
      expect(f.state).toMatchObject({
        worktree: true,
        currentCheckoutUnavailableReason: current
          ? undefined
          : "Use an isolated worktree for this project and agent",
      });
      expect(f.state.folderSubmissionBlocked()).toBe(false);
      if (!current) {
        f.state.selectWorktree(false);
        expect(f.state.worktree).toBe(true);
      }
      expect(createParams(f.state, "Keep my prompt")).toMatchObject({
        projectId,
        worktree: true,
        message: "Keep my prompt",
        model: "example/selected",
        thinkingLevel: "high",
      });
    },
  );

  it("preserves a valid checkout choice and retires an older project's eligibility", async () => {
    const f = createRepositoryFixture();
    const old = createDeferred<{ current: boolean; worktree: boolean }>();
    const projects = ["old", "current"].map((id) => ({
      id,
      displayName: id,
      source: "registered" as const,
    }));
    vi.spyOn(f.browser, "projects", "get").mockReturnValue(projects);
    f.readPreference.mockReturnValue({ worktree: false });
    f.state.adoptAgentDefaults();
    f.request.mockImplementation((_method, params) =>
      params?.projectId === "old"
        ? old.promise
        : Promise.resolve({ current: true, worktree: true }),
    );
    const settled = nextChange(
      f.changed,
      () => f.browser.projectId === "current" && !f.state.folderSubmissionBlocked(),
    );
    f.state.selectProjectId("old");
    f.state.selectProjectId("current");
    await settled;
    expect(f.state).toMatchObject({ worktree: false, currentCheckoutUnavailableReason: undefined });
    old.resolve({ current: false, worktree: true });
    await old.promise;
    expect(f.browser.projectId).toBe("current");
    expect(f.state.worktree).toBe(false);
    f.state.selectWorktree(true);
    f.state.selectProjectId("current");
    expect(f.state.worktree).toBe(true);
  });

  it.each(["restored", "selected"])("retires %s repository on host change", (selection) => {
    const f = createRepositoryFixture();
    let host = "a.ghe.example.test";
    vi.spyOn(f.browser, "projectsReady", "get").mockReturnValue(true);
    vi.spyOn(f.browser, "githubHost", "get").mockImplementation(() => host);
    const remote = { ...REMOTE_PROJECT, cloneUrl: "https://a.ghe.example.test/acme/private.git" };
    f.readPreference.mockReturnValue(selection === "restored" ? { remoteProject: remote } : {});
    f.state.adoptAgentDefaults();
    if (selection === "selected") {
      f.state.selectRemoteProject(remote);
    }
    f.state.restorePreferenceSelections();
    expect(f.browser.remoteProject).toEqual(remote);
    f.state.setBaseRef("retired-host-branch");
    f.state.setWorktreeName("retired-host-task");
    host = "b.ghe.example.test";
    f.state.restorePreferenceSelections();
    expect(f.browser.remoteProject).toBeNull();
    expect(f.state.remoteRepository).toBeUndefined();
    expect(f.state).toMatchObject({ baseRef: "", worktreeName: "" });
    expect(f.persistPreference).toHaveBeenCalledWith("main", "/workspace", {
      baseRef: "",
      worktreeName: "",
    });
    expect(f.persistPreference).toHaveBeenCalledWith(
      "main",
      "/workspace",
      expect.objectContaining({ remoteProject: null }),
    );
  });

  it("remembers a remote project and restores its default branch", () => {
    const selected = createRepositoryFixture();
    selected.state.selectRemoteProject(REMOTE_PROJECT);
    expect(selected.persistPreference).toHaveBeenCalledWith(
      "",
      "/workspace",
      expect.objectContaining({ projectId: "", remoteProject: REMOTE_PROJECT }),
    );
    expect(selected.state.baseRef).toBe("main");

    const restored = createRepositoryFixture();
    vi.spyOn(restored.browser, "projectsReady", "get").mockReturnValue(true);
    restored.readPreference.mockReturnValue({
      remoteProject: REMOTE_PROJECT,
      baseRef: "main",
      where: { kind: "cloud", id: "aws" },
    });
    restored.state.adoptAgentDefaults();
    restored.state.restorePreferenceSelections();

    expect(restored.browser.remoteProject).toEqual(REMOTE_PROJECT);
    expect(restored.state).toMatchObject({ baseRef: "main", cloudProfileId: "aws" });
    expect(restored.state.remoteRepository).toEqual({ url: REMOTE_PROJECT.cloneUrl, ref: "main" });
    expect(restored.state.placementPreferenceReady).toBe(true);
  });

  it("leaves the worktree base to the Gateway unless a branch was selected", async () => {
    const { state, request, changed } = createRepositoryFixture({ workspaceGit: true });
    request.mockResolvedValue({
      repositoryStatus: "git",
      branches: [{ name: "main", kind: "local" }],
      defaultBranch: "main",
      headBranch: "old-feature",
    });
    const discovered = nextChange(changed, () => state.repository.kind === "git");
    state.adoptAgentDefaults();
    await discovered;
    const create = () => createParams(state, "new task");

    expect(create()).toMatchObject({ worktree: true });
    expect(create()).not.toHaveProperty("worktreeBaseRef");
    expect(state.preferenceSelection().baseRef).toBe("");
    state.setBaseRef("main");
    expect(create()).toHaveProperty("worktreeBaseRef", "main");
    state.setBaseRef("");
    expect(create()).not.toHaveProperty("worktreeBaseRef");
  });

  it("keeps a route-selected model in the unsent composer instead of restoring a remembered model", async () => {
    const { state, context, readPreference, persistPreference, request } = createRepositoryFixture({
      data: routeData({ requestedModel: "example/first" }),
      models: models("first", "second", "remembered"),
    });
    onTestFinished(() => state.modelControl.reset());
    readPreference.mockReturnValue({ model: "example/remembered" });
    state.adoptAgentDefaults();
    await settleModelCatalogRequests(context.gateway.snapshot.client!, { agentId: "main" });
    const view = renderControl(state.modelControl, context, "main", state.selectedAgent());
    expect(state.modelControl.modelForSubmission()).toBe("example/first");
    expect(createParams(state).model).toBe("example/first");
    expect(persistPreference).not.toHaveBeenCalled();

    const choice = view.querySelector<HTMLButtonElement>(
      '[data-chat-model-option="example/second"]',
    );
    expect(choice).not.toBeNull();
    choice!.click();
    expect(state.modelControl.modelForSubmission()).toBe("example/second");
    state.modelControl.load(context, "main", true, { agent: state.selectedAgent() });
    state.adoptAgentDefaults();
    expect(state.modelControl.modelForSubmission()).toBe("example/second");
    state.modelControl.invalidate();
    state.adoptAgentDefaults();
    await settleModelCatalogRequests(context.gateway.snapshot.client!, { agentId: "main" });
    expect(state.modelControl.modelForSubmission()).toBe("example/second");
    Object.assign(context.gateway.snapshot, { hello: { ...context.gateway.snapshot.hello } });
    state.invalidateGatewayDiscovery(false);
    state.adoptAgentDefaults();
    await settleModelCatalogRequests(context.gateway.snapshot.client!, { agentId: "main" });
    expect(state.modelControl.modelForSubmission()).toBe("example/second");
    expect(persistPreference).toHaveBeenCalledExactlyOnceWith(
      "main",
      "/workspace",
      expect.objectContaining({ model: "example/second" }),
    );
    context.agents.state.agentsList!.agents.push({ id: "scout", workspace: "/workspace" });
    readPreference.mockImplementation(() => ({
      model: state.agentId === "main" ? "example/second" : "example/remembered",
    }));
    const selectAgent = async (agentId: string, model: string) => {
      state.selectAgentId(agentId);
      await settleModelCatalogRequests(context.gateway.snapshot.client!, { agentId });
      expect(state.modelControl.modelForSubmission()).toBe(model);
    };
    await selectAgent("scout", "example/remembered");
    await selectAgent("main", "example/second");
    expect(state.modelControl.modelForSubmission()).toBe("example/second");
    state.resetDraft();
    state.adoptAgentDefaults();
    await settleModelCatalogRequests(context.gateway.snapshot.client!, { agentId: "main" });
    expect(state.modelControl.modelForSubmission()).toBe("example/first");

    expect(
      request.mock.calls.some(([method]) => method === "sessions.create" || method === "chat.send"),
    ).toBe(false);
  });

  it("captures pending placement preferences instead of transient discovery defaults", () => {
    const { state, discovery } = pendingRepository({
      worktree: true,
      where: { kind: "device", id: "desktop" },
      projectId: "pending-project",
      baseRef: "release/next",
    });
    state.adoptAgentDefaults();
    expect(state).toMatchObject({ placementPreferenceReady: false, worktree: false });
    expect(state.preferenceSelection()).toMatchObject({
      worktree: true,
      where: { kind: "device", id: "desktop" },
      projectId: "pending-project",
      baseRef: "release/next",
    });
    discovery.resolve({ repositoryStatus: "git", branches: [] });
  });

  it.each([
    { destination: "device", explicitFolder: false },
    { destination: "cloud", explicitFolder: false },
    { destination: "device", explicitFolder: true },
    { destination: "cloud", explicitFolder: true },
  ] as const)(
    "preserves $destination folder during discovery (explicit: $explicitFolder)",
    async ({ destination, explicitFolder }) => {
      const { state, request, readPreference } = createRepositoryFixture({
        workspaceGit: !explicitFolder,
      });
      const discovery = createDeferred<WorktreesBranchesResult>();
      const create = () => createParams(state, "Start empty");
      if (!explicitFolder) {
        readPreference.mockReturnValue({});
        request.mockReturnValue(discovery.promise);
      }
      state.adoptAgentDefaults();
      if (explicitFolder) {
        request.mockReturnValue(discovery.promise);
        state.applyFolder("/chosen/project");
      }
      expect(state.repository.kind).toBe("checking");
      if (destination === "device") {
        state.selectDevice("desktop");
      } else {
        state.selectCloudProfile("aws");
      }

      expect(state.freshWorkspace).toBe(!explicitFolder);
      if (explicitFolder) {
        expect(state).toMatchObject({ remotePlacement: true, folder: "/chosen/project" });
      } else {
        expect(state.placementPreferenceReady).toBe(true);
        expect(create()).toEqual(emptyWorkspace);
      }
      discovery.resolve({
        repositoryStatus: explicitFolder ? "not_git" : "git",
        branches: [],
        ...(!explicitFolder ? { defaultBranch: "main" } : {}),
      });
      await repositoryReady(state, explicitFolder ? "direct" : "git");
      expect(state.freshWorkspace).toBe(!explicitFolder);
      if (explicitFolder) {
        state.selectNewWorkspace();
        expect(state.freshWorkspace).toBe(true);
        expect(create()).toMatchObject({ worktree: true, worktreeSource: "empty" });
        expect(create()).not.toHaveProperty("cwd");
      } else {
        expect(create()).not.toHaveProperty("worktreeBaseRef");
      }
    },
  );

  it("restores an explicit empty workspace across reconnect without waiting for Git", () => {
    const { state } = pendingRepository({
      freshWorkspace: true,
      where: { kind: "cloud", id: "aws" },
      worktree: true,
    });
    state.adoptAgentDefaults();
    state.restorePreferenceSelections();
    expect(state).toMatchObject({ freshWorkspace: true, placementPreferenceReady: true });

    state.invalidateGatewayDiscovery(false);
    state.adoptAgentDefaults();
    state.restorePreferenceSelections();
    expect(state.repository.kind).toBe("checking");
    expect(state).toMatchObject({ freshWorkspace: true, placementPreferenceReady: true });
  });

  it.each(["device", "cloud"] as const)(
    "keeps legacy %s worktree until explicit New workspace",
    async (destination) => {
      const { state, discovery } = pendingRepository({
        workspace: "/workspace",
        folder: "/workspace",
        where:
          destination === "device"
            ? { kind: "device", id: "desktop" }
            : { kind: "cloud", id: "aws" },
        worktree: true,
        baseRef: "release",
        worktreeName: "saved-task",
      });

      state.adoptAgentDefaults();
      state.restorePreferenceSelections();
      expect(state).toMatchObject({ remotePlacement: true, freshWorkspace: false, worktree: true });
      expect(state.worktreeAvailable()).toBe(false);
      expect(state).toMatchObject({ baseRef: "release", worktreeName: "saved-task" });

      state.selectNewWorkspace();
      expect(state).toMatchObject({ freshWorkspace: true, placementPreferenceReady: true });
      discovery.resolve({ repositoryStatus: "git", branches: [], defaultBranch: "main" });
      await repositoryReady(state);
      expect(createParams(state, "Start empty")).toEqual(emptyWorkspace);
    },
  );

  it.each(["local", "device", "cloud"] as const)(
    "closes Auto and clears it on %s selection",
    (destination) => {
      const { state, browser } = createRepositoryFixture();
      onTestFinished(() => browser.disconnect());
      state.selectRemoteProject(REMOTE_PROJECT);
      browser.popoverCallbacks("where").onPopoverShow();
      browser.changeEnvironmentQuery("runner");

      state.selectDevice("", true);
      expect(state.autoDevice).toBe(true);
      expect(browser.popoverOpen("where")).toBe(false);
      expect(browser.environmentQuery).toBe("runner");

      browser.popoverCallbacks("where").onPopoverShow();
      expect(browser.environmentQuery).toBe("");
      if (destination === "cloud") {
        state.selectCloudProfile("aws");
      } else {
        state.selectDevice(destination === "device" ? "desktop" : "");
      }
      expect(state).toMatchObject({
        autoDevice: false,
        deviceId: destination === "device" ? "desktop" : "",
        cloudProfileId: destination === "cloud" ? "aws" : "",
      });
      expect(browser.popoverOpen("where")).toBe(destination === "cloud");
    },
  );

  it.each(["git", "unavailable", "rejected"] as const)(
    "keeps edited branch through %s reconnect",
    async (result) => {
      const { state, request, persistPreference } = createRepositoryFixture({ workspaceGit: true });
      request.mockResolvedValue(GIT);
      state.adoptAgentDefaults();
      await repositoryReady(state);
      state.setBaseRef("my-branch");
      state.setWorktreeName("my-checkout");

      state.invalidateGatewayDiscovery(false);
      expect(state.baseRef).toBe("my-branch");
      const discovery = createDeferred<WorktreesBranchesResult>();
      request.mockReturnValue(discovery.promise);
      state.adoptAgentDefaults();
      expect(state.baseRef).toBe("my-branch");
      if (result === "rejected") {
        discovery.reject(new Error("Git unavailable"));
      } else {
        discovery.resolve({ ...GIT, repositoryStatus: result });
      }
      await repositoryReady(state, result === "git" ? "git" : "unavailable");
      expect(state).toMatchObject({ baseRef: "my-branch", worktreeName: "my-checkout" });

      state.invalidateGatewayDiscovery(false);
      request.mockResolvedValue(GIT);
      state.adoptAgentDefaults();
      await repositoryReady(state);
      expect(state.baseRef).toBe("my-branch");
      state.clearProjectSelection();
      await repositoryReady(state);
      expect(state.baseRef).toBe("my-branch");
      state.applyFolder("/another-repo");
      await repositoryReady(state);
      expect(state).toMatchObject({ baseRef: "", worktreeName: "" });
      expect(persistPreference).toHaveBeenCalledWith("main", "/workspace", {
        baseRef: "",
        worktreeName: "",
      });
    },
  );

  it.each([
    { arrival: "during", edited: false },
    { arrival: "during", edited: true },
    { arrival: "after", edited: true },
  ] as const)(
    "adopts $arrival-discovery preferences (edited=$edited)",
    async ({ arrival, edited }) => {
      const { state, request, readPreference } = createRepositoryFixture({ workspaceGit: true });
      const discovery = createDeferred<WorktreesBranchesResult>();
      request.mockImplementation(async (method) =>
        method === "worktrees.branches" ? discovery.promise : {},
      );
      state.adoptAgentDefaults();
      expect(state.repository.kind).toBe("checking");
      if (arrival === "after") {
        discovery.resolve(GIT);
        await repositoryReady(state);
        state.setBaseRef("my-branch");
        state.setWorktreeName("my-checkout");
      }
      readPreference.mockReturnValue({
        worktree: true,
        baseRef: arrival === "after" ? "saved-branch" : "release/next",
        ...(arrival === "after" ? { worktreeName: "saved-checkout" } : {}),
      });
      state.adoptAgentDefaults();
      if (arrival === "during") {
        if (edited) {
          state.setBaseRef("my-branch");
        }
        discovery.resolve(GIT);
        await repositoryReady(state);
        expect(
          request.mock.calls.filter(([method]) => method === "worktrees.branches"),
        ).toHaveLength(1);
      } else {
        expect(state.worktreeName).toBe("my-checkout");
      }
      expect(state.baseRef).toBe(edited ? "my-branch" : "release/next");
    },
  );

  it.each([
    { source: "cloud", unavailable: false },
    { source: "cloud", unavailable: true },
    { source: "group", unavailable: false },
    { source: "group", unavailable: true },
  ])("reconciles $source defaults (unavailable=$unavailable)", async ({ source, unavailable }) => {
    const { state, readPreference, persistPreference } = createRepositoryFixture({
      workspaceGit: unavailable,
      unavailable,
      ...(source === "group"
        ? {
            data: routeData({
              group: "Notes",
              groupStatus: "resolved",
              groupCwd: "/workspace",
              groupWorktree: true,
            }),
          }
        : {}),
    });
    if (source === "cloud") {
      readPreference.mockReturnValue({ where: { kind: "cloud", id: "aws" } });
    }
    state.adoptAgentDefaults();
    if (source === "cloud") {
      await repositoryReady(state, unavailable ? "unavailable" : "direct");
      state.restorePreferenceSelections();
      expect(state).toMatchObject({
        placementPreferenceReady: true,
        cloudProfileId: "aws",
        worktree: true,
        freshWorkspace: true,
      });
      expect(persistPreference).not.toHaveBeenCalled();
    } else {
      await vi.waitFor(() => expect(state.placementPreferenceReady).toBe(true));
      expect(state.worktree).toBe(unavailable);
      state.adoptGroupDefaults();
      expect(state).toMatchObject({ placementPreferenceReady: true, worktree: unavailable });
      expect(state.worktreeAvailable()).toBe(false);
    }
  });

  it.each([false, true])(
    "keeps unavailable workspace isolation (project: %s)",
    async (projectSelected) => {
      const { state, browser } = createRepositoryFixture({ workspaceGit: true, unavailable: true });
      if (projectSelected) {
        vi.spyOn(browser, "selectedProject").mockReturnValue({
          id: "workspace",
          displayName: "Workspace",
          repoRoot: "/workspace",
          source: "workspace",
        });
        browser.selectProject({ kind: "local", id: "workspace" });
      }

      state.adoptAgentDefaults();

      expect(state.repository.kind).toBe("checking");
      expect(state.worktreeAvailable()).toBe(false);
      await repositoryReady(state, "unavailable");
      expect(state.worktreeAvailable()).toBe(false);
      expect(state).toMatchObject({
        worktree: true,
        checkoutVisible: true,
        placementPreferenceReady: true,
      });
      expect(state.preferenceSelection().worktree).toBe(true);
      expect(state.folderSubmissionBlocked()).toBe(projectSelected);
      state.selectWorktree(false);
      expect(state.worktree).toBe(projectSelected);
      expect(state.preferenceSelection().worktree).toBe(projectSelected);
    },
  );

  it("ignores a failed saved-worktree probe after the user chooses another folder", async () => {
    const { state, request, changed } = createRepositoryFixture({ workspaceGit: true });
    const previous = createDeferred<WorktreesBranchesResult>();
    const current = Promise.resolve({ repositoryStatus: "git", branches: [] });
    const currentPublished = nextChange(changed, () => state.repository.kind === "git");
    let probes = 0;
    request.mockImplementation((method) =>
      method === "worktrees.branches" && ++probes === 1 ? previous.promise : current,
    );
    state.adoptAgentDefaults();
    state.applyFolder("/new-repo");
    await currentPublished;
    state.selectWorktree(true);

    previous.reject(new Error("old repository unavailable"));
    await previous.promise.catch(() => undefined);

    expect(state.repository).toMatchObject({ kind: "git", repoRoot: "/new-repo" });
    expect(state.worktree).toBe(true);
    expect(state.preferenceSelection()).toMatchObject({ folder: "/new-repo", worktree: true });
  });

  it.each(["local", "device", "cloud"] as const)(
    "keeps remote-project branch and checkout on %s",
    (placement) => {
      const { state, browser, persistPreference, changed, request } = createRepositoryFixture();
      state.selectRemoteProject(REMOTE_PROJECT);
      if (placement === "local") {
        expect(state.repository).toEqual({
          kind: "pending-clone",
          cloneUrl: REMOTE_PROJECT.cloneUrl,
        });
        expect(state.worktreeAvailable()).toBe(true);
        expect(state).toMatchObject({ checkoutVisible: true, worktree: false });
        state.selectWorktree(true);
        expect(state.worktree).toBe(true);
      }
      state.setBaseRef("release");
      if (placement === "local") {
        state.selectWorktree(false);
        expect(state.worktree).toBe(false);
        state.selectWorktree(true);
        expect(state.worktree).toBe(true);
      } else {
        if (placement === "device") {
          state.selectDevice("desktop");
          expect(state.deviceId).toBe("desktop");
        } else {
          state.selectCloudProfile("aws");
          expect(state.cloudProfileId).toBe("aws");
        }
        expect(browser.remoteProject).toEqual(REMOTE_PROJECT);
        expect(state.worktree).toBe(false);
        expect(state.remoteRepository).toEqual({ url: REMOTE_PROJECT.cloneUrl, ref: "release" });
      }
      expect(state.baseRef).toBe("release");
      persistPreference.mockClear();
      changed.mockClear();
      request.mockClear();
      state.selectWorktree(placement === "local");
      expect(state.worktree).toBe(placement === "local");
      expect(persistPreference).not.toHaveBeenCalled();
      expect(changed).not.toHaveBeenCalled();
      expect(request).not.toHaveBeenCalled();
    },
  );

  it.each(["/workspace", "/plain"])(
    "rejects worktree before and after non-Git %s discovery",
    async (folder) => {
      const { state, persistPreference, changed, request, readPreference } =
        createRepositoryFixture();
      const discovery = createDeferred<WorktreesBranchesResult>();
      if (folder === "/plain") {
        readPreference.mockReturnValue({ worktree: false });
      }
      state.adoptAgentDefaults();
      if (folder === "/plain") {
        request.mockReturnValue(discovery.promise);
      }
      state.applyFolder(folder);
      if (folder === "/plain") {
        expect(state.repository.kind).toBe("checking");
        state.selectWorktree(true);
        expect(state.worktree).toBe(false);
        discovery.resolve({ repositoryStatus: "not_git", branches: [] });
        await discovery.promise;
        expect(state.worktree).toBe(false);
      }
      await repositoryReady(state, "direct");
      persistPreference.mockClear();
      changed.mockClear();

      state.selectWorktree(true);

      expect(state.worktree).toBe(false);
      expect(state.worktreeAvailable()).toBe(false);
      expect(state.checkoutVisible).toBe(false);
      expect(persistPreference).not.toHaveBeenCalled();
      expect(changed).not.toHaveBeenCalled();
    },
  );

  it("does not carry cloud isolation into a local non-Git folder", () => {
    const { state, readPreference } = createRepositoryFixture();
    readPreference.mockReturnValue({ worktree: false });
    state.adoptAgentDefaults();
    expect(state.repository.kind).toBe("direct");
    state.selectCloudProfile("aws");
    expect(state).toMatchObject({ freshWorkspace: true, worktree: true, checkoutVisible: false });
    state.applyFolder("/workspace");
    expect(state).toMatchObject({ freshWorkspace: false, checkoutVisible: false });

    state.clearCloudProfile();

    expect(state).toMatchObject({ worktree: false, checkoutVisible: false });
    expect(state.preferenceSelection().worktree).toBe(false);
    expect(createParams(state, "notes")).not.toHaveProperty("worktree");
  });

  it.each([
    { kind: "cloud", id: "aws" },
    { kind: "device", id: "desktop" },
    { kind: "auto-device" },
  ] as const)("does not restore $kind isolation as a local checkout choice", async (where) => {
    const { state, readPreference, changed } = createRepositoryFixture({
      workspaceGit: true,
      unavailable: true,
    });
    const discovered = nextChange(changed, () => state.repository.kind === "unavailable");
    readPreference.mockReturnValue({ where, worktree: true, worktreeName: "remote-task" });
    state.adoptAgentDefaults();
    await discovered;
    state.restorePreferenceSelections();
    expect(state.worktree).toBe(true);
    expect(state.preferenceSelection().worktree).toBe(true);

    state.selectDevice("");

    expect(state.worktree).toBe(false);
    expect(state.preferenceSelection().worktree).toBe(false);
    expect(createParams(state, "notes")).not.toHaveProperty("worktree");
  });

  it("restores a preferred worktree when a remote project awaits cloning", () => {
    const { state, browser } = createRepositoryFixture();
    browser.selectProject({ kind: "remote", project: REMOTE_PROJECT });

    state.adoptAgentDefaults();

    expect(state).toMatchObject({ worktree: true, placementPreferenceReady: true });
  });
});

describe("DraftPlaceState cloud machine selection", () => {
  it("couples class selection to OS while retaining each profile's overrides", () => {
    const state = new DraftCloudMachineState();
    const profiles: DraftCloudProfile[] = [
      {
        id: "aws",
        providerId: "crabbox",
        operatingSystems: [
          { id: "linux", label: "Linux", default: true },
          { id: "windows/wsl2", label: "Windows (WSL2)" },
          { id: "macos", label: "macOS", disabledReason: "Upgrade the worker provider." },
        ],
        machines: [
          { id: "tiny", label: "Tiny Linux", os: "linux", default: true },
          { id: "fast", label: "Fast Linux", os: "linux" },
          { id: "tiny", label: "Tiny Windows", os: "windows/wsl2", default: true },
          { id: "large", label: "Large Windows", os: "windows/wsl2" },
          { id: "custom", label: "Custom" },
        ],
      },
    ];
    expect(state.select("aws", "large", profiles)).toBe(false);
    state.select("aws", "fast", profiles);
    state.selectOs("aws", "windows/wsl2", profiles);
    expect(state.resolve("aws")).toBe("");
    expect(state.resolveOs("aws")).toBe("windows/wsl2");
    expect(state.machines(profiles[0]!).map((machine) => machine.label)).toEqual([
      "Tiny Windows",
      "Large Windows",
      "Custom",
    ]);
    state.select("aws", "large", profiles);
    state.select("aws", "tiny", profiles);
    expect(state.resolve("aws")).toBe("tiny");
    expect(state.resolveOs("aws")).toBe("windows/wsl2");
    state.select("aws", "custom", profiles);
    state.selectOs("aws", "linux", profiles);
    expect(state.resolve("aws")).toBe("custom");
    expect(state.resolveOs("aws")).toBe("linux");
    state.applyPending("other", "large", "other-os");
    expect(state.resolve("aws")).toBe("custom");
    expect(state.resolveOs("other")).toBe("other-os");
    expect(state.selectOs("aws", "windows/wsl2", profiles, true)).toBe(false);
    expect(state.selectOs("aws", "macos", profiles)).toBe(false);
    expect(state.resolveOs("aws")).toBe("linux");
  });

  it("submits each profile's displayed machine and retains selections per destination", () => {
    const cloudProfiles = [machineProfile(), machineProfile("hetzner", ["large", "beast"])];
    const { state, changed } = createRepositoryFixture({ cloudProfiles });

    state.applyPendingPlacement({ agentId: "main", profileId: "aws" });
    expect(state.cloudSelection.machineClass).toBe("standard");

    state.cloudMachines.select("aws", "fast", cloudProfiles);
    expect(state.cloudSelection.machineClass).toBe("fast");

    vi.spyOn(state, "worktreeAvailable").mockReturnValue(true);
    state.selectCloudProfile("hetzner");
    expect(state.cloudSelection.machineClass).toBe("large");
    state.cloudMachines.select("hetzner", "beast", cloudProfiles);
    expect(state.cloudSelection.machineClass).toBe("beast");

    state.selectCloudProfile("aws");
    expect(state.cloudSelection.machineClass).toBe("fast");
    state.cloudMachines.select("aws", "standard", cloudProfiles);
    expect(state.cloudSelection.machineClass).toBe("standard");
    expect(changed).toHaveBeenCalled();
  });

  it("restores the exact recovered choice instead of retaining a stale draft override", () => {
    const cloudProfiles = [machineProfile()];
    const { state } = createRepositoryFixture({ cloudProfiles });

    state.applyPendingPlacement({ agentId: "main", profileId: "aws", machineClass: "fast" });
    expect(state.cloudSelection.machineClass).toBe("fast");

    cloudProfiles.splice(0, cloudProfiles.length, { id: "aws", providerId: "crabbox" });
    expect(state.cloudSelection.machineClass).toBe("fast");

    state.applyPendingPlacement({ agentId: "main", profileId: "aws" });
    expect(state.cloudSelection.machineClass).toBe("");
  });

  it.each([false, true])(
    "retains an incompatible cloud choice (user-selected: %s)",
    (selectedByUser) => {
      const cloudProfiles = [{ ...machineProfile(), executionModes: ["worker-turn"] as const }];
      const { state, persistPreference } = createRepositoryFixture({ cloudProfiles });
      const resolveRuntime = vi.spyOn(state.modelControl, "resolveAgentRuntime");
      resolveRuntime.mockReturnValue({
        id: "openclaw",
        cloudPlacementSupported: true,
        cloudPlacementExecutionMode: "worker-turn",
        source: "model",
      });
      if (selectedByUser) {
        vi.spyOn(state, "isAdmin").mockReturnValue(true);
        vi.spyOn(state, "worktreeAvailable").mockReturnValue(true);
        state.selectCloudProfile("aws");
        state.cloudMachines.select("aws", "fast", cloudProfiles);
        persistPreference.mockClear();
      } else {
        state.applyPendingPlacement({ agentId: "main", profileId: "aws", machineClass: "fast" });
      }
      state.restorePreferenceSelections();
      expect(state.cloudProfileId).toBe("aws");
      expect(state.cloudSelection.machineClass).toBe("fast");

      resolveRuntime.mockReturnValue({
        id: "codex",
        cloudPlacementSupported: true,
        cloudPlacementExecutionMode: "remote-exec",
        source: "model",
      });
      state.restorePreferenceSelections();

      expect(state.cloudProfileId).toBe("aws");
      expect(state.cloudSelection.machineClass).toBe("fast");
      expect(state.worktree).toBe(true);
      expect(persistPreference).not.toHaveBeenCalled();
    },
  );
});

describe("device folder selection", () => {
  const workerRuntime: NonNullable<GatewayAgentRow["agentRuntime"]> = {
    id: "openclaw",
    cloudPlacementExecutionMode: "worker-turn",
    devicePlacement: { requiredNodeCommands: [], consumesWorkerSlot: true },
    source: "model",
  };

  function folderFixture() {
    const f = createRepositoryFixture();
    f.context.agents.state.agentsList!.agents[0]!.agentRuntime = workerRuntime;
    return f;
  }

  it.each(["remote-exec", undefined] as const)(
    "rejects existing device folder in execution mode %s",
    (mode) => {
      const f = folderFixture();
      f.context.agents.state.agentsList!.agents[0]!.agentRuntime = {
        ...workerRuntime,
        cloudPlacementExecutionMode: mode,
      };
      f.gateway.environments![0]!.workerHost = { deviceFolders: true };
      f.state.adoptAgentDefaults();
      f.state.selectDevice("desktop");
      expect(f.state.devicePlacement().ready).toBe(true);
      expect(f.state.deviceFolderAvailable).toBe(false);
      f.state.selectDeviceFolder();
      expect(f.state.deviceFolder).toBeUndefined();
    },
  );

  it("requires an explicit capable device and keeps its path out of Gateway discovery", () => {
    const f = folderFixture();
    f.state.adoptAgentDefaults();
    f.state.selectDevice("desktop");
    expect(f.state.deviceFolderAvailable).toBe(false);
    f.state.selectDeviceFolder();
    expect(f.state.deviceFolder).toBeUndefined();
    f.gateway.environments![0]!.workerHost = { deviceFolders: true };
    expect(f.state.deviceFolderAvailable).toBe(true);
    f.state.selectDeviceFolder();
    expect(f.state.folderSubmissionBlocked()).toBe(true);
    f.request.mockClear();
    f.persistPreference.mockClear();
    f.state.setDeviceFolderPath("relative");
    expect(f.state.folderSubmissionBlocked()).toBe(true);
    f.state.setDeviceFolderPath("/srv/existing project");
    expect(f.state.folderSubmissionBlocked()).toBe(false);
    expect(f.state).toMatchObject({ worktree: false, checkoutVisible: false });
    expect(f.request).not.toHaveBeenCalled();
    expect(f.persistPreference).not.toHaveBeenCalled();
    expect(createParams(f.state, "hello")).toMatchObject({
      deviceFolder: { deviceId: "desktop", path: "/srv/existing project" },
    });
    f.state.selectDevice("", true);
    expect(f.state).toMatchObject({ deviceFolderAvailable: false, deviceFolder: undefined });
  });

  it("blocks a selected device folder when current capability is withdrawn", () => {
    const f = folderFixture();
    f.gateway.environments![0]!.workerHost = { deviceFolders: true };
    f.state.adoptAgentDefaults();
    f.state.selectDevice("desktop");
    f.state.selectDeviceFolder();
    f.state.setDeviceFolderPath("/srv/project");
    f.gateway.environments![0]!.workerHost = {};
    expect(f.state.folderSubmissionBlocked()).toBe(true);
    expect(f.state.deviceFolder).toEqual({ deviceId: "desktop", path: "/srv/project" });
    f.state.selectNewWorkspace();
    expect(f.state).toMatchObject({ deviceFolder: undefined, freshWorkspace: true });
  });
});
