import { createComponent } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import type { ModelCatalogEntry, ModelCatalogResult } from "../../api/types.ts";
import { settleModelCatalogRequests } from "../../lib/model-catalog-store.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { buildDraftSessionCreateParams } from "./create-params.ts";
import { buildSelectedSessionCreateParams } from "./draft-create-params.ts";
import { createRepositoryFixture } from "./draft-place-state.test-support.ts";
import { createDraftFixture } from "./draft-submission-flow.test-support.ts";
import type { NewSessionRouteData } from "./location.ts";
import { contextWith, renderControl } from "./model-control.test-support.ts";
import { NewSessionModelControl } from "./model-control.ts";
import { NewSessionPlaceControls } from "./target-controls-view.tsx";
const runtime = {
  id: "agentsapi",
  source: "model" as const,
  cloudPlacementSupported: false,
  workspaceEnvironment: { kind: "provider-hosted" as const, label: "OpenAI (Agents API)" },
};
const model: ModelCatalogEntry = {
  id: "hosted-model",
  name: "Hosted model",
  provider: "openai",
  available: true,
  agentRuntime: {
    id: "openclaw",
    source: "model",
    cloudPlacementSupported: true,
    cloudPlacementExecutionMode: "worker-turn",
    devicePlacement: { requiredNodeCommands: [], consumesWorkerSlot: true },
  },
  runtimeChoices: [{ agentRuntime: runtime, available: true }],
};
const agent = { id: "main", model: { primary: "openai/hosted-model" } };
const controls: NewSessionModelControl[] = [];
afterEach(() => {
  for (const control of controls.splice(0)) {
    control.reset();
  }
  vi.restoreAllMocks();
});
describe("hosted environment selection", () => {
  it("keeps explicit runtime intent across a late catalog, permission loss, and restored preferences", async () => {
    const { context, request } = contextWith([model]);
    const control = new NewSessionModelControl(() => {});
    controls.push(control);
    control.load(context, "main", true, { agent });
    await vi.waitFor(() =>
      expect(control.hostedEnvironments()[0]?.model).toBe("openai/hosted-model"),
    );
    const refresh = createDeferred<{ models: ModelCatalogEntry[] }>();
    request.mockReturnValueOnce(refresh.promise);
    control.invalidate();
    control.load(context, "main", true, { agent, preference: { model: "openai/hosted-model" } });
    control.selectHostedEnvironment("agentsapi");
    refresh.resolve({ models: [model] });
    await vi.waitFor(() => expect(control.resolveAgentRuntime()?.id).toBe("agentsapi"));
    expect(control.modelForSubmission()).toBe("openai/hosted-model");
    request.mockResolvedValue({
      models: [
        {
          ...model,
          runtimeChoices: [
            { agentRuntime: runtime, available: false, unavailableReason: "missing-auth" },
          ],
        },
      ],
    });
    control.invalidate();
    control.load(context, "main", true, { agent });
    await vi.waitFor(() => expect(control.hostedEnvironments()[0]?.disabledReason).toBeTruthy());
    expect(control.agentRuntime).toBe("agentsapi");
    expect(control.modelSelectionBlockedReason(agent)).toBeTruthy();
    const restored = new NewSessionModelControl(() => {});
    controls.push(restored);
    restored.load(context, "main", true, {
      agent,
      preference: { model: "openai/hosted-model", agentRuntime: "agentsapi" },
    });
    await vi.waitFor(() => expect(restored.agentRuntime).toBe("agentsapi"));
    expect(restored.modelSelectionBlockedReason(agent)).toBeTruthy();
    expect(restored.selectHostedEnvironment("agentsapi")).toBe(false);
  });
  it("uses model-picker changes and configured defaults as the environment authority", async () => {
    const { context } = contextWith([model]);
    const control = new NewSessionModelControl(() => {});
    controls.push(control);
    control.load(context, "main", true, { agent });
    await vi.waitFor(() => expect(control.hostedEnvironments()).toHaveLength(1));
    renderControl(control, context, "main", agent)
      .querySelector<HTMLButtonElement>('[data-chat-model-runtime="agentsapi"]')!
      .click();
    expect(control.resolveAgentRuntime()?.workspaceEnvironment).toEqual(
      runtime.workspaceEnvironment,
    );
    expect(control.selectHostEnvironment()).toBe(true);
    expect(control.agentRuntime).toBe("openclaw");
    control.load(context, "other", true, {
      agent: { id: "other", model: { primary: "openai/hosted-model" } },
      preference: { model: "openai/hosted-model", agentRuntime: "agentsapi" },
    });
    await vi.waitFor(() => expect(control.resolveAgentRuntime()?.id).toBe("agentsapi"));
    expect(control.modelForSubmission()).toBe("openai/hosted-model");
  });
  it("retains the explicit API-key account through hosted selection and rejects a late unavailable account preview", async () => {
    const api = {
      authProfileId: "personal:person-a:openai:api",
      provider: "openai",
      label: "API account",
      authType: "api_key",
      selected: false,
    };
    const subscription = {
      authProfileId: "personal:person-a:openai:subscription",
      provider: "openai",
      label: "Subscription account",
      authType: "oauth",
      selected: false,
    };
    const { context, request } = contextWith([model]);
    Object.assign(context.gateway.snapshot, { selfUser: { id: "person-a", name: "Person A" } });
    const late = createDeferred<ModelCatalogResult>();
    request.mockImplementation((method: string, params: { authProfileId?: string }) => {
      if (method === "users.listModelAccounts") {
        return Promise.resolve({ profileId: "person-a", accounts: [api, subscription], links: [] });
      }
      if (params.authProfileId === subscription.authProfileId) {
        return late.promise;
      }
      return Promise.resolve({
        models: [model],
        accountSelection: params.authProfileId
          ? { kind: "personal", authProfileId: params.authProfileId, label: api.label }
          : { kind: "automatic", label: "Automatic" },
      });
    });
    const control = new NewSessionModelControl(() => {});
    controls.push(control);
    control.load(context, "main", true, { agent });
    const draw = () => renderControl(control, context, "main", agent);
    const choose = async (id: string) => {
      draw().querySelector<HTMLButtonElement>("[data-chat-account-group-toggle]")!.click();
      await vi.waitFor(() =>
        expect(
          draw().querySelector('[data-chat-account-option="account:' + id + '"]'),
        ).not.toBeNull(),
      );
      draw()
        .querySelector<HTMLButtonElement>('[data-chat-account-option="account:' + id + '"]')!
        .click();
    };
    await vi.waitFor(() =>
      expect(draw().querySelector("[data-chat-account-group-toggle]")).not.toBeNull(),
    );
    await choose(api.authProfileId);
    await vi.waitFor(() => expect(control.accountSelectionReady()).toBe(true));
    expect(control.selectHostedEnvironment("agentsapi")).toBe(true);
    expect(
      buildDraftSessionCreateParams({
        agentId: "main",
        message: "hello",
        worktree: false,
        model: control.modelForSubmission(),
        agentRuntime: control.agentRuntime,
      }),
    ).toMatchObject({
      model: "openai/hosted-model@personal:person-a:openai:api",
      agentRuntime: "agentsapi",
    });
    await choose(subscription.authProfileId);
    expect(control.accountSelectionReady()).toBe(false);
    expect(control.modelSelectionBlockedReason(agent)).toBe("Loading models…");
    late.resolve({
      models: [
        {
          ...model,
          runtimeChoices: [
            { agentRuntime: runtime, available: false, unavailableReason: "unsupported-runtime" },
          ],
        },
      ],
      accountSelection: {
        kind: "personal",
        authProfileId: subscription.authProfileId,
        label: subscription.label,
      },
    });
    await vi.waitFor(() => expect(control.hostedEnvironments()[0]?.disabledReason).toBeTruthy());
    expect(control.agentRuntime).toBe("agentsapi");
    expect(control.modelForSubmission()).toBe(
      "openai/hosted-model@personal:person-a:openai:subscription",
    );
    expect(control.accountSelectionReady()).toBe(false);
    expect(control.modelSelectionBlockedReason(agent)).toBeTruthy();
    expect(control.selectHostedEnvironment("agentsapi")).toBe(false);
  });
  it("keeps terminal placement when a hosted draft changes to a same-agent catalog target", async () => {
    const data: NewSessionRouteData = {
      agentId: "main",
      requestedAgentId: "main",
      catalogId: "",
      catalogLabel: "",
      startTerminal: false,
    };
    const fixture = createRepositoryFixture({ models: [model], workspaceGit: true, data });
    const { state, context, request } = fixture;
    controls.push(state.modelControl);
    context.agents.state.agentsList!.agents[0]!.model = { primary: "openai/hosted-model" };
    request.mockResolvedValue({
      repositoryStatus: "git",
      branches: [{ kind: "local", name: "main" }],
      headBranch: "main",
    });
    state.adoptAgentDefaults();
    await vi.waitFor(() => expect(state.modelControl.hostedEnvironments()).toHaveLength(1));
    state.applyFolder("/local/project");
    await vi.waitFor(() => expect(state.repository.kind).toBe("git"));
    state.selectWorktree(true);
    state.selectHostedEnvironment("agentsapi");
    expect(state.hostedEnvironment).toBeDefined();
    Object.assign(data, {
      catalogId: "native-cli",
      catalogLabel: "Native CLI",
      startTerminal: true,
      terminalHosts: [{ hostId: "gateway:local", label: "Local" }],
    });
    state.adoptAgentDefaults({ preserveSelectedAgent: true, preserveSelectedFolder: true });
    expect(state.hostedEnvironment).toBeUndefined();
    expect(state.folder).toBe("/local/project");
    expect(state.worktree).toBe(true);
    const element = document.createElement("div");
    mountSolid(
      () =>
        createComponent(NewSessionPlaceControls, {
          params: {
            context,
            data,
            gateway: fixture.gateway,
            place: state,
            submitting: false,
            pendingPlacement: false,
            onConnectMachine: vi.fn(),
            onNavigate: vi.fn(),
            onFocusComposer: vi.fn(),
            requestUpdate: vi.fn(),
          },
        }),
      { container: element },
    );
    expect(element.querySelector("#new-session-project-trigger")).not.toBeNull();
    expect(element.querySelector("#new-session-checkout-trigger")).not.toBeNull();
    expect(
      buildSelectedSessionCreateParams(state, {
        catalogId: "native-cli",
        message: "hello",
        visibility: "normal",
      }),
    ).toMatchObject({ catalogId: "native-cli", cwd: "/local/project", worktree: true });
  });
  it("describes Auto using the eligible host runtime while a hosted workspace is selected", async () => {
    const f = createDraftFixture({
      methods: ["environments.list", "sessions.create"],
      request: async () => ({
        profiles: [],
        environments: ["desktop", "laptop"].map((id) => ({
          id: `node:${id}`,
          type: "node",
          status: "available",
          sessionHost: true,
          workerSlots: { total: 1, available: 1 },
        })),
      }),
      agents: [{ ...agent, workspace: "/workspace" }],
      modelCatalog: async () => ({
        models: [
          {
            ...model,
            agentRuntime: {
              ...model.agentRuntime!,
              id: "remote-runtime",
              cloudPlacementExecutionMode: "remote-exec",
            },
          },
        ],
      }),
    });
    controls.push(f.place.modelControl);
    await settleModelCatalogRequests(f.context.gateway.snapshot.client!, { agentId: "main" });
    f.place.selectHostedEnvironment("agentsapi");
    expect(f.place.hostedEnvironment).toBeDefined();
    await f.gateway.refreshCloudProfiles();
    const element = document.createElement("div");
    mountSolid(
      () =>
        createComponent(NewSessionPlaceControls, {
          params: {
            context: f.context,
            data: undefined,
            gateway: f.gateway,
            place: f.place,
            submitting: false,
            pendingPlacement: false,
            onConnectMachine: vi.fn(),
            onNavigate: vi.fn(),
            onFocusComposer: vi.fn(),
            requestUpdate: vi.fn(),
          },
        }),
      { container: element },
    );
    expect(element.textContent).toContain("Chooses the first eligible connected device");
    expect(element.textContent).not.toContain("Chooses the least-busy connected device");
    f.place.selectDevice("", true);
    expect(f.place.autoDevice).toBe(true);
    expect(f.place.modelControl.resolveAgentRuntime()?.id).toBe("remote-runtime");
  });

  it("suppresses remote clone and worktree payloads while preserving place intent", async () => {
    const fixture = createRepositoryFixture({ models: [model], workspaceGit: true });
    const { state, context } = fixture;
    controls.push(state.modelControl);
    context.agents.state.agentsList!.agents[0]!.model = { primary: "openai/hosted-model" };
    state.adoptAgentDefaults();
    await vi.waitFor(() => expect(state.modelControl.hostedEnvironments()).toHaveLength(1));
    state.selectDevice("desktop");
    state.selectRemoteProject({
      identity: "example.test/repo",
      cloneUrl: "https://example.test/repo.git",
    });
    const before = state.preferenceSelection();
    state.selectHostedEnvironment("agentsapi");
    expect(state.remotePlacement).toBe(false);
    expect(state.deviceId).toBe("");
    expect(state.worktree).toBe(false);
    const payload = buildSelectedSessionCreateParams(state, {
      message: "hello",
      visibility: "normal",
    });
    expect(payload).toMatchObject({
      model: "openai/hosted-model",
      agentRuntime: "agentsapi",
      message: "hello",
    });
    for (const key of [
      "cwd",
      "projectId",
      "projectGitUrl",
      "repository",
      "worktree",
      "worktreeSource",
    ]) {
      expect(payload).not.toHaveProperty(key);
    }
    expect(state.preferenceSelection().remoteProject).toEqual(before.remoteProject);
    state.selectDevice("desktop");
    expect(state.modelControl.resolveAgentRuntime()?.id).toBe("openclaw");
    expect(state.deviceId).toBe("desktop");
    expect(state.remoteRepository?.url).toBe("https://example.test/repo.git");
  });
});
