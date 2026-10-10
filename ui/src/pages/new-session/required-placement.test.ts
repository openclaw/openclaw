import { render } from "lit";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import { settleModelCatalogRequests } from "../../lib/model-catalog-store.ts";
import { createDraftFixture } from "./draft-submission-flow.test-support.ts";
import { renderNewSessionPlaceControls } from "./target-controls.ts";

const runtime = {
  id: "openclaw",
  source: "model" as const,
  cloudPlacementSupported: true,
  cloudPlacementExecutionMode: "worker-turn" as const,
  devicePlacement: { requiredNodeCommands: [], consumesWorkerSlot: true },
};
const profile = {
  id: "dedicated",
  providerId: "device",
  inference: "worker",
  executionModes: ["worker-turn"],
};
const catalog = { requiredProfile: profile.id, profiles: [profile], environments: [] };
function fixture(
  request: (method: string) => Promise<unknown> = async () => catalog,
  modelSelectionPolicy?: { restricted: true; defaultModel: string | null },
  modelReady: Promise<void> = Promise.resolve(),
) {
  return createDraftFixture({
    methods: ["environments.list", "sessions.create", "sessions.send", "sessions.describe"],
    scopes: ["operator.read", "operator.write"],
    agents: [
      {
        id: "main",
        workspace: "/workspace",
        model: { primary: "openai/default" },
        agentRuntime: runtime,
      },
    ],
    modelCatalog: async () => {
      await modelReady;
      return {
        ...(modelSelectionPolicy ? { modelSelectionPolicy } : {}),
        models: [
          {
            id: "default",
            provider: "openai",
            name: "Default",
            available: false,
            unavailableReason: "missing-auth",
            agentRuntime: runtime,
            runtimeChoices: [
              {
                available: true,
                agentRuntime: {
                  ...runtime,
                  id: "external-runtime",
                  cloudPlacementExecutionMode: "remote-exec",
                },
              },
            ],
          },
        ],
      };
    },
    placementPolicy: async () => {
      const value = (await request("agents.list")) as {
        requiredProfile?: string;
        profiles?: Array<typeof profile>;
      };
      return {
        sessionPlacement: value.requiredProfile
          ? {
              requiredProfile: {
                id: value.requiredProfile,
                ...value.profiles?.find((entry) => entry.id === value.requiredProfile),
              },
            }
          : {},
      };
    },
    request,
  });
}
async function ready(f: ReturnType<typeof fixture>) {
  await Promise.all([
    f.gateway.refreshCloudProfiles(),
    settleModelCatalogRequests(f.context.gateway.snapshot.client!, { agentId: "main" }),
  ]);
  f.place.restorePreferenceSelections();
  f.flow.setMessage("Inspect the workspace");
}
afterEach(() => {
  vi.restoreAllMocks();
  sessionStorage.clear();
  localStorage.clear();
});

it("starts a required worker for a non-admin without manual placement or workspace choices", async () => {
  const f = fixture();
  await ready(f);
  expect(f.place.cloudProfileId).toBe(profile.id);
  expect(f.place.freshWorkspace).toBe(true);
  expect(f.flow.canSubmit()).toBe(true);
  f.context.placementStartup.start = vi.fn();
  vi.mocked(f.context.sessions.createResult).mockResolvedValue({
    key: "agent:main:required",
    initialRun: { status: "idle" },
  });
  await f.flow.submit(undefined, true);
  expect(f.context.sessions.createResult).toHaveBeenCalledWith(
    expect.objectContaining({ message: "", worktree: true, worktreeSource: "empty" }),
    expect.anything(),
  );
  expect(f.context.placementStartup.start).toHaveBeenCalledWith(
    expect.objectContaining({
      recovery: expect.objectContaining({
        target: { kind: "profile", profileId: profile.id, required: true },
      }),
    }),
  );
  expect(f.request).not.toHaveBeenCalledWith("sessions.dispatch", expect.anything());
});

it("waits for initial policy and never falls back when its required profile is missing", async () => {
  const pending = createDeferred<unknown>();
  const f = fixture(() => pending.promise);
  const read = f.gateway.refreshCloudProfiles();
  f.flow.setMessage("Do not run locally");
  expect(f.flow.canSubmit()).toBe(false);
  pending.resolve({ ...catalog, profiles: [] });
  await read;
  expect(f.place.cloudProfileId).toBe(profile.id);
  expect(f.flow.canSubmit()).toBe(false);
  await f.flow.submit();
  expect(f.context.sessions.createResult).not.toHaveBeenCalled();
});

it("projects the latest policy over cached placement without persisting that policy as a preference", async () => {
  let current: typeof catalog | { profiles: (typeof profile)[]; environments: never[] } = catalog;
  const f = fixture(async () => current);
  await ready(f);
  f.place.selectDevice("");
  expect(f.place.cloudProfileId).toBe(profile.id);
  current = {
    ...catalog,
    requiredProfile: "replacement",
    profiles: [{ ...profile, id: "replacement" }],
  };
  await f.gateway.refreshCloudProfiles();
  expect(f.place.cloudProfileId).toBe("replacement");
  current = { profiles: [], environments: [] };
  await f.gateway.refreshCloudProfiles();
  expect(f.place.cloudProfileId).toBe("");
  expect(f.place.remotePlacement).toBe(false);
});

