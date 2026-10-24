import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ProjectsCheckoutOptionsResult,
  ProjectsListResult,
} from "../../../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import { GatewayRequestError } from "../../api/gateway.ts";
import { createDraftFixture, readyChatRoute } from "./draft-submission-flow.test-support.ts";
import { replaceBrowserPreference } from "./preferences.ts";

const projectMethods = [
  "sessions.create",
  "projects.list",
  "projects.checkoutOptions",
  "worktrees.branches",
];
const adminScopes = ["operator.admin", "operator.read", "operator.write"];
type Fixture = ReturnType<typeof createDraftFixture>;
type FixtureOptions = Parameters<typeof createDraftFixture>[0];
type RecoveryCreate = Parameters<Fixture["flow"]["pendingPlacement"]["stageCreate"]>[0];
type SubmitGate = NonNullable<ReturnType<Fixture["flow"]["submitBlock"]>>["gate"];
function expectGate(flow: Fixture["flow"], gate?: SubmitGate, reason?: string) {
  expect(flow.submitBlock()).toEqual(gate ? { gate, reason } : undefined);
  expect(flow.canSubmit()).toBe(gate === undefined);
  expect(flow.submitDisabledReason()).toBe(reason);
}
const agent = (overrides: Record<string, unknown>) => ({
  id: "main",
  workspace: "/workspace",
  ...overrides,
});
function deviceFixture(
  id: string,
  runtime: Record<string, unknown>,
  options: { available?: () => number; deviceFolders?: true; model?: string } = {},
) {
  return withMessage({
    scopes: adminScopes,
    methods: ["environments.list", "sessions.create", "sessions.dispatch"],
    agents: [
      agent({
        agentRuntime: runtime,
        ...(options.model ? { workspaceGit: false, model: { primary: options.model } } : {}),
      }),
    ],
    request: replies({
      "environments.list": async () => ({
        environments: [
          {
            id: `node:${id}`,
            type: "node",
            status: "available",
            sessionHost: true,
            ...(options.deviceFolders ? { workerHost: { deviceFolders: true } } : {}),
            workerSlots: { total: 1, available: options.available?.() ?? 1 },
          },
        ],
        profiles: [],
      }),
    }),
  });
}
function restoreCreate(
  flow: Fixture["flow"],
  options: Pick<RecoveryCreate, "target" | "message" | "createParams">,
) {
  const params = flow.pendingPlacement.stageCreate({
    agentId: "main",
    gatewayUrl: "ws://gateway.example",
    recoveryScope: "principal-a",
    ...options,
  });
  flow.releasePendingPlacementOwner();
  flow.restorePendingPlacementRecovery("ws://gateway.example", "principal-a");
  return params;
}
const replies = (methods: Record<string, () => Promise<unknown>>) => (method: string) =>
  methods[method]?.() ?? Promise.resolve({});
function withMessage(options: FixtureOptions = {}) {
  const fixture = createDraftFixture(options);
  fixture.flow.setMessage("hello");
  return fixture;
}
function unavailableModel(reason: "missing-auth" | "auth-failed" | "cooldown") {
  return { id: "gpt-5.6-luna", provider: "openai", available: false, unavailableReason: reason };
}
function missingScopeError(missingScope: string) {
  return new GatewayRequestError({
    code: "FORBIDDEN",
    message: `missing scope: ${missingScope}`,
    details: { code: "MISSING_SCOPE", missingScope, requiredScopes: [missingScope] },
  });
}
const scopeReason = (scope: string) =>
  `Checking Git for this folder requires ${scope} access. Ask the person who manages OpenClaw for access.`;
async function selectDevice({ gateway, place }: Fixture, id: string) {
  await gateway.refreshCloudProfiles();
  await vi.waitFor(() => expect(place.devices()).toHaveLength(1));
  place.selectDevice(id);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  sessionStorage.clear();
  localStorage.clear();
});

