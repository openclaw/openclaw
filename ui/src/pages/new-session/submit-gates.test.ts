import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ProjectsCheckoutOptionsResult,
  ProjectsListResult,
} from "../../../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import { CHAT_ROUTE_READY_EVENT } from "../chat/chat-history-events.ts";
import { createDraftFixture } from "./draft-submission-flow.test-support.ts";
import { renderControl } from "./model-control.test-support.ts";
import { replaceBrowserPreference } from "./preferences.ts";

// Keep the intentional silent gates in sync with submit-gates.ts.
const SILENT_SUBMIT_GATES = ["submitting", "empty-draft"];
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
function withMessage(options: FixtureOptions = {}, setup?: (fixture: Fixture) => void) {
  const fixture = createDraftFixture(options);
  fixture.flow.setMessage("hello");
  setup?.(fixture);
  return fixture;
}
function unavailableModel(reason: "missing-auth" | "auth-failed" | "cooldown") {
  return { id: "gpt-5.6-luna", provider: "openai", available: false, unavailableReason: reason };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  sessionStorage.clear();
  localStorage.clear();
});

describe("DraftSubmissionFlow submit gates", () => {
  it.each(["registered", "cloned"] as const)(
    "submits a guest's path-redacted %s project as an isolated worktree",
    async (source) => {
      const availability = createDeferred<ProjectsCheckoutOptionsResult>();
      const { place, flow, context, request } = withMessage({
        scopes: ["operator.sessions.read", "operator.sessions.write"],
        methods: projectMethods,
        selfUser: { id: "guest" },
        request: replies({
          "projects.list": async () => ({
            projects: [{ id: "registered", displayName: "Registered Project", source }],
          }),
          "projects.checkoutOptions": () => availability.promise,
          "worktrees.branches": async () => {
            throw new Error("missing scope: operator.write");
          },
        }),
      });
      await place.browser.refreshProjects();
      place.selectProjectId("registered");
      expect(place.checkoutVisible).toBe(true);
      expect(flow.canSubmit()).toBe(false);
      availability.resolve({ current: false, worktree: true });
      await availability.promise;
      expect(place.worktree).toBe(true);
      expect(flow.submitBlock()).toBeUndefined();
      vi.mocked(context.sessions.createResult).mockRejectedValueOnce(
        new Error("project registered is unavailable; re-register the project"),
      );
      await flow.submit();
      expect(context.sessions.createResult).toHaveBeenCalledOnce();
      const params = vi.mocked(context.sessions.createResult).mock.calls[0]?.[0];
      expect(params).toMatchObject({ projectId: "registered", worktree: true });
      expect(params).not.toHaveProperty("worktreeBaseRef");
      expect(params).not.toHaveProperty("cwd");
      expect(flow.error).toContain("re-register the project");
      expect(place.worktree).toBe(true);
      expect(place.browser.projectId).toBe("registered");
      expect(flow.submitBlock()).toBeUndefined();
      expect(request.mock.calls.filter(([method]) => method === "worktrees.branches")).toEqual([]);
    },
  );

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
      expect(context.sessions.createResult).toHaveBeenCalledOnce();
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
    expect(place.browser.projectsLoading).toBe(true);
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

  it.each([
    {
      reason: "missing-auth",
      message: "No provider credential is configured for this model. Set it up in Model Setup.",
    },
    {
      reason: "auth-failed",
      message: "Authentication failed. Review the provider credential or sign-in, then retry.",
    },
    { reason: "cooldown", message: undefined },
  ] as const)(
    "blocks new sessions only for actionable $reason model availability",
    async ({ reason, message }) => {
      const { context, flow, place } = withMessage({
        modelCatalog: async () => ({
          models: [{ ...unavailableModel(reason), name: "GPT-5.6 Luna" }],
        }),
      });
      const modelControl = place.modelControl;
      modelControl.load(context, "main", true, { agent: place.selectedAgent() });
      await vi.waitFor(() =>
        expect(
          renderControl(modelControl, context, "main", place.selectedAgent()).querySelectorAll(
            "[data-chat-model-option]",
          ),
        ).toHaveLength(1),
      );
      expectGate(flow, message ? "model-unavailable" : undefined, message);
    },
  );

  it.each(["creating", "dispatching"] as const)(
    "retries a retained personal-account $0 without consulting the neutral draft model",
    async (phase) => {
      const { context, flow, place } = createDraftFixture({
        methods: ["sessions.create", "sessions.dispatch"],
        scopes: adminScopes,
        modelCatalog: async () => ({ models: [unavailableModel("missing-auth")] }),
      });
      place.modelControl.load(context, "main", true, { agent: place.selectedAgent() });
      await vi.waitFor(() =>
        expect(place.modelControl.modelUnavailableReason(place.selectedAgent())).toBe(
          "missing-auth",
        ),
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
      expect(createParams).not.toBeNull();
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
      vi.mocked(context.navigateAndWait).mockImplementation(async () => {
        queueMicrotask(() => document.dispatchEvent(new Event(CHAT_ROUTE_READY_EVENT)));
      });
      await flow.submit();

      if (phase === "creating") {
        expect(context.sessions.createResult).toHaveBeenCalledExactlyOnceWith(createParams, {
          reconciliation: "background",
          signal: expect.any(AbortSignal),
        });
      } else {
        expect(context.sessions.createResult).not.toHaveBeenCalled();
      }
      expect(context.placementStartup.start).toHaveBeenCalledExactlyOnceWith({
        recovery: expect.objectContaining({
          sessionKey: key,
          message: "Resume the original personal-account task",
          phase: "dispatching",
        }),
        persistRecovery: true,
        mode: phase === "dispatching" ? "recover" : "dispatch",
        createdAt: expect.any(Number),
      });
      expect(flow.error).toBeNull();
    },
  );

  it.each([
    ["empty draft", () => createDraftFixture()],
    ["gateway disconnected", () => withMessage({ phase: "connecting" })],
    [
      "attachment reads pending",
      () =>
        withMessage({}, ({ flow }) =>
          flow.attachmentDraft.reads.updatePending(flow.attachmentDraft.reads.readSignal, 1),
        ),
    ],
    ["no agents", () => withMessage({ agents: [] })],
    ["sessions.create absent", () => withMessage({ methods: [] })],
    [
      "outcome unknown",
      () => withMessage({}, ({ flow }) => flow.markPendingPlacementUnavailable("gateway-changed")),
    ],
  ] as const)("keeps the %s gate visible", (_name, build) => {
    const { flow } = build();
    const block = flow.submitBlock();
    expect(block).toBeDefined();
    expect(flow.canSubmit()).toBe(false);
    if (!(SILENT_SUBMIT_GATES as readonly string[]).includes(block?.gate ?? "")) {
      expect(block?.reason).toBeTruthy();
      expect(flow.submitDisabledReason()).toBe(block?.reason);
    }
  });

  it("admits a ready draft without a disabled reason", () => {
    const { flow } = withMessage();
    expectGate(flow);
  });

  it.each(["unavailable", "rejected"] as const)(
    "keeps saved worktree submission gated until discovery succeeds (%s)",
    async (result) => {
      replaceBrowserPreference("ws://gateway.example", "main", {
        folder: "/workspace",
        worktree: true,
      });
      const discovery = createDeferred<unknown>();
      let branches = discovery.promise;
      const { context, flow, place } = withMessage({
        scopes: adminScopes,
        agents: [agent({ workspaceGit: true, model: { primary: "openai/gpt-5.6-luna" } })],
        request: replies({ "worktrees.branches": () => branches }),
      });

      expect(flow.canSubmit()).toBe(false);
      expect(flow.submitDisabledReason()).toBeTruthy();
      expect(flow.blockedSubmitNotice()).toBeUndefined();

      await flow.submit();
      expect(context.sessions.createResult).not.toHaveBeenCalled();
      expect(flow.blockedSubmitNotice()).toBe(flow.submitDisabledReason());

      const git = { repositoryStatus: "git", branches: ["main"], defaultBranch: "main" };
      if (result === "rejected") {
        discovery.reject(new Error("branch lookup unavailable"));
      } else {
        discovery.resolve({ ...git, repositoryStatus: result });
      }
      await discovery.promise.catch(() => undefined);
      expect(place.repository.kind).toBe("unavailable");
      expect(place.preferenceSelection().worktree).toBe(true);
      expect(flow.submitBlock()).toEqual({
        gate: "worktree-unavailable",
        reason: "Couldn't verify Git for this folder. Choose it again to retry.",
      });
      await flow.submit();
      await flow.submit(undefined, true);
      flow.setMessage("");
      flow.attachmentDraft.replace([
        { id: "notes", mimeType: "text/plain", fileName: "notes.txt" },
      ]);
      await flow.submit();
      expect(context.sessions.createResult).not.toHaveBeenCalled();
      flow.attachmentDraft.replace([]);
      flow.setMessage("start something");
      branches = Promise.resolve(git);
      place.clearProjectSelection();
      await branches;
      await vi.waitFor(() => expect(flow.canSubmit()).toBe(true));
      expect(flow.blockedSubmitNotice()).toBeUndefined();
      expect(flow.submitDisabledReason()).toBeUndefined();
      await flow.submit();
      expect(context.sessions.createResult).toHaveBeenCalledWith(
        expect.objectContaining({ worktree: true }),
        expect.anything(),
      );
    },
  );

  it("blocks a retained device choice when the selected runtime cannot dispatch there", async () => {
    const fixture = deviceFixture(
      "build-mac",
      {
        id: "cloud-only",
        cloudPlacementSupported: true,
        devicePlacementSupported: false,
        source: "model",
      },
      { model: "openai/gpt-5.6-sol" },
    );
    await fixture.gateway.refreshCloudProfiles();
    await vi.waitFor(() => expect(fixture.place.devices()).toHaveLength(1));
    fixture.place.selectDevice("build-mac");

    expectGate(fixture.flow, "device-runtime", "This runtime does not support paired devices");
    expect(fixture.request).not.toHaveBeenCalledWith("node.list", expect.anything());
  });
});
