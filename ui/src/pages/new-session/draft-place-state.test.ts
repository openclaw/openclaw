import { describe, expect, it, onTestFinished, vi } from "vitest";
import type { WorktreesBranchesResult } from "../../../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import { settleModelCatalogRequests } from "../../lib/model-catalog-store.ts";
import type { DraftCloudProfile } from "./discovery.ts";
import { DraftCloudMachineState } from "./draft-cloud-machine-state.ts";
import { buildSelectedSessionCreateParams } from "./draft-create-params.ts";
import { createRepositoryFixture } from "./draft-place-state.test-support.ts";
import { renderControl } from "./model-control.test-support.ts";

const REMOTE_PROJECT = {
  identity: "openclaw/openclaw",
  cloneUrl: "https://github.com/openclaw/openclaw.git",
  defaultBranch: "main",
};

describe("DraftPlaceState repository selection", () => {
  it.each(["restored", "selected"])(
    "retires an active %s remote repository after the catalog host changes",
    (selection) => {
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
      expect(f.state.baseRef).toBe("");
      expect(f.state.worktreeName).toBe("");
      expect(f.persistPreference).toHaveBeenCalledWith("main", "/workspace", {
        baseRef: "",
        worktreeName: "",
      });
      expect(f.persistPreference).toHaveBeenCalledWith(
        "main",
        "/workspace",
        expect.objectContaining({ remoteProject: null }),
      );
    },
  );

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
    expect(restored.state.baseRef).toBe("main");
    expect(restored.state.cloudProfileId).toBe("aws");
    expect(restored.state.remoteRepository).toEqual({
      url: REMOTE_PROJECT.cloneUrl,
      ref: "main",
    });
    expect(restored.state.placementPreferenceReady).toBe(true);
  });

  it("leaves the worktree base to the Gateway unless a branch was selected", async () => {
    const { state, request, requestUpdate } = createRepositoryFixture({ workspaceGit: true });
    const discovered = createDeferred();
    request.mockResolvedValue({
      repositoryStatus: "git",
      branches: [{ name: "main", kind: "local" }],
      defaultBranch: "main",
      headBranch: "old-feature",
    });
    requestUpdate.mockImplementation(() => {
      if (state.repository.kind === "git") {
        discovered.resolve();
      }
    });
    state.adoptAgentDefaults();
    await discovered.promise;
    const create = () =>
      buildSelectedSessionCreateParams(state, { message: "new task", visibility: "normal" });

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
      data: {
        agentId: "main",
        requestedAgentId: "main",
        requestedModel: "example/first",
        catalogId: "",
        catalogLabel: "",
        startTerminal: false,
      },
      models: ["first", "second", "remembered"].map((id) => ({
        id,
        provider: "example",
        name: id,
        available: true,
      })),
    });
    onTestFinished(() => state.modelControl.reset());
    readPreference.mockReturnValue({ model: "example/remembered" });
    state.adoptAgentDefaults();
    await settleModelCatalogRequests(context.gateway.snapshot.client!, { agentId: "main" });
    const view = renderControl(state.modelControl, context, "main", state.selectedAgent());
    expect(state.modelControl.modelForSubmission()).toBe("example/first");
    expect(
      buildSelectedSessionCreateParams(state, { message: "", visibility: "normal" }).model,
    ).toBe("example/first");
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
    const { state, request, readPreference } = createRepositoryFixture({ workspaceGit: true });
    const discovery = createDeferred<WorktreesBranchesResult>();
    request.mockReturnValue(discovery.promise);
    readPreference.mockReturnValue({
      worktree: true,
      where: { kind: "device", id: "desktop" },
      projectId: "pending-project",
      baseRef: "release/next",
    });
    state.adoptAgentDefaults();
    expect(state.placementPreferenceReady).toBe(false);
    expect(state.worktree).toBe(false);
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
    "preserves folder intent choosing $destination during Git discovery (explicit: $explicitFolder)",
    async ({ destination, explicitFolder }) => {
      const { state, request, readPreference } = createRepositoryFixture({
        workspaceGit: !explicitFolder,
      });
      const discovery = createDeferred<WorktreesBranchesResult>();
      const create = () =>
        buildSelectedSessionCreateParams(state, { message: "Start empty", visibility: "normal" });
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
        expect(state.remotePlacement).toBe(true);
        expect(state.folder).toBe("/chosen/project");
      } else {
        expect(state.placementPreferenceReady).toBe(true);
        expect(create()).toEqual({
          agentId: "main",
          message: "",
          titleSource: "Start empty",
          worktree: true,
          worktreeSource: "empty",
        });
      }
      discovery.resolve({
        repositoryStatus: explicitFolder ? "not_git" : "git",
        branches: [],
        ...(!explicitFolder ? { defaultBranch: "main" } : {}),
      });
      await vi.waitFor(() => expect(state.repository.kind).toBe(explicitFolder ? "direct" : "git"));
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
    const { state, readPreference, request } = createRepositoryFixture({ workspaceGit: true });
    const discovery = createDeferred<WorktreesBranchesResult>();
    request.mockReturnValue(discovery.promise);
    readPreference.mockReturnValue({
      freshWorkspace: true,
      where: { kind: "cloud", id: "aws" },
      worktree: true,
    });
    state.adoptAgentDefaults();
    state.restorePreferenceSelections();
    expect(state.freshWorkspace).toBe(true);
    expect(state.placementPreferenceReady).toBe(true);

    state.invalidateGatewayDiscovery(false);
    state.adoptAgentDefaults();
    state.restorePreferenceSelections();
    expect(state.repository.kind).toBe("checking");
    expect(state.freshWorkspace).toBe(true);
    expect(state.placementPreferenceReady).toBe(true);
  });

  it.each(["device", "cloud"] as const)(
    "preserves a legacy %s worktree preference until New workspace is explicitly selected",
    async (destination) => {
      const { state, request, readPreference } = createRepositoryFixture({ workspaceGit: true });
      const discovery = createDeferred<WorktreesBranchesResult>();
      request.mockReturnValue(discovery.promise);
      readPreference.mockReturnValue({
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
      expect(state.remotePlacement).toBe(true);
      expect(state.freshWorkspace).toBe(false);
      expect(state.worktree).toBe(true);
      expect(state.worktreeAvailable()).toBe(false);
      expect(state.baseRef).toBe("release");
      expect(state.worktreeName).toBe("saved-task");

      state.selectNewWorkspace();
      expect(state.freshWorkspace).toBe(true);
      expect(state.placementPreferenceReady).toBe(true);
      discovery.resolve({ repositoryStatus: "git", branches: [], defaultBranch: "main" });
      await vi.waitFor(() => expect(state.repository.kind).toBe("git"));
      expect(
        buildSelectedSessionCreateParams(state, { message: "Start empty", visibility: "normal" }),
      ).toEqual({
        agentId: "main",
        message: "",
        titleSource: "Start empty",
        worktree: true,
        worktreeSource: "empty",
      });
    },
  );

  it.each(["local", "device", "cloud"] as const)(
    "closes after selecting Auto and clears Auto when choosing %s",
    (destination) => {
      const { state, browser } = createRepositoryFixture();
      onTestFinished(() => browser.disconnect());
      state.selectRemoteProject(REMOTE_PROJECT);
      browser.onPopoverShow("where");
      browser.changeEnvironmentQuery("runner");

      state.selectDevice("", true);
      expect(state.autoDevice).toBe(true);
      expect(browser.popoverOpen("where")).toBe(false);
      expect(browser.environmentQuery).toBe("runner");

      browser.onPopoverShow("where");
      expect(browser.environmentQuery).toBe("");
      if (destination === "cloud") {
        state.selectCloudProfile("aws");
      } else {
        state.selectDevice(destination === "device" ? "desktop" : "");
      }
      expect(state.autoDevice).toBe(false);
      expect(state.deviceId).toBe(destination === "device" ? "desktop" : "");
      expect(state.cloudProfileId).toBe(destination === "cloud" ? "aws" : "");
      expect(browser.popoverOpen("where")).toBe(destination === "cloud");
    },
  );

  it.each(["git", "unavailable", "rejected"] as const)(
    "preserves an edited base branch through reconnect discovery (%s)",
    async (result) => {
      const { state, request, persistPreference } = createRepositoryFixture({ workspaceGit: true });
      const git = { repositoryStatus: "git", branches: [], defaultBranch: "main" };
      request.mockResolvedValue(git);
      state.adoptAgentDefaults();
      await vi.waitFor(() => expect(state.repository.kind).toBe("git"));
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
        discovery.resolve({ ...git, repositoryStatus: result });
      }
      await vi.waitFor(() =>
        expect(state.repository.kind).toBe(result === "git" ? "git" : "unavailable"),
      );
      expect(state.baseRef).toBe("my-branch");
      expect(state.worktreeName).toBe("my-checkout");

      state.invalidateGatewayDiscovery(false);
      request.mockResolvedValue(git);
      state.adoptAgentDefaults();
      await vi.waitFor(() => expect(state.repository.kind).toBe("git"));
      expect(state.baseRef).toBe("my-branch");
      state.clearProjectSelection();
      await vi.waitFor(() => expect(state.repository.kind).toBe("git"));
      expect(state.baseRef).toBe("my-branch");
      state.applyFolder("/another-repo");
      await vi.waitFor(() => expect(state.repository.kind).toBe("git"));
      expect(state.baseRef).toBe("");
      expect(state.worktreeName).toBe("");
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
    "adopts preferences arriving $arrival repository discovery without overwriting edits ($edited)",
    async ({ arrival, edited }) => {
      const { state, request, readPreference } = createRepositoryFixture({ workspaceGit: true });
      const discovery = createDeferred<WorktreesBranchesResult>();
      const git: WorktreesBranchesResult = {
        repositoryStatus: "git",
        branches: [],
        defaultBranch: "main",
      };
      request.mockImplementation(async (method) =>
        method === "worktrees.branches" ? discovery.promise : {},
      );
      state.adoptAgentDefaults();
      expect(state.repository.kind).toBe("checking");
      if (arrival === "after") {
        discovery.resolve(git);
        await vi.waitFor(() => expect(state.repository.kind).toBe("git"));
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
        discovery.resolve(git);
        await vi.waitFor(() => expect(state.repository.kind).toBe("git"));
        expect(
          request.mock.calls.filter(([method]) => method === "worktrees.branches"),
        ).toHaveLength(1);
      } else {
        expect(state.worktreeName).toBe("my-checkout");
      }
      expect(state.baseRef).toBe(edited ? "my-branch" : "release/next");
    },
  );

  it.each([false, true])(
    "restores a saved cloud preference into a new workspace without usable Git (unavailable: %s)",
    async (unavailable) => {
      const { state, readPreference, persistPreference } = createRepositoryFixture({
        workspaceGit: unavailable,
        unavailable,
      });
      readPreference.mockReturnValue({ where: { kind: "cloud", id: "aws" } });
      state.adoptAgentDefaults();
      await vi.waitFor(() =>
        expect(state.repository.kind).toBe(unavailable ? "unavailable" : "direct"),
      );

      state.restorePreferenceSelections();

      expect(state.placementPreferenceReady).toBe(true);
      expect(state.cloudProfileId).toBe("aws");
      expect(state.worktree).toBe(true);
      expect(state.freshWorkspace).toBe(true);
      expect(persistPreference).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    "reconciles group defaults with cached repository discovery (unavailable: %s)",
    async (unavailable) => {
      const { state } = createRepositoryFixture({
        workspaceGit: unavailable,
        unavailable,
        data: {
          agentId: "main",
          requestedAgentId: "main",
          catalogId: "",
          catalogLabel: "",
          startTerminal: false,
          group: "Notes",
          groupStatus: "resolved",
          groupCwd: "/workspace",
          groupWorktree: true,
        },
      });
      state.adoptAgentDefaults();
      await vi.waitFor(() => expect(state.placementPreferenceReady).toBe(true));
      expect(state.worktree).toBe(unavailable);

      state.adoptGroupDefaults();

      expect(state.placementPreferenceReady).toBe(true);
      expect(state.worktree).toBe(unavailable);
      expect(state.worktreeAvailable()).toBe(false);
    },
  );

  it.each([false, true])(
    "preserves saved isolation for an unverified workspace until explicitly cleared (project selected: %s)",
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
      await vi.waitFor(() => expect(state.repository.kind).toBe("unavailable"));
      expect(state.worktreeAvailable()).toBe(false);
      expect(state.worktree).toBe(true);
      expect(state.checkoutVisible).toBe(true);
      expect(state.placementPreferenceReady).toBe(true);
      expect(state.preferenceSelection().worktree).toBe(true);
      state.selectWorktree(false);
      expect(state.worktree).toBe(false);
      expect(state.preferenceSelection().worktree).toBe(false);
    },
  );

  it("ignores a failed saved-worktree probe after the user chooses another folder", async () => {
    const { state, request, requestUpdate } = createRepositoryFixture({ workspaceGit: true });
    const previous = createDeferred<WorktreesBranchesResult>();
    const current = Promise.resolve({ repositoryStatus: "git", branches: [] });
    const currentPublished = createDeferred();
    requestUpdate.mockImplementation(() => {
      if (state.repository.kind === "git") {
        currentPublished.resolve();
      }
    });
    let probes = 0;
    request.mockImplementation((method) =>
      method === "worktrees.branches" && ++probes === 1 ? previous.promise : current,
    );
    state.adoptAgentDefaults();
    state.applyFolder("/new-repo");
    await currentPublished.promise;
    state.selectWorktree(true);

    previous.reject(new Error("old repository unavailable"));
    await previous.promise.catch(() => undefined);

    expect(state.repository).toMatchObject({ kind: "git", repoRoot: "/new-repo" });
    expect(state.worktree).toBe(true);
    expect(state.preferenceSelection()).toMatchObject({ folder: "/new-repo", worktree: true });
  });

  it.each(["local", "device", "cloud"] as const)(
    "preserves remote-project branch intent and checkout eligibility on %s",
    (placement) => {
      const { state, browser, persistPreference, requestUpdate, request } =
        createRepositoryFixture();
      state.selectRemoteProject(REMOTE_PROJECT);
      if (placement === "local") {
        expect(state.repository).toEqual({
          kind: "pending-clone",
          cloneUrl: REMOTE_PROJECT.cloneUrl,
        });
        expect(state.worktreeAvailable()).toBe(true);
        expect(state.checkoutVisible).toBe(true);
        expect(state.worktree).toBe(false);
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
      requestUpdate.mockClear();
      request.mockClear();
      state.selectWorktree(placement === "local");
      expect(state.worktree).toBe(placement === "local");
      expect(persistPreference).not.toHaveBeenCalled();
      expect(requestUpdate).not.toHaveBeenCalled();
      expect(request).not.toHaveBeenCalled();
    },
  );

  it.each(["/workspace", "/plain"])(
    "rejects worktree selection before and after confirming a non-Git folder %s",
    async (folder) => {
      const { state, persistPreference, requestUpdate, request, readPreference } =
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
      await vi.waitFor(() => expect(state.repository.kind).toBe("direct"));
      persistPreference.mockClear();
      requestUpdate.mockClear();

      state.selectWorktree(true);

      expect(state.worktree).toBe(false);
      expect(state.worktreeAvailable()).toBe(false);
      expect(state.checkoutVisible).toBe(false);
      expect(persistPreference).not.toHaveBeenCalled();
      expect(requestUpdate).not.toHaveBeenCalled();
    },
  );

  it("does not carry cloud isolation into a local non-Git folder", () => {
    const { state, readPreference } = createRepositoryFixture();
    readPreference.mockReturnValue({ worktree: false });
    state.adoptAgentDefaults();
    expect(state.repository.kind).toBe("direct");
    state.selectCloudProfile("aws");
    expect(state.freshWorkspace).toBe(true);
    expect(state.worktree).toBe(true);
    expect(state.checkoutVisible).toBe(false);
    state.applyFolder("/workspace");
    expect(state.freshWorkspace).toBe(false);
    expect(state.checkoutVisible).toBe(false);

    state.clearCloudProfile();

    expect(state.worktree).toBe(false);
    expect(state.checkoutVisible).toBe(false);
    expect(state.preferenceSelection().worktree).toBe(false);
    expect(
      buildSelectedSessionCreateParams(state, { message: "notes", visibility: "normal" }),
    ).not.toHaveProperty("worktree");
  });

  it.each([
    { kind: "cloud", id: "aws" },
    { kind: "device", id: "desktop" },
    { kind: "auto-device" },
  ] as const)("does not restore $kind isolation as a local checkout choice", async (where) => {
    const { state, readPreference, requestUpdate } = createRepositoryFixture({
      workspaceGit: true,
      unavailable: true,
    });
    const discovered = createDeferred();
    requestUpdate.mockImplementation(() => {
      if (state.repository.kind === "unavailable") {
        discovered.resolve();
      }
    });
    readPreference.mockReturnValue({ where, worktree: true, worktreeName: "remote-task" });
    state.adoptAgentDefaults();
    await discovered.promise;
    state.restorePreferenceSelections();
    expect(state.worktree).toBe(true);
    expect(state.preferenceSelection().worktree).toBe(true);

    state.selectDevice("");

    expect(state.worktree).toBe(false);
    expect(state.preferenceSelection().worktree).toBe(false);
    expect(
      buildSelectedSessionCreateParams(state, { message: "notes", visibility: "normal" }),
    ).not.toHaveProperty("worktree");
  });

  it("restores a preferred worktree when a remote project awaits cloning", () => {
    const { state, browser } = createRepositoryFixture();
    browser.selectProject({ kind: "remote", project: REMOTE_PROJECT });

    state.adoptAgentDefaults();

    expect(state.worktree).toBe(true);
    expect(state.placementPreferenceReady).toBe(true);
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
    const cloudProfiles: DraftCloudProfile[] = [
      {
        id: "aws",
        providerId: "crabbox",
        machines: [
          { id: "standard", label: "Standard", default: true },
          { id: "fast", label: "Fast" },
        ],
      },
      {
        id: "hetzner",
        providerId: "crabbox",
        machines: [
          { id: "large", label: "Large", default: true },
          { id: "beast", label: "Beast" },
        ],
      },
    ];
    const { state, requestUpdate } = createRepositoryFixture({ cloudProfiles });

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
    expect(requestUpdate).toHaveBeenCalled();
  });

  it("restores the exact recovered choice instead of retaining a stale draft override", () => {
    const cloudProfiles: DraftCloudProfile[] = [
      {
        id: "aws",
        providerId: "crabbox",
        machines: [
          { id: "standard", label: "Standard", default: true },
          { id: "fast", label: "Fast" },
        ],
      },
    ];
    const { state } = createRepositoryFixture({ cloudProfiles });

    state.applyPendingPlacement({ agentId: "main", profileId: "aws", machineClass: "fast" });
    expect(state.cloudSelection.machineClass).toBe("fast");

    cloudProfiles.splice(0, cloudProfiles.length, { id: "aws", providerId: "crabbox" });
    expect(state.cloudSelection.machineClass).toBe("fast");

    state.applyPendingPlacement({ agentId: "main", profileId: "aws" });
    expect(state.cloudSelection.machineClass).toBe("");
  });

  it.each([
    {
      name: "preserves a recovered one-mode cloud profile when the runtime becomes incompatible",
      executionModes: ["worker-turn"] as const,
      selectedByUser: false,
    },
    {
      name: "preserves an explicitly chosen one-mode cloud profile when the runtime becomes incompatible",
      executionModes: ["worker-turn"] as const,
      selectedByUser: true,
    },
  ])("$name", ({ executionModes, selectedByUser }) => {
    const cloudProfiles: DraftCloudProfile[] = [
      {
        id: "aws",
        providerId: "crabbox",
        executionModes,
        machines: [
          { id: "standard", label: "Standard", default: true },
          { id: "fast", label: "Fast" },
        ],
      },
    ];
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
  });
});
