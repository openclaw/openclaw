import { createComponent } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import { loadModelCatalog } from "../../lib/model-catalog-store.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { createDraftFixture } from "./draft-submission-flow.test-support.ts";
import { NewSessionPlaceControls } from "./target-controls-view.tsx";

const runtime = {
  id: "openclaw",
  source: "model" as const,
  cloudPlacementSupported: true,
  cloudPlacementExecutionMode: "worker-turn" as const,
  devicePlacement: { requiredNodeCommands: [], consumesWorkerSlot: true },
};
const hostedRuntime = {
  id: "agentsapi",
  source: "model" as const,
  cloudPlacementSupported: false,
  workspaceEnvironment: { kind: "provider-hosted" as const, label: "OpenAI (Agents API)" },
};
const profile = {
  id: "dedicated",
  providerId: "device",
  inference: "worker",
  executionModes: ["worker-turn"],
};
const catalog = { requiredProfile: profile.id, profiles: [profile], environments: [] };
const optionalCatalog = { profiles: [], environments: [] };
const model = () => ({
  id: "default",
  provider: "openai",
  name: "Default",
  available: false,
  unavailableReason: "missing-auth",
  agentRuntime: runtime,
  runtimeChoices: [
    hostedRuntime,
    { ...runtime, id: "external-runtime", cloudPlacementExecutionMode: "remote-exec" },
  ].map((agentRuntime) => ({ agentRuntime, available: true })),
});
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
        models: [model()],
      };
    },
    placementPolicy: async () => {
      const { requiredProfile: id, profiles } = (await request("agents.list")) as {
        requiredProfile?: string;
        profiles?: Array<typeof profile>;
      };
      return {
        sessionPlacement: id
          ? { requiredProfile: { id, ...profiles?.find((entry) => entry.id === id) } }
          : {},
      };
    },
    request,
  });
}
async function ready(f = fixture()) {
  await Promise.all([
    f.gateway.retryRequiredPlacement(),
    loadModelCatalog(f.context.gateway.snapshot.client!, { agentId: "main" }),
  ]);
  f.place.restorePreferenceSelections();
  f.flow.setMessage("Inspect the workspace");
  return f;
}

function expectRecovery(f: ReturnType<typeof fixture>, recovery: Record<string, unknown>) {
  expect(f.context.placementStartup.start).toHaveBeenCalledWith(
    expect.objectContaining({ recovery: expect.objectContaining(recovery) }),
  );
}

async function expectBlocked(f: ReturnType<typeof fixture>) {
  expect(f.flow.canSubmit()).toBe(false);
  await f.flow.submit();
  expect(f.context.sessions.createResult).not.toHaveBeenCalled();
}
afterEach(() => {
  vi.restoreAllMocks();
  sessionStorage.clear();
  localStorage.clear();
});

it.each(["idle", "rejected"] as const)(
  "retains required worker startup outcome: %s",
  async (status) => {
    const f = await ready();
    const key = "agent:main:required";
    const error = "Required worker is offline";
    expect(f.place).toMatchObject({ cloudProfileId: profile.id, freshWorkspace: true });
    expect(f.flow.canSubmit()).toBe(true);
    f.context.placementStartup.start = vi.fn();
    vi.mocked(f.context.sessions.createResult).mockResolvedValue({
      key,
      initialRun: status === "idle" ? { status } : { status, error },
    });
    await f.flow.submit(undefined, true);
    expect(f.context.sessions.createResult).toHaveBeenCalledWith(
      expect.objectContaining({ message: "", worktree: true, worktreeSource: "empty" }),
      expect.anything(),
    );
    expect(f.context.sessions.createResult).toHaveBeenCalledOnce();
    expectRecovery(
      f,
      status === "idle"
        ? { target: { kind: "profile", profileId: profile.id, required: true } }
        : { sessionKey: key, phase: "paused", reason: "not-sent", error },
    );
    expect(f.request).not.toHaveBeenCalledWith("sessions.dispatch", expect.anything());
    expect(f.request.mock.calls.filter(([method]) => method === "sessions.send")).toHaveLength(0);
  },
);

it("waits for initial policy and never falls back when its required profile is missing", async () => {
  const pending = createDeferred<unknown>();
  const f = fixture(() => pending.promise);
  const read = f.gateway.retryRequiredPlacement();
  f.flow.setMessage("Do not run locally");
  expect(f.flow.canSubmit()).toBe(false);
  pending.resolve({ ...catalog, profiles: [] });
  await read;
  expect(f.place.cloudProfileId).toBe(profile.id);
  await expectBlocked(f);
});

