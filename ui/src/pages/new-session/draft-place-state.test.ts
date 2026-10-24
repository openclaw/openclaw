import { describe, expect, it, onTestFinished, vi } from "vitest";
import type { WorktreesBranchesResult } from "../../../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import { GatewayRequestError } from "../../api/gateway.ts";
import type { GatewayAgentRow } from "../../api/types.ts";
import { loadModelCatalog } from "../../lib/model-catalog-store.ts";
import type { DraftCloudProfile } from "./discovery.ts";
import { DraftCloudMachineState } from "./draft-cloud-machine-state.ts";
import { buildSelectedSessionCreateParams } from "./draft-create-params.ts";
import { createRepositoryFixture } from "./draft-place-state.test-support.ts";
import type { NewSessionRouteData } from "./location.ts";
import { waitForModelControl } from "./model-control.test-support.ts";
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

function selectDestination(state: Place, destination: "local" | "device" | "cloud") {
  if (destination === "cloud") {
    state.selectCloudProfile("aws");
  } else {
    state.selectDevice(destination === "device" ? "desktop" : "");
  }
}

function pendingRepository(preference: NewSessionPreference) {
  const fixture = createRepositoryFixture({ workspaceGit: true });
  const discovery = createDeferred<WorktreesBranchesResult>();
  fixture.request.mockReturnValue(discovery.promise);
  fixture.readPreference.mockReturnValue(preference);
  return { ...fixture, discovery };
}

const cloudProfile: DraftCloudProfile = {
  id: "aws",
  providerId: "crabbox",
  machines: [{ id: "fast", label: "Fast" }],
};