it("does not use a late catalog from a replaced Gateway", async () => {
  const pending = createDeferred<unknown>();
  const f = fixture(() => pending.promise);
  const read = f.gateway.refreshCloudProfiles();
  f.context.gateway.connection.gatewayUrl = "ws://other.example";
  f.gateway.synchronize(f.context.gateway);
  pending.resolve(catalog);
  await read;
  expect(f.gateway.requiredProfile).toBeUndefined();
  expect(f.flow.canSubmit()).toBe(false);
});

it.each(["worker", "gateway"] as const)(
  "uses %s configured defaults instead of a cached external runtime without deleting preferences",
  async (inference) => {
    const f = fixture(async () => ({ ...catalog, profiles: [{ ...profile, inference }] }));
    const preference = {
      model: "openai/default",
      agentRuntime: "external-runtime",
      where: { kind: "local" as const },
      folder: "/old-project",
      freshWorkspace: false,
    };
    vi.spyOn(f.gateway, "readPreference").mockReturnValue(preference);
    f.place.modelControl.load(f.context, "main", true, {
      agent: f.place.selectedAgent(),
      preference,
    });
    await settleModelCatalogRequests(f.context.gateway.snapshot.client!, { agentId: "main" });
    expect(f.place.modelControl.agentRuntime).toBe("external-runtime");
    await ready(f);
    expect(f.place.modelControl.modelForSubmission()).toBe("");
    expect(f.place.modelControl.agentRuntime).toBeUndefined();
    expect(f.place.devicePlacementRuntime()?.id).toBe("openclaw");
    expect(f.flow.canSubmit()).toBe(inference === "worker");
    expect(f.gateway.readPreference("main")).toEqual(preference);
    f.place.modelControl.selected = "openai/default";
    expect(f.flow.submitBlock()?.gate).toBe("model-unavailable");
  },
);

it("does not grant a model or write permission through required worker metadata", async () => {
  const restricted = fixture(undefined, { restricted: true, defaultModel: null });
  await ready(restricted);
  expect(restricted.flow.canSubmit()).toBe(false);
  const f = fixture();
  await ready(f);
  f.context.gateway.snapshot.hello!.auth!.scopes = ["operator.read"];
  expect(f.flow.submitBlock()?.gate).toBe("access");
});

it("keeps local submission when the authoritative catalog has no required policy", async () => {
  const f = createDraftFixture({
    methods: ["environments.list", "sessions.create"],
    request: async () => ({ profiles: [], environments: [] }),
  });
  await f.gateway.refreshCloudProfiles();
  f.flow.setMessage("Start normally");
  expect(f.place.remotePlacement).toBe(false);
  expect(f.flow.canSubmit()).toBe(true);
});

it("renders required placement as a readonly indicator, not a machine or workspace picker", async () => {
  const f = fixture();
  await ready(f);
  const container = document.createElement("div");
  render(
    renderNewSessionPlaceControls({
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
    }),
    container,
  );
  expect(container.textContent).toContain("OpenClaw worker");
  expect(container.querySelector("[data-required-placement]")).not.toBeNull();
  expect(container.querySelector("button, input, wa-popover")).toBeNull();
});

it("keeps an initial failed catalog closed and allows its existing refresh owner to recover", async () => {
  vi.useFakeTimers();
  let fails = true;
  const f = fixture(async () => {
    if (fails) {
      throw new Error("offline");
    }
    return catalog;
  });
  try {
    await f.gateway.refreshCloudProfiles();
    f.flow.setMessage("Wait for policy");
    expect(f.flow.canSubmit()).toBe(false);
    expect(f.flow.requiresModelSetup()).toBe(false);
    fails = false;
    await ready(f);
    expect(f.flow.canSubmit()).toBe(true);
  } finally {
    f.gateway.disconnect();
    vi.useRealTimers();
  }
});

it("keeps a server startup failure with the created session for Retry rather than sending or creating again", async () => {
  const f = fixture();
  await ready(f);
  f.context.placementStartup.start = vi.fn();
  vi.mocked(f.context.sessions.createResult).mockResolvedValue({
    key: "agent:main:failed-required",
    initialRun: { status: "rejected", error: "Required worker is offline" },
  });
  await f.flow.submit(undefined, true);
  expect(f.context.sessions.createResult).toHaveBeenCalledOnce();
  expect(f.context.placementStartup.start).toHaveBeenCalledWith(
    expect.objectContaining({
      recovery: expect.objectContaining({
        sessionKey: "agent:main:failed-required",
        phase: "paused",
        reason: "not-sent",
        error: "Required worker is offline",
      }),
    }),
  );
  expect(f.request).not.toHaveBeenCalledWith("sessions.send", expect.anything());
});

it("retires an open placement picker once when policy takes over, without a render loop", async () => {
  const f = fixture();
  await ready(f);
  const close = vi.spyOn(f.place.browser, "close");
  f.place.browser.popoverCallbacks("where").onPopoverShow();
  f.place.restorePreferenceSelections();
  f.place.restorePreferenceSelections();
  expect(close).toHaveBeenCalledOnce();
});