describe("DraftSubmissionFlow submit gates", () => {
  it("submits a guest's path-redacted project as an isolated worktree", async () => {
    const availability = createDeferred<ProjectsCheckoutOptionsResult>();
    const { place, flow, context, request } = withMessage({
      scopes: ["operator.sessions.read", "operator.sessions.write"],
      methods: projectMethods,
      selfUser: { id: "guest" },
      request: replies({
        "projects.list": async () => ({
          projects: [{ id: "registered", displayName: "Registered Project", source: "registered" }],
        }),
        "projects.checkoutOptions": () => availability.promise,
        "worktrees.branches": async () => {
          throw new Error("missing scope: operator.write");
        },
      }),
    });
    await place.browser.refreshProjects();
    place.selectProjectId("registered");
    expect(flow.canSubmit()).toBe(false);
    availability.resolve({ current: false, worktree: true });
    await availability.promise;
    vi.mocked(context.sessions.createResult).mockRejectedValueOnce(
      new Error("project registered is unavailable; re-register the project"),
    );
    await flow.submit();
    const params = vi.mocked(context.sessions.createResult).mock.calls[0]?.[0];
    expect(params).toMatchObject({ projectId: "registered", worktree: true });
    expect(params).not.toHaveProperty("worktreeBaseRef");
    expect(params).not.toHaveProperty("cwd");
    expect(flow.error).toContain("re-register the project");
    expect(place.worktree).toBe(true);
    expect(place.browser.projectId).toBe("registered");
    expect(request.mock.calls.filter(([method]) => method === "worktrees.branches")).toEqual([]);
  });

  it("retries a restored existing-folder create after its device stops offering free slots", async () => {
    let freeSlots = 1;
    const { place, flow, gateway } = deviceFixture(
      "runner",
      {
        id: "openclaw",
        source: "agent",
        cloudPlacementExecutionMode: "worker-turn",
        devicePlacement: { requiredNodeCommands: [], consumesWorkerSlot: true },
      },
      { available: () => freeSlots, deviceFolders: true },
    );
    await gateway.refreshCloudProfiles();
    restoreCreate(flow, {
      target: { kind: "device", deviceId: "runner" },
      message: "Keep my folder",
      createParams: {
        agentId: "main",
        message: "",
        deviceFolder: { deviceId: "runner", path: "/srv/project" },
      },
    });
    expect(place.deviceFolder).toEqual({ deviceId: "runner", path: "/srv/project" });
    // The pending session itself can hold the device's only slot.
    freeSlots = 0;
    await gateway.refreshCloudProfiles();
    expect(place.deviceFolderAvailable).toBe(false);
    expect(flow.submitBlock()).toBeUndefined();
  });

  it.each(["retry", "choose-workspace"] as const)(
    "retains a saved project after failed discovery until %s resolves the choice",
    async (recovery) => {
      replaceBrowserPreference("ws://gateway.example", "main", {
        workspace: "/workspace",
        folder: "/workspace",
        projectId: "registered",
      });
      const discovery = createDeferred<ProjectsListResult>();
      const availability = createDeferred<ProjectsCheckoutOptionsResult>();
      let projects = discovery.promise;
      const { place, flow, context } = withMessage({
        methods: projectMethods,
        request: (method) =>
          method === "projects.list"
            ? projects
            : method === "projects.checkoutOptions"
              ? availability.promise
              : Promise.resolve({ repositoryStatus: "not_git", branches: [] }),
      });
      const read = place.browser.refreshProjects();
      await flow.submit();
      expect(context.sessions.createResult).not.toHaveBeenCalled();
      discovery.reject(new Error("Project discovery unavailable"));
      await read;
      place.restorePreferenceSelections();

      expect(place.preferenceSelection().projectId).toBe("registered");
      expect(flow.canSubmit()).toBe(false);
      await flow.submit();
      await flow.submit(undefined, true);
      expect(context.sessions.createResult).not.toHaveBeenCalled();

      if (recovery === "choose-workspace") {
        place.applyFolder("/workspace");
      } else {
        projects = Promise.resolve({
          projects: [{ id: "registered", displayName: "Registered", source: "registered" }],
        });
        await place.browser.refreshProjects();
        place.restorePreferenceSelections();
        availability.resolve({ current: true, worktree: true });
        await availability.promise;
      }
      expect(flow.canSubmit()).toBe(true);
      await flow.submit();
      const params = vi.mocked(context.sessions.createResult).mock.calls[0]?.[0];
      if (recovery === "retry") {
        expect(params).toHaveProperty("projectId", "registered");
      } else {
        expect(params).not.toHaveProperty("projectId");
      }
    },
  );

  it("waits for the configured default repository before admitting the first session", async () => {
    const discovery = createDeferred<ProjectsListResult>();
    const { place, flow, context } = withMessage({
      methods: ["sessions.create", "projects.list"],
      request: (method) => (method === "projects.list" ? discovery.promise : Promise.resolve({})),
    });
    const read = place.browser.refreshProjects();
    expect(flow.canSubmit()).toBe(false);
    await flow.submit();
    expect(context.sessions.createResult).not.toHaveBeenCalled();

    discovery.resolve({
      projects: [],
      defaultRepository: {
        identity: "acme/private-repo",
        url: "https://github.com/acme/private-repo.git",
        ref: "main",
      },
    });
    await read;
    place.restorePreferenceSelections();
    expect(flow.canSubmit()).toBe(true);
    await flow.submit();
    expect(context.sessions.createResult).toHaveBeenCalledWith(
      expect.objectContaining({ projectGitUrl: "https://github.com/acme/private-repo.git" }),
      expect.objectContaining({ reconciliation: "background" }),
    );
  });

  it("does not block new sessions for a model cooldown", async () => {
    const { context, flow, place } = withMessage({
      modelCatalog: async () => ({ models: [unavailableModel("cooldown")] }),
    });
    const modelControl = place.modelControl;
    modelControl.load(context, "main", true, { agent: place.selectedAgent() });
    await modelControl.metadataRead;
    expectGate(flow);
  });

  it.each(["creating", "dispatching"] as const)(
    "retries a retained personal-account $0 without consulting the neutral draft model",
    async (phase) => {
      const { context, flow, place } = withMessage({
        methods: ["sessions.create", "sessions.dispatch"],
        scopes: adminScopes,
        modelCatalog: async () => ({ models: [unavailableModel("missing-auth")] }),
      });
      place.modelControl.load(context, "main", true, { agent: place.selectedAgent() });
      await place.modelControl.metadataRead;
      expectGate(
        flow,
        "model-unavailable",
        "No provider credential is configured for this model. Set it up in Model Setup.",
      );
      const createParams = restoreCreate(flow, {
        target: { kind: "profile", profileId: "cloud" },
        message: "Resume the original personal-account task",
        createParams: {
          agentId: "main",
          message: "",
          model: "openai/gpt-5.6-luna@personal:person-a:openai:one",
          worktree: true,
        },
      });
      const key = flow.pendingPlacement.sessionKey;
      if (phase === "dispatching") {
        expect(flow.pendingPlacement.promoteToDispatching(key)).toBe(true);
      }
      expect(flow.submitBlock()).toBeUndefined();
      flow.pendingPlacement.recoveryScope = "principal-b";
      expect(flow.submitBlock()?.gate).toBe("placement-recovery");
      flow.pendingPlacement.recoveryScope = "principal-a";
      const hello = context.gateway.snapshot.hello!;
      hello.auth!.scopes = ["operator.read"];
      expect(flow.submitBlock()?.gate).toBe("access");
      hello.auth!.scopes = adminScopes;

      context.placementStartup.start = vi.fn();
      vi.mocked(context.sessions.createResult).mockResolvedValue({
        key,
        initialRun: { status: "idle" },
      });
      vi.mocked(context.navigateAndWait).mockImplementation(readyChatRoute);
      await flow.submit();

      if (phase === "creating") {
        expect(context.sessions.createResult).toHaveBeenCalledExactlyOnceWith(createParams, {
          reconciliation: "background",
          signal: expect.any(AbortSignal),
        });
      } else {
        expect(context.sessions.createResult).not.toHaveBeenCalled();
      }
      expect(context.placementStartup.start).toHaveBeenCalledWith(
        expect.objectContaining({
          recovery: expect.objectContaining({
            sessionKey: key,
            message: "Resume the original personal-account task",
            phase: "dispatching",
          }),
          persistRecovery: true,
          mode: phase === "dispatching" ? "recover" : "dispatch",
        }),
      );
      expect(flow.error).toBeNull();
    },
  );

  it.each([
    { agents: [], gate: "agents" },
    { methods: [], gate: "access" },
  ])("explains the $gate gate", ({ gate, ...options }) => {
    const { flow } = withMessage(options);
    expect(flow.submitBlock()?.gate).toBe(gate);
    expect(flow.canSubmit()).toBe(false);
    expect(flow.submitDisabledReason()).toBe(flow.submitBlock()?.reason);
    expect(flow.submitDisabledReason()).toBeTruthy();
  });

  it("keeps an attempted-submit notice across gates and retires it when ready", async () => {
    const { flow, context } = withMessage();
    const snapshot = context.gateway.snapshot;
    const scopes = snapshot.hello!.auth!.scopes;
    snapshot.phase = "connecting";
    expect(flow.blockedSubmitNotice()).toBeUndefined();
    await flow.submit();
    const firstReason = flow.submitDisabledReason();
    expect(flow.blockedSubmitNotice()).toBe(firstReason);

    snapshot.phase = "connected";
    snapshot.hello!.auth!.scopes = [];
    expect(flow.blockedSubmitNotice()).toBe(flow.submitDisabledReason());
    expect(flow.blockedSubmitNotice()).not.toBe(firstReason);

    snapshot.hello!.auth!.scopes = scopes;
    flow.synchronizeSubmission();
    expect(flow.blockedSubmitNotice()).toBeUndefined();
    snapshot.phase = "connecting";
    expect(flow.blockedSubmitNotice()).toBeUndefined();
  });

  it("retires attempted-submit feedback when the draft is cleared before readiness", async () => {
    const { flow, context } = withMessage();
    const snapshot = context.gateway.snapshot;
    snapshot.phase = "connecting";
    await flow.submit();
    expect(flow.blockedSubmitNotice()).toBeTruthy();

    flow.setMessage("");
    snapshot.phase = "connected";
    flow.synchronizeSubmission();
    expectGate(flow, "empty-draft");
    expect(flow.blockedSubmitNotice()).toBeUndefined();

    snapshot.phase = "connecting";
    flow.synchronizeSubmission();
    expect(flow.blockedSubmitNotice()).toBeUndefined();
    expect(context.sessions.createResult).not.toHaveBeenCalled();
  });

  it.each(["rejected", "write-denied", "forbidden"] as const)(
    "keeps saved worktree submission gated until discovery succeeds (%s)",
    async (result) => {
      replaceBrowserPreference("ws://gateway.example", "main", {
        folder: "/workspace",
        worktree: true,
      });
      const discovery = createDeferred<unknown>();
      let branches = discovery.promise;
      const { context, flow, place } = withMessage({
        scopes:
          result === "forbidden" || result === "write-denied"
            ? ["operator.sessions.read", "operator.sessions.write"]
            : ["operator.read", "operator.write"],
        agents: [agent({ workspaceGit: true, model: { primary: "openai/gpt-5.6-luna" } })],
        request: replies({ "worktrees.branches": () => branches }),
      });

      await flow.submit();
      expect(context.sessions.createResult).not.toHaveBeenCalled();

      const git = { repositoryStatus: "git", branches: ["main"], defaultBranch: "main" };
      const missingScope = result === "write-denied" ? "operator.write" : undefined;
      if (missingScope) {
        discovery.reject(missingScopeError(missingScope));
      } else if (result === "forbidden") {
        discovery.reject(
          new GatewayRequestError({ code: "FORBIDDEN", message: "Git discovery not allowed" }),
        );
      } else {
        discovery.reject(new Error("branch lookup unavailable"));
      }
      await discovery.promise.catch(() => undefined);
      expect(flow.submitBlock()).toEqual({
        gate: "worktree-unavailable",
        reason: missingScope
          ? scopeReason(missingScope)
          : result === "forbidden"
            ? "You don't have permission to check Git for this folder. Ask the person who manages OpenClaw for access."
            : "Couldn't verify Git for this folder. Choose it again to retry.",
      });
      await flow.submit();
      await flow.submit(undefined, true);
      expect(flow.message).toBe("hello");
      flow.setMessage("");
      flow.attachmentDraft.replace([
        { id: "notes", mimeType: "text/plain", fileName: "notes.txt" },
      ]);
      await flow.submit();
      expect(context.sessions.createResult).not.toHaveBeenCalled();
      expect(place.worktree).toBe(true);
      expect(flow.attachmentDraft.attachments).toHaveLength(1);
      flow.attachmentDraft.replace([]);
      flow.setMessage("start something");
      branches = Promise.resolve(git);
      if (missingScope || result === "forbidden") {
        context.gateway.snapshot.hello!.auth!.scopes = adminScopes;
        place.invalidateGatewayDiscovery(false);
        place.adoptAgentDefaults();
      } else {
        place.clearProjectSelection();
      }
      await branches;
      await vi.waitFor(() => expect(flow.canSubmit()).toBe(true));
      expect(flow.blockedSubmitNotice()).toBeUndefined();
      await flow.submit();
      expect(context.sessions.createResult).toHaveBeenCalledWith(
        expect.objectContaining({ worktree: true }),
        expect.anything(),
      );
    },
  );

  it.each(["forbidden", "unavailable"] as const)(
    "explains %s Git discovery for a retained device checkout",
    async (result) => {
      const fixture = deviceFixture(
        "build-mac",
        {
          id: "device-runtime",
          source: "model",
          devicePlacement: { requiredNodeCommands: [], consumesWorkerSlot: false },
        },
        { model: "openai/gpt-5.6-luna" },
      );
      const { request, context, place, flow } = fixture;
      await selectDevice(fixture, "build-mac");
      const discovery = createDeferred<unknown>();
      request.mockImplementation((method) =>
        method === "worktrees.branches" ? discovery.promise : Promise.resolve({}),
      );
      place.applyFolder("/previously-allowed");
      context.gateway.snapshot.hello!.auth!.scopes = ["operator.read", "operator.write"];
      discovery.reject(
        result === "forbidden"
          ? missingScopeError("operator.admin")
          : new Error("Git discovery unavailable"),
      );
      await discovery.promise.catch(() => undefined);
      expectGate(
        flow,
        "worktree-unavailable",
        result === "forbidden"
          ? scopeReason("operator.admin")
          : "This folder cannot provide a Git checkout. Select New workspace to start empty, or choose a repository.",
      );
      await flow.submit();
      expect(context.sessions.createResult).not.toHaveBeenCalled();
      expect(place).toMatchObject({
        deviceId: "build-mac",
        folder: "/previously-allowed",
        worktree: true,
        freshWorkspace: false,
      });
      expect(flow.message).toBe("hello");
    },
  );

  it("requires device metadata, not a support flag, before admitting a retained device", async () => {
    const fixture = deviceFixture(
      "build-mac",
      {
        id: "cloud-only",
        cloudPlacementSupported: true,
        devicePlacementSupported: true,
        source: "model",
      },
      { model: "openai/gpt-5.6-sol" },
    );
    await selectDevice(fixture, "build-mac");

    expectGate(fixture.flow, "device-runtime", "This runtime does not support paired devices");
    expect(fixture.request).not.toHaveBeenCalledWith("node.list", expect.anything());
    const selectedAgent = fixture.place.selectedAgent()!;
    selectedAgent.agentRuntime = {
      ...selectedAgent.agentRuntime!,
      devicePlacement: { requiredNodeCommands: [], consumesWorkerSlot: false },
    };
    expectGate(fixture.flow);
  });
});