describe("DraftPlaceState repository selection", () => {
  it.each([
    { source: "registered", redacted: false, current: false, savedWorktree: false },
    { source: "registered", redacted: true, current: false, savedWorktree: false },
    { source: "workspace", redacted: true, current: true, savedWorktree: true },
  ] as const)(
    "restores permitted $source checkout (redacted=$redacted)",
    async ({ source, redacted, current, savedWorktree }) => {
      const f = createRepositoryFixture();
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

  it("retires a restored repository on host change", () => {
    const f = createRepositoryFixture();
    let host = "a.ghe.example.test";
    vi.spyOn(f.browser, "projectsReady", "get").mockReturnValue(true);
    vi.spyOn(f.browser, "githubHost", "get").mockImplementation(() => host);
    const remote = { ...REMOTE_PROJECT, cloneUrl: "https://a.ghe.example.test/acme/private.git" };
    f.readPreference.mockReturnValue({ remoteProject: remote });
    f.state.adoptAgentDefaults();
    f.state.restorePreferenceSelections();
    expect(f.browser.remoteProject).toEqual(remote);
    f.state.setBaseRef("retired-host-branch");
    f.state.setWorktreeName("retired-host-task");
    host = "b.ghe.example.test";
    f.state.restorePreferenceSelections();
    expect(f.browser.remoteProject).toBeNull();
    expect(f.state.remoteRepository).toBeUndefined();
    expect(f.state).toMatchObject({ baseRef: "", worktreeName: "" });
  });

  it("remembers a remote project and restores its default branch", () => {
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

  it("keeps a route-selected model in the unsent composer instead of restoring a remembered model", async () => {
    // This test owns draft selection; settle lazy code loading before the interaction deadline.
    await import("../chat/components/chat-model-picker-panel.tsx");
    const { state, context, readPreference, persistPreference, request } = createRepositoryFixture({
      data: routeData({ requestedModel: "example/first" }),
      models: models("first", "second", "remembered"),
    });
    onTestFinished(() => state.modelControl.reset());
    readPreference.mockReturnValue({ model: "example/remembered" });
    state.adoptAgentDefaults();
    await loadModelCatalog(context.gateway.snapshot.client!, { agentId: "main" });
    const view = await waitForModelControl(
      state.modelControl,
      context,
      "main",
      state.selectedAgent(),
    );
    expect(state.modelControl.modelForSubmission()).toBe("example/first");
    expect(createParams(state).model).toBe("example/first");
    expect(persistPreference).not.toHaveBeenCalled();

    const choice = await vi.waitFor(() => {
      const option = view.querySelector<HTMLButtonElement>(
        '[data-chat-model-option="example/second"]',
      );
      expect(option).not.toBeNull();
      return option!;
    });
    choice.click();
    expect(state.modelControl.modelForSubmission()).toBe("example/second");
    state.modelControl.load(context, "main", true, { agent: state.selectedAgent() });
    state.adoptAgentDefaults();
    expect(state.modelControl.modelForSubmission()).toBe("example/second");
    state.modelControl.invalidate();
    state.adoptAgentDefaults();
    await loadModelCatalog(context.gateway.snapshot.client!, { agentId: "main" });
    expect(state.modelControl.modelForSubmission()).toBe("example/second");
    Object.assign(context.gateway.snapshot, { hello: { ...context.gateway.snapshot.hello } });
    state.invalidateGatewayDiscovery(false);
    state.adoptAgentDefaults();
    await loadModelCatalog(context.gateway.snapshot.client!, { agentId: "main" });
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
      await vi.waitFor(() => expect(state.modelControl.modelForSubmission()).toBe(model));
    };
    await selectAgent("scout", "example/remembered");
    await selectAgent("main", "example/second");
    expect(state.modelControl.modelForSubmission()).toBe("example/second");
    state.resetDraft();
    state.adoptAgentDefaults();
    await loadModelCatalog(context.gateway.snapshot.client!, { agentId: "main" });
    expect(state.modelControl.modelForSubmission()).toBe("example/first");

    expect(
      request.mock.calls.some(([method]) => method === "sessions.create" || method === "chat.send"),
    ).toBe(false);
  });

  it("captures pending placement preferences instead of transient discovery defaults", () => {
    const preference = {
      worktree: true,
      where: { kind: "device" as const, id: "desktop" },
      projectId: "pending-project",
      baseRef: "release/next",
    };
    const { state, discovery } = pendingRepository(preference);
    state.adoptAgentDefaults();
    expect(state).toMatchObject({ placementPreferenceReady: false, worktree: false });
    expect(state.preferenceSelection()).toMatchObject(preference);
    discovery.resolve(GIT);
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
      selectDestination(state, destination);

      expect(state).toMatchObject({
        freshWorkspace: !explicitFolder,
        remotePlacement: true,
        folder: explicitFolder ? "/chosen/project" : "/workspace",
      });
      if (!explicitFolder) {
        expect(state.placementPreferenceReady).toBe(true);
        expect(createParams(state, "Start empty")).toEqual(emptyWorkspace);
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
        expect(createParams(state, "Start empty")).toEqual(emptyWorkspace);
      } else {
        expect(createParams(state, "Start empty")).not.toHaveProperty("worktreeBaseRef");
      }
    },
  );

  it.each([
    { destination: "cloud", freshWorkspace: true },
    { destination: "cloud", freshWorkspace: false },
    { destination: "device", freshWorkspace: false },
  ] as const)(
    "restores $destination workspace intent through discovery (fresh=$freshWorkspace)",
    async ({ destination, freshWorkspace }) => {
      const { state, discovery } = pendingRepository({
        where:
          destination === "device"
            ? { kind: "device", id: "desktop" }
            : { kind: "cloud", id: "aws" },
        worktree: true,
        ...(freshWorkspace
          ? { freshWorkspace: true }
          : {
              workspace: "/workspace",
              folder: "/workspace",
              baseRef: "release",
              worktreeName: "saved-task",
            }),
      });

      state.adoptAgentDefaults();
      state.restorePreferenceSelections();
      if (freshWorkspace) {
        expect(state).toMatchObject({ freshWorkspace: true, placementPreferenceReady: true });
        state.invalidateGatewayDiscovery(false);
        state.adoptAgentDefaults();
        state.restorePreferenceSelections();
        expect(state.repository.kind).toBe("checking");
      } else {
        expect(state).toMatchObject({
          remotePlacement: true,
          freshWorkspace: false,
          worktree: true,
          baseRef: "release",
          worktreeName: "saved-task",
        });
        expect(state.worktreeAvailable()).toBe(false);
        state.selectNewWorkspace();
      }
      expect(state).toMatchObject({ freshWorkspace: true, placementPreferenceReady: true });
      discovery.resolve(GIT);
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
      state.selectDevice("", true);
      expect(state.autoDevice).toBe(true);
      expect(browser.popoverOpen("where")).toBe(false);
      browser.popoverCallbacks("where").onPopoverShow();
      selectDestination(state, destination);
      expect(state).toMatchObject({
        autoDevice: false,
        deviceId: destination === "device" ? "desktop" : "",
        cloudProfileId: destination === "cloud" ? "aws" : "",
      });
      expect(browser.popoverOpen("where")).toBe(destination === "cloud");
    },
  );

  it.each(["git", "unavailable", "rejected", "forbidden"] as const)(
    "keeps edited branch through %s reconnect",
    async (result) => {
      const { state, request, readPreference } = createRepositoryFixture({
        workspaceGit: true,
      });
      readPreference.mockReturnValue({ worktree: false });
      request.mockResolvedValue(GIT);
      state.adoptAgentDefaults();
      await repositoryReady(state);
      state.selectWorktree(true);
      state.setBaseRef("my-branch");
      state.setWorktreeName("my-checkout");

      state.invalidateGatewayDiscovery(false);
      const discovery = createDeferred<WorktreesBranchesResult>();
      request.mockReturnValue(discovery.promise);
      state.adoptAgentDefaults();
      if (result === "forbidden") {
        discovery.reject(
          new GatewayRequestError({ code: "FORBIDDEN", message: "missing scope: operator.write" }),
        );
      } else if (result === "rejected") {
        discovery.reject(new Error("Git unavailable"));
      } else {
        discovery.resolve({ ...GIT, repositoryStatus: result });
      }
      await repositoryReady(
        state,
        result === "git" ? "git" : result === "forbidden" ? "forbidden" : "unavailable",
      );
      expect(state).toMatchObject({
        worktree: true,
        baseRef: "my-branch",
        worktreeName: "my-checkout",
      });
      expect(state.preferenceSelection().worktree).toBe(true);

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
    },
  );

  it.each([
    { arrival: "during", edited: false },
    { arrival: "during", edited: true },
    { arrival: "after", edited: true },
  ] as const)(
    "adopts $arrival-discovery preferences (edited=$edited)",
    async ({ arrival, edited }) => {
      const { state, discovery, readPreference } = pendingRepository({ worktree: true });
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
    const { state, request, changed, discovery: previous } = pendingRepository({ worktree: true });
    const currentPublished = nextChange(changed, () => state.repository.kind === "git");
    state.adoptAgentDefaults();
    request.mockResolvedValue(GIT);
    state.applyFolder("/new-repo");
    await currentPublished;
    state.selectWorktree(true);

    previous.reject(
      new GatewayRequestError({ code: "FORBIDDEN", message: "missing scope: operator.write" }),
    );
    await previous.promise.catch(() => undefined);

    expect(state.repository).toMatchObject({ kind: "git", repoRoot: "/new-repo" });
    expect(state.worktree).toBe(true);
    expect(state.preferenceSelection()).toMatchObject({ folder: "/new-repo", worktree: true });
  });

  it.each(["local", "device", "cloud"] as const)(
    "keeps remote-project branch and checkout on %s",
    (placement) => {
      const { state, browser } = createRepositoryFixture();
      state.selectRemoteProject(REMOTE_PROJECT);
      expect(state.baseRef).toBe("main");
      if (placement === "local") {
        expect(state.repository).toEqual({
          kind: "pending-clone",
          cloneUrl: REMOTE_PROJECT.cloneUrl,
        });
        expect(state.worktreeAvailable()).toBe(true);
        expect(state).toMatchObject({ checkoutVisible: true, worktree: false });
      }
      state.setBaseRef("release");
      if (placement === "local") {
        state.selectWorktree(true);
        expect(state.worktree).toBe(true);
      } else {
        selectDestination(state, placement);
        expect(browser.remoteProject).toEqual(REMOTE_PROJECT);
        expect(state.worktree).toBe(false);
        expect(state.remoteRepository).toEqual({ url: REMOTE_PROJECT.cloneUrl, ref: "release" });
      }
      expect(state.baseRef).toBe("release");
      state.selectWorktree(placement === "local");
      expect(state.worktree).toBe(placement === "local");
    },
  );

  it.each(["/workspace", "/plain"])(
    "rejects worktree before and after non-Git %s discovery",
    async (folder) => {
      const { state, request, readPreference } = createRepositoryFixture();
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
      state.selectWorktree(true);
      expect(state).toMatchObject({ worktree: false, checkoutVisible: false });
      expect(state.worktreeAvailable()).toBe(false);
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
    const { state, discovery } = pendingRepository({
      where,
      worktree: true,
      worktreeName: "remote-task",
    });
    state.adoptAgentDefaults();
    discovery.resolve({ repositoryStatus: "unavailable", branches: [] });
    await repositoryReady(state, "unavailable");
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
    const selection = (id = "aws") => [state.resolve(id), state.resolveOs(id)];
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
    expect(selection()).toEqual(["", "windows/wsl2"]);
    expect(state.machines(profiles[0]!).map((machine) => machine.label)).toEqual([
      "Tiny Windows",
      "Large Windows",
      "Custom",
    ]);
    state.select("aws", "large", profiles);
    state.select("aws", "tiny", profiles);
    expect(selection()).toEqual(["tiny", "windows/wsl2"]);
    state.select("aws", "custom", profiles);
    state.selectOs("aws", "linux", profiles);
    expect(selection()).toEqual(["custom", "linux"]);
    state.applyPending("other", "large", "other-os");
    expect(state.resolve("aws")).toBe("custom");
    expect(state.resolveOs("other")).toBe("other-os");
    expect(state.selectOs("aws", "windows/wsl2", profiles, true)).toBe(false);
    expect(state.selectOs("aws", "macos", profiles)).toBe(false);
    expect(state.resolveOs("aws")).toBe("linux");
  });

  it("restores the exact recovered choice instead of retaining a stale draft override", () => {
    const cloudProfiles = [cloudProfile];
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
      const cloudProfiles = [{ ...cloudProfile, executionModes: ["worker-turn"] as const }];
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

  function folderFixture(capable = false, runtime = workerRuntime) {
    const f = createRepositoryFixture();
    f.context.agents.state.agentsList!.agents[0]!.agentRuntime = runtime;
    if (capable) {
      f.gateway.environments![0]!.workerHost = { deviceFolders: true };
    }
    f.state.adoptAgentDefaults();
    f.state.selectDevice("desktop");
    return f;
  }

  it("rejects an existing device folder without a worker-turn execution mode", () => {
    const f = folderFixture(true, { ...workerRuntime, cloudPlacementExecutionMode: undefined });
    expect(f.state.devicePlacement().ready).toBe(true);
    expect(f.state.deviceFolderAvailable).toBe(false);
    f.state.selectDeviceFolder();
    expect(f.state.deviceFolder).toBeUndefined();
  });

  it("requires an explicit capable device and keeps its path out of Gateway discovery", () => {
    const f = folderFixture();
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
    const f = folderFixture(true);
    f.state.selectDeviceFolder();
    f.state.setDeviceFolderPath("/srv/project");
    f.gateway.environments![0]!.workerHost = {};
    expect(f.state.folderSubmissionBlocked()).toBe(true);
    expect(f.state.deviceFolder).toEqual({ deviceId: "desktop", path: "/srv/project" });
    f.state.selectNewWorkspace();
    expect(f.state).toMatchObject({ deviceFolder: undefined, freshWorkspace: true });
  });
});