it("keeps a cold required-worker draft on configured defaults across asynchronous catalogs", async () => {
  const place = createDeferred<unknown>();
  const modelsReady = createDeferred();
  const f = fixture(() => place.promise, undefined, modelsReady.promise);
  const read = f.gateway.refreshCloudProfiles();
  f.flow.setMessage("Use the worker without choosing a model");
  expect(f.flow.canSubmit()).toBe(false);
  place.resolve(catalog);
  await read;
  f.place.restorePreferenceSelections();
  modelsReady.resolve();
  await settleModelCatalogRequests(f.context.gateway.snapshot.client!, { agentId: "main" });
  f.place.restorePreferenceSelections();
  expect(f.place.modelControl.modelForSubmission()).toBe("");
  expect(f.place.modelControl.agentRuntime).toBeUndefined();
  expect(f.flow.canSubmit()).toBe(true);
});

it.each([false, true])(
  "allows a session-only writer without inventory (required=%s)",
  async (required) => {
    const f = createDraftFixture({
      methods: ["agents.list", "environments.list", "sessions.create", "sessions.send"],
      scopes: ["operator.sessions.write"],
      placementPolicy: async () => ({
        sessionPlacement: required ? { requiredProfile: profile } : {},
      }),
      request: async (method) => {
        if (method === "environments.list") {
          throw new Error("missing scope: operator.write");
        }
        return {};
      },
    });
    try {
      await f.gateway.refreshCloudProfiles();
      f.flow.setMessage("Start my own session");
      expect(f.gateway.placementPolicyReady).toBe(true);
      expect(f.place.requiredPlacement).toBe(required);
      expect(f.flow.submitBlock()).toBeUndefined();
      expect(f.flow.canSubmit()).toBe(true);
      expect(f.request.mock.calls.some(([method]) => method === "environments.list")).toBe(false);
    } finally {
      f.gateway.disconnect();
    }
  },
);

it("does not hold an ordinary local start behind unrelated pending inventory", async () => {
  const inventory = createDeferred<unknown>();
  const entered = createDeferred();
  const f = createDraftFixture({
    methods: ["agents.list", "environments.list", "sessions.create"],
    request: async (method) => {
      if (method === "agents.list") {
        return { sessionPlacement: {} };
      }
      if (method === "environments.list") {
        entered.resolve();
        return inventory.promise;
      }
      return {};
    },
  });
  const refresh = f.gateway.refreshCloudProfiles();
  try {
    await entered.promise;
    f.flow.setMessage("Run locally now");
    expect(f.gateway.placementPolicyReady).toBe(true);
    expect(f.flow.canSubmit()).toBe(true);
  } finally {
    inventory.resolve({ profiles: [], environments: [] });
    await refresh;
    f.gateway.disconnect();
  }
});

it.each(["grant", "gateway"] as const)(
  "fences an old policy after a %s change with identical agent/profile labels",
  async (change) => {
    const held = createDeferred<unknown>();
    let current = held.promise;
    const f = createDraftFixture({
      methods: ["agents.list", "environments.list", "sessions.create", "sessions.send"],
      selfUser: { id: "same-profile" },
      placementPolicy: () => current,
      request: async () => ({ profiles: [], environments: [] }),
    });
    const pending = f.gateway.refreshCloudProfiles();
    try {
      current = Promise.resolve({ sessionPlacement: {} });
      if (change === "grant") {
        f.context.gateway.snapshot.hello!.auth!.scopes = ["operator.sessions.write"];
      } else {
        f.context.gateway.connection.gatewayUrl = "ws://second.example";
        const server = f.context.gateway.snapshot.hello?.server;
        if (!server) {
          throw new Error("Fixture Gateway hello is missing its server identity");
        }
        server.bootId = "second-boot";
      }
      f.gateway.synchronize(f.context.gateway);
      await f.gateway.refreshCloudProfiles();
      held.resolve({ sessionPlacement: { requiredProfile: profile } });
      await pending;
      f.flow.setMessage("Use the current Gateway and grant");
      expect(f.gateway.requiredProfile).toBeUndefined();
      expect(f.gateway.placementPolicyReady).toBe(true);
      expect(f.flow.canSubmit()).toBe(true);
      if (change === "grant") {
        expect(f.request.mock.calls.some(([method]) => method === "environments.list")).toBe(false);
      }
    } finally {
      held.resolve({ sessionPlacement: {} });
      f.gateway.disconnect();
    }
  },
);

it("does not invent worker-turn support for the required provider", async () => {
  const f = fixture(async () => ({ ...catalog, profiles: [{ ...profile, executionModes: [] }] }));
  try {
    await ready(f);
    expect(f.gateway.requiredProfile).toBe(profile.id);
    expect(f.flow.canSubmit()).toBe(false);
    await f.flow.submit();
    expect(f.context.sessions.createResult).not.toHaveBeenCalled();
  } finally {
    f.gateway.disconnect();
  }
});
