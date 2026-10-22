import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import type { ModelCatalogEntry, ModelCatalogResult } from "../../api/types.ts";
import { buildSelectedSessionCreateParams } from "./draft-create-params.ts";
import { createRepositoryFixture } from "./draft-place-state.test-support.ts";
import { createDraftFixture } from "./draft-submission-flow.test-support.ts";
import type { NewSessionRouteData } from "./location.ts";
import { managedModelControls, controlQueries } from "./model-control-view-queries.test-support.ts";
import { contextWith, renderControl, waitForModelControl } from "./model-control.test-support.ts";
import {
  hostedRuntime as runtime,
  mountPlacement as renderPlace,
  nativeRuntime,
  placementDevice,
} from "./placement.test-support.ts";
const modelRef = "openai/hosted-model";
const createSelection = { message: "hello", visibility: "normal" as const };
const model: ModelCatalogEntry = {
  id: "hosted-model",
  name: "Hosted model",
  provider: "openai",
  available: true,
  agentRuntime: nativeRuntime(),
  runtimeChoices: [{ agentRuntime: runtime, available: true }],
};
const agent = { id: "main", model: { primary: modelRef } };
const preferred = { model: modelRef, agentRuntime: "agentsapi" };
const managed = managedModelControls();
afterEach(() => {
  managed.reset();
  vi.restoreAllMocks();
});
function modelControl(context: Parameters<typeof renderControl>[1]) {
  const control = managed.make(() => {});
  return { control, ...controlQueries(control, context, "main", agent) };
}
const catalog = (overrides: Partial<ModelCatalogEntry>) => ({
  models: [{ ...model, ...overrides }],
});
const unavailableCatalog = (
  unavailableReason: NonNullable<ModelCatalogEntry["runtimeChoices"]>[number]["unavailableReason"],
) => catalog({ runtimeChoices: [{ agentRuntime: runtime, available: false, unavailableReason }] });
const modelAccount = (suffix: string, label: string, authType: string) => ({
  authProfileId: `personal:person-a:openai:${suffix}`,
  provider: "openai",
  label,
  authType,
  selected: false,
});
function hostedRepository(data?: NewSessionRouteData) {
  const fixture = createRepositoryFixture({ models: [model], workspaceGit: true, data });
  const { state, context } = fixture;
  managed.track(state.modelControl);
  context.agents.state.agentsList!.agents[0]!.model = agent.model;
  return fixture;
}
it("keeps explicit runtime intent across a late catalog, permission loss, and restored preferences", async () => {
  const { context, request } = contextWith([model]);
  const { control } = modelControl(context);
  control.load(context, "main", true, { agent });
  await vi.waitFor(() => expect(control.hostedEnvironments()[0]?.model).toBe(modelRef));
  const refresh = createDeferred<{ models: ModelCatalogEntry[] }>();
  request.mockReturnValueOnce(refresh.promise);
  control.invalidate();
  control.load(context, "main", true, { agent, preference: { model: modelRef } });
  control.selectHostedEnvironment("agentsapi");
  refresh.resolve({ models: [model] });
  await vi.waitFor(() => expect(control.resolveAgentRuntime()?.id).toBe("agentsapi"));
  expect(control.modelForSubmission()).toBe(modelRef);
  request.mockResolvedValue(unavailableCatalog("missing-auth"));
  control.invalidate();
  control.load(context, "main", true, { agent });
  await vi.waitFor(() => expect(control.hostedEnvironments()[0]?.disabledReason).toBeTruthy());
  expect(control.agentRuntime).toBe("agentsapi");
  expect(control.modelSelectionBlockedReason(agent)).toBeTruthy();
  const { control: restored } = modelControl(context);
  restored.load(context, "main", true, { agent, preference: preferred });
  await vi.waitFor(() => expect(restored.agentRuntime).toBe("agentsapi"));
  expect(restored.modelSelectionBlockedReason(agent)).toBeTruthy();
  expect(restored.selectHostedEnvironment("agentsapi")).toBe(false);
});
it("uses model-picker changes and configured defaults as the environment authority", async () => {
  const { context } = contextWith([model]);
  const { control, find } = modelControl(context);
  control.load(context, "main", true, { agent });
  await vi.waitFor(() => expect(control.hostedEnvironments()).toHaveLength(1));
  await waitForModelControl(control, context, "main", agent);
  find("model-runtime", "agentsapi")!.click();
  expect(control.resolveAgentRuntime()?.workspaceEnvironment).toEqual(runtime.workspaceEnvironment);
  expect(control.selectHostEnvironment()).toBe(true);
  expect(control.agentRuntime).toBe("openclaw");
  control.load(context, "other", true, { agent: { ...agent, id: "other" }, preference: preferred });
  await vi.waitFor(() => expect(control.resolveAgentRuntime()?.id).toBe("agentsapi"));
  expect(control.modelForSubmission()).toBe(modelRef);
});
it("retains the explicit API-key account through hosted selection and rejects a late unavailable account preview", async () => {
  const api = modelAccount("api", "API account", "api_key");
  const subscription = modelAccount("subscription", "Subscription account", "oauth");
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
  const { control, find } = modelControl(context);
  control.load(context, "main", true, { agent });
  const choose = async (id: string) => {
    find("account-group-toggle")!.click();
    await vi.waitFor(() => expect(find("account-option", "account:" + id)).not.toBeNull());
    find("account-option", "account:" + id)!.click();
  };
  await vi.waitFor(() => expect(find("account-group-toggle")).not.toBeNull());
  await choose(api.authProfileId);
  await vi.waitFor(() => expect(control.accountSelectionReady()).toBe(true));
  expect(control.selectHostedEnvironment("agentsapi")).toBe(true);
  const { state } = createRepositoryFixture();
  managed.track(state.modelControl);
  state.modelControl.agentRuntime = control.agentRuntime;
  vi.spyOn(state.modelControl, "modelForSubmission").mockReturnValue(control.modelForSubmission());
  expect(buildSelectedSessionCreateParams(state, createSelection)).toMatchObject({
    model: `${modelRef}@${api.authProfileId}`,
    agentRuntime: "agentsapi",
  });
  await choose(subscription.authProfileId);
  expect(control.accountSelectionReady()).toBe(false);
  expect(control.modelSelectionBlockedReason(agent)).toBe("Loading models…");
  late.resolve({
    ...unavailableCatalog("unsupported-runtime"),
    accountSelection: {
      kind: "personal",
      authProfileId: subscription.authProfileId,
      label: subscription.label,
    },
  });
  await vi.waitFor(() => expect(control.hostedEnvironments()[0]?.disabledReason).toBeTruthy());
  expect(control.agentRuntime).toBe("agentsapi");
  expect(control.modelForSubmission()).toBe(`${modelRef}@${subscription.authProfileId}`);
  expect(control.accountSelectionReady()).toBe(false);
  expect(control.modelSelectionBlockedReason(agent)).toBeTruthy();
  expect(control.selectHostedEnvironment("agentsapi")).toBe(false);
});
it("keeps terminal placement when a hosted draft changes to a same-agent catalog target", async () => {
  const folder = "/local/project";
  const data: NewSessionRouteData = {
    agentId: "main",
    requestedAgentId: "main",
    catalogId: "",
    catalogLabel: "",
    startTerminal: false,
  };
  const fixture = hostedRepository(data);
  const { state, request } = fixture;
  request.mockResolvedValue({
    repositoryStatus: "git",
    branches: [{ kind: "local", name: "main" }],
    headBranch: "main",
  });
  state.adoptAgentDefaults();
  await vi.waitFor(() => expect(state.modelControl.hostedEnvironments()).toHaveLength(1));
  state.applyFolder(folder);
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
  expect(state).toMatchObject({ hostedEnvironment: undefined, folder, worktree: true });
  const element = renderPlace({ ...fixture, place: state }, data);
  expect(element.querySelector("#new-session-project-trigger")).not.toBeNull();
  expect(element.querySelector("#new-session-checkout-trigger")).not.toBeNull();
  expect(
    buildSelectedSessionCreateParams(state, { ...createSelection, catalogId: "native-cli" }),
  ).toMatchObject({ catalogId: "native-cli", cwd: folder, worktree: true });
});
it("describes Auto using the eligible host runtime while a hosted workspace is selected", async () => {
  const f = createDraftFixture({
    methods: ["environments.list", "sessions.create"],
    request: async () => ({
      profiles: [],
      environments: ["desktop", "laptop"].map((id) => placementDevice(id)),
    }),
    agents: [{ ...agent, workspace: "/workspace" }],
    modelCatalog: async () =>
      catalog({ agentRuntime: nativeRuntime("remote-runtime", "remote-exec") }),
  });
  managed.track(f.place.modelControl);
  await vi.waitFor(() => expect(f.place.modelControl.hostedEnvironments()).toHaveLength(1));
  f.place.selectHostedEnvironment("agentsapi");
  expect(f.place.hostedEnvironment).toBeDefined();
  await f.gateway.refreshCloudProfiles();
  const element = renderPlace(f);
  expect(element.textContent).toContain("Chooses the first eligible connected device");
  expect(element.textContent).not.toContain("Chooses the least-busy connected device");
  f.place.selectDevice("", true);
  expect(f.place.autoDevice).toBe(true);
  expect(f.place.modelControl.resolveAgentRuntime()?.id).toBe("remote-runtime");
});

it("suppresses remote clone and worktree payloads while preserving place intent", async () => {
  const { state } = hostedRepository();
  state.adoptAgentDefaults();
  await vi.waitFor(() => expect(state.modelControl.hostedEnvironments()).toHaveLength(1));
  state.selectDevice("desktop");
  state.selectRemoteProject({
    identity: "example.test/repo",
    cloneUrl: "https://example.test/repo.git",
  });
  const before = state.preferenceSelection();
  state.selectHostedEnvironment("agentsapi");
  expect(state).toMatchObject({ remotePlacement: false, deviceId: "", worktree: false });
  const payload = buildSelectedSessionCreateParams(state, createSelection);
  expect(payload).toStrictEqual({ agentId: "main", message: "hello", ...preferred });
  expect(state.preferenceSelection().remoteProject).toEqual(before.remoteProject);
  state.selectDevice("desktop");
  expect(state.modelControl.resolveAgentRuntime()?.id).toBe("openclaw");
  expect(state.deviceId).toBe("desktop");
  expect(state.remoteRepository?.url).toBe("https://example.test/repo.git");
});