it("projects the latest policy over cached placement without persisting that policy as a preference", async () => {
  let current: typeof catalog | { profiles: (typeof profile)[]; environments: never[] } = catalog;
  const f = await ready(fixture(async () => current));
  f.place.selectDevice("");
  expect(f.place.cloudProfileId).toBe(profile.id);
  current = {
    ...catalog,
    requiredProfile: "replacement",
    profiles: [{ ...profile, id: "replacement" }],
  };
  await f.gateway.retryRequiredPlacement();
  expect(f.place.cloudProfileId).toBe("replacement");
  current = optionalCatalog;
  await f.gateway.retryRequiredPlacement();
  expect(f.place).toMatchObject({ cloudProfileId: "", remotePlacement: false });
});

it("rejects direct hosted placement and blocks hosted model changes under required placement", async () => {
  const f = await ready();
  f.place.selectHostedEnvironment("agentsapi");
  expect(f.place.modelControl.agentRuntime).toBeUndefined();
  expect(f.place).toMatchObject({ cloudProfileId: profile.id, worktree: true });

  f.place.modelControl.selectModel("openai/default", "agentsapi");
  expect(f.place).toMatchObject({
    hostedEnvironment: undefined,
    remotePlacement: true,
    worktree: true,
  });
  expect(f.flow.submitBlock()?.gate).toBe("cloud");
  await f.flow.submit();
  expect(f.context.sessions.createResult).not.toHaveBeenCalled();
});

it("applies a newly required profile over an open hosted draft without advertising a hosted destination", async () => {
  let current: typeof catalog | typeof optionalCatalog = optionalCatalog;
  const f = await ready(fixture(async () => current));
  f.place.selectHostedEnvironment("agentsapi");
  expect(f.place.hostedEnvironment).toEqual(hostedRuntime.workspaceEnvironment);
  expect(f.flow.canSubmit()).toBe(true);

  current = catalog;
  await f.gateway.retryRequiredPlacement();
  const close = vi.spyOn(f.place.browser, "close");
  f.place.browser.popoverCallbacks("where").onPopoverShow();
  f.place.restorePreferenceSelections();
  f.place.restorePreferenceSelections();
  expect(close).toHaveBeenCalledOnce();
  expect(f.place.modelControl.modelDefaultsPolicy).toBe("configured");
  expect(f.place.browser.popoverOpen("where")).toBe(false);
  expect(f.place).toMatchObject({
    hostedEnvironment: undefined,
    cloudProfileId: profile.id,
    worktree: true,
  });
  await expectBlocked(f);

  current = optionalCatalog;
  await f.gateway.retryRequiredPlacement();
  f.place.restorePreferenceSelections();
  expect(f.place.hostedEnvironment).toEqual(hostedRuntime.workspaceEnvironment);
  expect(f.flow.canSubmit()).toBe(true);
});

it("uses worker configured defaults instead of a cached external runtime without deleting preferences", async () => {
  const f = fixture();
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
  await vi.waitFor(() => expect(f.place.modelControl.agentRuntime).toBe("external-runtime"));
  await ready(f);
  expect(f.place.modelControl.modelForSubmission()).toBe("");
  expect(f.place.modelControl.agentRuntime).toBeUndefined();
  expect(f.place.devicePlacementRuntime()?.id).toBe("openclaw");
  expect(f.flow.canSubmit()).toBe(true);
  expect(f.gateway.readPreference("main")).toEqual(preference);
  f.place.modelControl.selected = "openai/default";
  expect(f.flow.submitBlock()?.gate).toBe("model-unavailable");
});

it("does not grant a model or write permission through required worker metadata", async () => {
  const restricted = await ready(fixture(undefined, { restricted: true, defaultModel: null }));
  expect(restricted.flow.canSubmit()).toBe(false);
  const f = await ready();
  f.context.gateway.snapshot.hello!.auth!.scopes = ["operator.read"];
  expect(f.flow.submitBlock()?.gate).toBe("access");
});

it("renders required placement as a readonly indicator, not a machine or workspace picker", async () => {
  const f = await ready();
  const container = document.createElement("div");
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
          onChange: vi.fn(),
        },
      }),
    { container },
  );
  expect(container.textContent).toContain("OpenClaw worker");
  expect(container.querySelector("[data-required-placement]")).not.toBeNull();
  expect(container.querySelector("button, input, .oc-popover")).toBeNull();
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
    await f.gateway.retryRequiredPlacement();
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

it("keeps a cold required-worker draft on configured defaults across asynchronous catalogs", async () => {
  const place = createDeferred<unknown>();
  const modelsReady = createDeferred();
  const f = fixture(() => place.promise, undefined, modelsReady.promise);
  const read = f.gateway.retryRequiredPlacement();
  f.flow.setMessage("Use the worker without choosing a model");
  expect(f.flow.canSubmit()).toBe(false);
  place.resolve(catalog);
  await read;
  f.place.restorePreferenceSelections();
  modelsReady.resolve();
  await loadModelCatalog(f.context.gateway.snapshot.client!, { agentId: "main" });
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
      await f.gateway.retryRequiredPlacement();
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
  const refresh = f.gateway.retryRequiredPlacement();
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
