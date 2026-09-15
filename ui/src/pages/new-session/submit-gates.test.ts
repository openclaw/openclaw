import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import { CHAT_ROUTE_READY_EVENT } from "../chat/chat-history-events.ts";
import { CLOUD_PROFILE_RETRY_DELAYS_MS } from "./cloud-profile-discovery.ts";
import { resolveDraftSessionPlacement } from "./draft-session-placement.ts";
import { createDraftFixture } from "./draft-submission-flow.test-support.ts";
import { renderControl } from "./model-control.test-support.ts";
import { patchNewSessionPreference } from "./preferences.ts";

// The closed list of gates allowed to block without a visible reason: the busy
// Start button and an empty draft explain themselves. Growing it is a product
// decision — edit this list and the matching one in submit-gates.ts together.
const SILENT_SUBMIT_GATES = ["submitting", "empty-draft"];

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  sessionStorage.clear();
  localStorage.clear();
});

describe("DraftSubmissionFlow submit gates", () => {
  it("does not wait for preference migration writes or reapply them over user edits", async () => {
    const migration = createDeferred<{ status: "ok" }>();
    const fixture = createDraftFixture({
      methods: ["users.prefs.get", "users.prefs.set", "sessions.create"],
      selfUser: { id: "proof-user" },
      request: async (method) =>
        method === "users.prefs.get"
          ? { status: "ok", entries: {} }
          : method === "users.prefs.set"
            ? migration.promise
            : {},
    });
    try {
      fixture.flow.setMessage("Start after preferences are read");
      await vi.waitFor(() => expect(fixture.gateway.preferenceLoading).toBe(false));
      expect(fixture.request).toHaveBeenCalledWith("users.prefs.set", expect.anything());
      expect(fixture.flow.canSubmit()).toBe(true);
      fixture.place.applyFolder("/edited-workspace");
      migration.resolve({ status: "ok" });
      await migration.promise;
      await Promise.resolve();
      expect(fixture.place.folder).toBe("/edited-workspace");
      expect(fixture.flow.canSubmit()).toBe(true);
    } finally {
      migration.resolve({ status: "ok" });
      fixture.gateway.disconnect();
    }
  });

  it("keeps a retained Cloud target usable through pending refresh, retry exhaustion and recovery", async () => {
    const profiles = [
      {
        id: "aws",
        providerId: "crabbox",
        machines: [
          { id: "standard", label: "Standard", default: true },
          { id: "fast", label: "Fast" },
        ],
      },
    ];
    const pending = createDeferred<{ environments: []; profiles: typeof profiles }>();
    let outcome: "ready" | "pending" | "failed" | "missing" = "ready";
    let reads = 0;
    const fixture = createDraftFixture({
      methods: ["environments.list", "sessions.create", "sessions.dispatch"],
      scopes: ["operator.admin", "operator.read", "operator.write"],
      request: async (method, params) => {
        if (method !== "environments.list") {
          return {};
        }
        if ((params as { includeProfiles?: boolean }).includeProfiles === false) {
          return {
            environments: [
              {
                id: "node:ready",
                type: "node",
                status: "available",
                sessionHost: true,
                workerSlots: { total: 2, available: 1 },
              },
            ],
          };
        }
        reads += 1;
        if (outcome === "pending") {
          return pending.promise;
        }
        if (outcome === "failed") {
          throw new Error("catalog outage");
        }
        return { environments: [], profiles: outcome === "missing" ? [] : profiles };
      },
    });
    try {
      await fixture.gateway.refreshCloudProfiles();
      await fixture.gateway.refreshEnvironments();
      fixture.place.selectCloudProfile("aws");
      expect(fixture.place.cloudMachines.select("aws", "fast", fixture.gateway.cloudProfiles)).toBe(
        true,
      );
      fixture.flow.setMessage("Keep exactly this Cloud destination");
      const placement = () =>
        resolveDraftSessionPlacement(fixture.flow.pendingPlacement, fixture.place).target;
      const target = placement();
      expect(target).toMatchObject({ kind: "profile", profileId: "aws", machineClass: "fast" });
      expect(fixture.flow.submitBlock()).toBeUndefined();

      outcome = "pending";
      const refresh = fixture.gateway.refreshCloudProfiles();
      expect(fixture.gateway.cloudProfilesPending).toBe(true);
      expect(fixture.flow.submitBlock()).toBeUndefined();
      vi.useFakeTimers();
      outcome = "failed";
      pending.reject(new Error("catalog outage"));
      await refresh;
      for (const delay of CLOUD_PROFILE_RETRY_DELAYS_MS) {
        await vi.advanceTimersByTimeAsync(delay);
        expect(fixture.gateway.cloudProfilesError).toBe(true);
        expect(fixture.gateway.cloudProfiles).toEqual(profiles);
        expect(placement()).toEqual(target);
        expect(fixture.flow.submitBlock()).toBeUndefined();
      }
      const exhaustedReads = reads;
      await vi.advanceTimersByTimeAsync(120_000);
      expect(reads).toBe(exhaustedReads);
      fixture.place.selectDevice("ready");
      expect(fixture.flow.submitBlock()).toBeUndefined();
      fixture.place.selectDevice("");
      expect(fixture.flow.submitBlock()).toBeUndefined();
      fixture.place.selectCloudProfile("aws");
      expect(placement()).toEqual(target);

      outcome = "ready";
      await fixture.gateway.refreshCloudProfiles();
      expect(fixture.gateway.cloudProfilesError).toBe(false);
      expect(fixture.flow.submitBlock()).toBeUndefined();
      outcome = "missing";
      await fixture.gateway.refreshCloudProfiles();
      expect(fixture.place.cloudProfileId).toBe("aws");
      expect(placement()).toEqual(target);
      expect(fixture.flow.submitBlock()?.gate).toBe("cloud");
      expect(fixture.context.sessions.createResult).not.toHaveBeenCalled();
    } finally {
      pending.resolve({ environments: [], profiles });
      fixture.gateway.disconnect();
      vi.useRealTimers();
    }
  });

  it.each(["complete", "failure"] as const)(
    "keeps a ready node start independent of cloud %s",
    async (outcome) => {
      const cloud = createDeferred<{ environments: unknown[]; profiles: unknown[] }>();
      const fixture = createDraftFixture({
        methods: ["environments.list", "sessions.create", "sessions.dispatch"],
        scopes: ["operator.admin", "operator.read", "operator.write"],
        request: async (method, params) =>
          method === "environments.list"
            ? (params as { includeProfiles?: boolean }).includeProfiles === false
              ? {
                  environments: [
                    {
                      id: "node:ready",
                      type: "node",
                      status: "available",
                      sessionHost: true,
                      workerSlots: { total: 2, available: 1 },
                    },
                  ],
                }
              : cloud.promise
            : {},
      });
      const loading = fixture.gateway.refreshCloudProfiles();
      try {
        await fixture.gateway.refreshEnvironments();
        fixture.place.selectDevice("ready");
        fixture.flow.setMessage("Use exactly the selected node");
        expect(fixture.gateway.cloudProfilesPending).toBe(true);
        expect(fixture.place.deviceId).toBe("ready");
        expect(fixture.flow.submitBlock()).toBeUndefined();
        fixture.flow.setError("The selected node rejected the start");
        if (outcome === "complete") {
          cloud.resolve({ environments: [], profiles: [{ id: "cloud", providerId: "test" }] });
        } else {
          cloud.reject(new Error("cloud discovery unavailable"));
        }
        await loading;
        expect(fixture.gateway.cloudProfilesPending).toBe(false);
        expect(fixture.gateway.cloudProfilesError).toBe(outcome === "failure");
        expect(fixture.flow.error).toBe("The selected node rejected the start");
        expect(fixture.place.deviceId).toBe("ready");
        expect(fixture.flow.submitBlock()).toBeUndefined();
      } finally {
        cloud.resolve({ environments: [], profiles: [] });
        await loading;
        fixture.gateway.disconnect();
      }
    },
  );

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
    { reason: undefined, message: undefined },
  ] as const)(
    "blocks new sessions only for actionable $reason model availability",
    async ({ reason, message }) => {
      const { context, flow, place } = createDraftFixture({
        modelCatalog: async () => ({
          models: [
            {
              id: "gpt-5.6-luna",
              name: "GPT-5.6 Luna",
              provider: "openai",
              available: false,
              unavailableReason: reason,
            },
          ],
        }),
      });
      place.modelControl.load(context, "main", true, { agent: place.selectedAgent() });
      await vi.waitFor(() =>
        expect(
          renderControl(
            place.modelControl,
            context,
            "main",
            place.selectedAgent(),
          ).querySelectorAll("[data-chat-model-option]"),
        ).toHaveLength(1),
      );
      flow.setMessage("Start this session");
      expect(flow.submitBlock()).toEqual(
        message ? { gate: "model-unavailable", reason: message } : undefined,
      );
      expect(flow.canSubmit()).toBe(message === undefined);
    },
  );

  it.each(["creating", "dispatching"] as const)(
    "retries a retained personal-account $0 without consulting the neutral draft model",
    async (phase) => {
      const { context, flow, place } = createDraftFixture({
        methods: ["sessions.create", "sessions.dispatch"],
        scopes: ["operator.admin", "operator.read", "operator.write"],
        modelCatalog: async () => ({
          models: [
            {
              id: "gpt-5.6-luna",
              provider: "openai",
              available: false,
              unavailableReason: "missing-auth",
            },
          ],
        }),
      });
      place.modelControl.load(context, "main", true, { agent: place.selectedAgent() });
      await vi.waitFor(() =>
        expect(place.modelControl.modelUnavailableReason(place.selectedAgent())).toBe(
          "missing-auth",
        ),
      );
      const createParams = flow.pendingPlacement.stageCreate({
        agentId: "main",
        target: { kind: "profile", profileId: "cloud" },
        message: "Resume the original personal-account task",
        gatewayUrl: "ws://gateway.example",
        recoveryScope: "principal-a",
        createParams: {
          agentId: "main",
          message: "",
          model: "openai/gpt-5.6-luna@personal:person-a:openai:one",
          worktree: true,
        },
      });
      expect(createParams).not.toBeNull();
      flow.releasePendingPlacementOwner();
      flow.restorePendingPlacementRecovery("ws://gateway.example", "principal-a");
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
      hello.auth!.scopes = ["operator.admin", "operator.read", "operator.write"];

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
        recovering: phase === "dispatching",
        createdAt: expect.any(Number),
      });
      expect(flow.error).toBeNull();
    },
  );

  it("keeps every blocking gate visible: canSubmit and the reason derive from one table", () => {
    const scenarios: Array<{ name: string; build: () => ReturnType<typeof createDraftFixture> }> = [
      { name: "empty draft", build: () => createDraftFixture() },
      {
        name: "gateway disconnected",
        build: () => {
          const fixture = createDraftFixture({ phase: "connecting" });
          fixture.flow.setMessage("hello");
          return fixture;
        },
      },
      {
        name: "attachment reads pending",
        build: () => {
          const fixture = createDraftFixture();
          fixture.flow.setMessage("hello");
          fixture.flow.attachmentDraft.updatePending(fixture.flow.attachmentDraft.readSignal, 1);
          return fixture;
        },
      },
      {
        name: "no agents on the gateway",
        build: () => {
          const fixture = createDraftFixture({ agents: [] });
          fixture.flow.setMessage("hello");
          return fixture;
        },
      },
      {
        name: "sessions.create not advertised",
        build: () => {
          const fixture = createDraftFixture({ methods: [] });
          fixture.flow.setMessage("hello");
          return fixture;
        },
      },
      {
        name: "submission outcome unknown",
        build: () => {
          const fixture = createDraftFixture();
          fixture.flow.setMessage("hello");
          fixture.flow.markPendingPlacementUnavailable("gateway-changed");
          return fixture;
        },
      },
    ];
    for (const scenario of scenarios) {
      const { flow } = scenario.build();
      const block = flow.submitBlock();
      expect(block, scenario.name).toBeDefined();
      expect(flow.canSubmit(), scenario.name).toBe(false);
      if (!(SILENT_SUBMIT_GATES as readonly string[]).includes(block?.gate ?? "")) {
        // A reasoned gate must explain itself, and the Start tooltip must
        // report the same first-gate reason canSubmit blocks on.
        expect(block?.reason, scenario.name).toBeTruthy();
        expect(flow.submitDisabledReason(), scenario.name).toBe(block?.reason);
      }
    }

    const ready = createDraftFixture();
    ready.flow.setMessage("hello");
    expect(ready.flow.submitBlock()).toBeUndefined();
    expect(ready.flow.canSubmit()).toBe(true);
    expect(ready.flow.submitDisabledReason()).toBeUndefined();
  });

  it("surfaces a reason for Enter during worktree preference restore, then clears it", async () => {
    patchNewSessionPreference("ws://gateway.example", "main", {
      folder: "/workspace",
      worktree: true,
    });
    let resolveBranches!: (value: unknown) => void;
    const fixture = createDraftFixture({
      scopes: ["operator.admin", "operator.read", "operator.write"],
      agents: [
        {
          id: "main",
          workspace: "/workspace",
          workspaceGit: true,
          model: { primary: "openai/gpt-5.6-luna" },
        },
      ],
      request: (method) => {
        if (method === "worktrees.branches") {
          return new Promise((resolve) => {
            resolveBranches = resolve;
          });
        }
        return Promise.resolve({});
      },
    });
    const { context, flow } = fixture;
    flow.setMessage("start something");

    // The async preference restore is still in flight: submission is gated,
    // but the gate must be visible, not a silent no-op.
    expect(flow.canSubmit()).toBe(false);
    expect(flow.submitDisabledReason()).toBeTruthy();
    expect(flow.blockedSubmitNotice()).toBeUndefined();

    await flow.submit();
    expect(context.sessions.createResult).not.toHaveBeenCalled();
    expect(flow.blockedSubmitNotice()).toBe(flow.submitDisabledReason());

    resolveBranches({ repositoryStatus: "git", branches: ["main"], defaultBranch: "main" });
    await vi.waitFor(() => expect(flow.canSubmit()).toBe(true));
    // The transient gate lifted; the notice retires itself.
    expect(flow.blockedSubmitNotice()).toBeUndefined();
    expect(flow.submitDisabledReason()).toBeUndefined();
  });

  it("does not raise a notice for the silent empty-draft gate", async () => {
    const fixture = createDraftFixture();
    await fixture.flow.submit();
    expect(fixture.flow.canSubmit()).toBe(false);
    expect(fixture.flow.submitBlock()?.gate).toBe("empty-draft");
    expect(fixture.flow.blockedSubmitNotice()).toBeUndefined();
  });

  it("blocks a retained device choice when the selected runtime cannot dispatch there", async () => {
    const fixture = createDraftFixture({
      methods: ["environments.list", "sessions.create", "sessions.dispatch"],
      scopes: ["operator.admin", "operator.read", "operator.write"],
      agents: [
        {
          id: "main",
          workspace: "/workspace",
          workspaceGit: false,
          model: { primary: "openai/gpt-5.6-sol" },
          agentRuntime: {
            id: "cloud-only",
            cloudPlacementSupported: true,
            devicePlacementSupported: false,
            source: "model",
          },
        },
      ],
      request: async (method) =>
        method === "environments.list"
          ? {
              environments: [
                {
                  id: "node:build-mac",
                  type: "node",
                  label: "Build Mac",
                  status: "available",
                  sessionHost: true,
                  workerSlots: { total: 1, available: 1 },
                },
              ],
              profiles: [],
            }
          : {},
    });
    await fixture.gateway.refreshEnvironments();
    await vi.waitFor(() => expect(fixture.place.devices()).toHaveLength(1));
    fixture.place.selectDevice("build-mac");
    fixture.flow.setMessage("run on the device");

    expect(fixture.flow.submitBlock()).toEqual({
      gate: "device-runtime",
      reason: "This runtime does not support paired devices",
    });
    expect(fixture.flow.canSubmit()).toBe(false);
    expect(fixture.flow.submitDisabledReason()).toBe(
      "This runtime does not support paired devices",
    );
    expect(fixture.request).not.toHaveBeenCalledWith("node.list", expect.anything());
  });
});

it("keeps attachment preparation gated without duplicating its composer status after Start", async () => {
  const { flow, context } = createDraftFixture();
  flow.setMessage("Include the pending attachment");
  const signal = flow.attachmentDraft.readSignal;
  flow.attachmentDraft.updatePending(signal, 1);
  expect(flow.submitBlock()?.gate).toBe("attachment-reads");
  expect(flow.canSubmit()).toBe(false);
  expect(flow.submitDisabledReason()).toBe("Reading attachment");

  await flow.submit();

  expect(context.sessions.createResult).not.toHaveBeenCalled();
  expect(flow.blockedSubmitNotice()).toBeUndefined();
  flow.attachmentDraft.updatePending(signal, -1);
  expect(flow.canSubmit()).toBe(true);
});
