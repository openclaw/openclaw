import { afterEach, beforeEach, expect, it } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { clearRuntimeAuthProfileStoreSnapshots } from "../../agents/auth-profiles/runtime-snapshots.js";
import { registerAgentHarness } from "../../agents/harness/registry.js";
import type { AgentHarness } from "../../agents/harness/types.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../config/io.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import {
  getActivePluginRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "../../plugins/runtime.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { prepareSessionWorkerPlacementPatchValidation } from "../server-methods/sessions-shared.js";
import {
  projectWorkerPlacementAgentRuntime,
  resolveDefaultWorkerPlacementExecutionMode,
  resolveWorkerPlacementCapabilities,
  resolveWorkerPlacementSessionRuntime,
  resolveWorkerPlacementSessionRuntimeAsync,
} from "./placement-session-runtime.js";
import { activePlacement } from "./placement-suite.test-support.js";

async function prepareRuntimePatch(
  provider: string,
  model: string,
  current: () => ReturnType<typeof activePlacement>,
) {
  const { sessionId } = current();
  const key = `agent:main:${sessionId}`;
  return prepareSessionWorkerPlacementPatchValidation({
    agentId: "main",
    cfg: {},
    context: {
      workerSessionPlacementService: {
        getMany: () => new Map([[sessionId, current()]]),
        prepareSessionPlacement: async () => ({
          prepareRead: () => undefined,
          current,
          release() {},
        }),
      },
    },
    entry: { sessionId, updatedAt: 0, providerOverride: provider, modelOverride: model },
    key,
    patch: { key, model: `${provider}/${model}` },
    sessionKey: key,
    validateModelRuntime: true,
  });
}

const originalPluginRegistry = getActivePluginRegistry();

const remotePlacement = (requiredNodeCommands: string[]) => ({
  mode: "remote-exec" as const,
  devicePlacement: { requiredNodeCommands, consumesWorkerSlot: false },
});

function registerHarness(id: string, overrides: Partial<AgentHarness> = {}) {
  registerAgentHarness({
    id,
    label: id,
    cloudPlacement: remotePlacement(["runtime.exec-server.v1"]),
    supports: () => ({ supported: true }),
    async runAttempt() {
      throw new Error("not used");
    },
    ...overrides,
  });
}

function sessionRuntime(
  entry: Partial<Parameters<typeof resolveWorkerPlacementSessionRuntime>[0]["entry"]>,
  cfg: Parameters<typeof resolveWorkerPlacementSessionRuntime>[0]["cfg"] = {},
  sessionKey = "agent:main:runtime-session",
) {
  return resolveWorkerPlacementSessionRuntime({
    readSourceEntry: () => undefined,
    cfg,
    entry: { sessionId: "runtime-session", updatedAt: 0, ...entry },
    agentId: "main",
    sessionKey,
  });
}

function runtimeCapabilities(...args: Parameters<typeof sessionRuntime>) {
  return resolveWorkerPlacementCapabilities(sessionRuntime(...args));
}

function registerCliBackend(modelProvider?: string) {
  getActivePluginRegistry()?.cliBackends.push({
    pluginId: "test-cli-plugin",
    pluginName: "test-cli-plugin",
    backend: {
      id: "claude-cli",
      ...(modelProvider ? { modelProvider } : {}),
      config: { command: "claude" },
    },
    source: "test",
  });
}

function authConfig(order: string[]) {
  return {
    auth: {
      order: { anthropic: order },
      profiles: {
        "anthropic:api": { provider: "anthropic", mode: "api_key" as const },
        "anthropic:claude-cli": { provider: "claude-cli", mode: "oauth" as const },
      },
    },
  };
}

beforeEach(() => {
  clearRuntimeAuthProfileStoreSnapshots();
  setActivePluginRegistry(createEmptyPluginRegistry(), "placement-runtime-test", "default");
});

afterEach(() => {
  clearRuntimeAuthProfileStoreSnapshots();
  clearRuntimeConfigSnapshot();
  if (originalPluginRegistry) {
    setActivePluginRegistry(originalPluginRegistry, "placement-runtime-test-restore", "default");
    return;
  }
  resetPluginRuntimeStateForTest();
});

it("derives presence mode from the default session runtime", () => {
  registerHarness("codex");
  const cfg = {
    agents: {
      defaults: {
        model: { primary: "openai/gpt-test" },
        models: { "openai/gpt-test": { agentRuntime: { id: "codex" } } },
      },
    },
  };
  expect(
    runtimeCapabilities(
      { providerOverride: "openai", modelOverride: "gpt-test", agentRuntimeOverride: "codex" },
      cfg,
      "agent:main:dashboard:browser-created-codex",
    ).executionMode,
  ).toBe("remote-exec");
  expect(resolveDefaultWorkerPlacementExecutionMode({ cfg, agentId: "main" })).toBe("remote-exec");
});

it.each([
  [{ agentHarnessId: "codex" }, "openclaw"],
  [{ agentHarnessId: "codex", agentRuntimeOverride: "default" }, "openclaw"],
  [{ agentHarnessId: "codex", modelSelectionLocked: true }, "codex"],
  [
    { agentHarnessId: "openclaw", providerOverride: "openai", modelOverride: "gpt-5.6-sol" },
    "codex",
  ],
  [
    { agentRuntimeOverride: "codex", providerOverride: "openai", modelOverride: "gpt-test" },
    "codex",
  ],
] as const)("resolves runtime for %j to %s", (entry, expected) => {
  expect(
    sessionRuntime(
      {
        sessionId: "placement-runtime-session",
        updatedAt: 0,
        providerOverride: "anthropic",
        modelOverride: "claude-test",
        ...entry,
      },
      {},
      "agent:main:placement-runtime",
    ),
  ).toBe(expected);
});

it("reads inherited runtime off thread and observes parent updates", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    setRuntimeConfigSnapshot({});
    const parent = { agentId: "main", sessionKey: "agent:main:parent-runtime" };
    const updateParent = (providerOverride: string, modelOverride: string, updatedAt: number) =>
      upsertSessionEntryCore(parent, {
        sessionId: "parent-runtime",
        updatedAt,
        providerOverride,
        modelOverride,
      });
    await updateParent("openai", "gpt-5.6-sol", 1);
    const input = {
      cfg: {},
      agentId: "main",
      sessionKey: "agent:main:child-runtime",
      entry: { sessionId: "child-runtime", updatedAt: 1, parentSessionKey: parent.sessionKey },
    };
    const observed = observeHostDataSql();
    try {
      expect(await resolveWorkerPlacementSessionRuntimeAsync(input)).toBe("codex");
      expect(observed.queries).toEqual([]);
    } finally {
      observed.restore();
    }
    await updateParent("anthropic", "claude-test", 2);
    expect(await resolveWorkerPlacementSessionRuntimeAsync(input)).toBe("openclaw");
  });
});

it("required worker inference overrides persisted runtime", () => {
  expect(
    sessionRuntime(
      {
        sessionId: "required-placement-runtime",
        updatedAt: 0,
        providerOverride: "openai",
        modelOverride: "gpt-test",
        agentRuntimeOverride: "codex",
      },
      { cloudWorkers: { requiredProfile: "dedicated-native" } },
      "agent:main:required-placement-runtime",
    ),
  ).toBe("openclaw");
});

it.each([
  ["openclaw", undefined, "worker-turn", { requiredNodeCommands: [], consumesWorkerSlot: true }],
  [
    "ordered-harness",
    remotePlacement(["runtime.zeta.v1", "runtime.alpha.v1", "runtime.zeta.v1"]),
    "remote-exec",
    { requiredNodeCommands: ["runtime.alpha.v1", "runtime.zeta.v1"], consumesWorkerSlot: false },
  ],
  ["cloud-harness", { mode: "remote-exec" }, "remote-exec", undefined],
  ["missing-harness", undefined, undefined, undefined],
  [
    "oversized-harness",
    remotePlacement(Array.from({ length: 33 }, (_, i) => `runtime.${i}.v1`)),
    "remote-exec",
    undefined,
  ],
] as const)(
  "projects %s placement capabilities",
  (runtimeId, cloudPlacement, executionMode, devicePlacement) => {
    if (cloudPlacement) {
      registerHarness(runtimeId, { cloudPlacement });
    }
    expect(projectWorkerPlacementAgentRuntime({ id: runtimeId, source: "model" })).toEqual({
      id: runtimeId,
      cloudPlacementSupported: executionMode !== undefined,
      ...(executionMode ? { cloudPlacementExecutionMode: executionMode } : {}),
      ...(devicePlacement ? { devicePlacement } : {}),
      devicePlacementSupported: devicePlacement !== undefined,
      source: "model",
    });
  },
);

it.each([
  [undefined, {}],
  [
    "openclaw",
    {
      executionMode: "worker-turn",
      devicePlacement: { requiredNodeCommands: [], consumesWorkerSlot: true },
    },
  ],
] as const)("resolves CLI placement with runtime override %s", (agentRuntimeOverride, expected) => {
  // #136611: CLI backends dispatch locally even when no harness claims the model.
  registerCliBackend();
  const caps = runtimeCapabilities({
    providerOverride: "claude-cli",
    modelOverride: "claude-fable-5-1",
    agentRuntimeOverride,
  });
  expect(caps).toEqual(expected);
});

it.each([
  ["anthropic:api", ["anthropic:claude-cli", "anthropic:api"], "worker-turn"],
  ["anthropic:claude-cli", ["anthropic:api"], undefined],
] as const)("%s overrides auth order", (authProfileOverride, order, expected) => {
  registerCliBackend("anthropic");
  const caps = runtimeCapabilities(
    {
      providerOverride: "anthropic",
      modelOverride: "opus-4.7",
      authProfileOverride,
    },
    authConfig([...order]),
  );
  expect(caps.executionMode).toBe(expected);
});

it.each(["provider-policy", "auto", "unclaimed"] as const)(
  "%s selects placement capabilities",
  (kind) => {
    const id = "device-harness";
    registerHarness(id, kind === "unclaimed" ? { supports: () => ({ supported: false }) } : {});
    const caps = runtimeCapabilities(
      {
        providerOverride: kind === "provider-policy" ? id : "other-provider",
        modelOverride: "model-x",
      },
      kind === "provider-policy"
        ? {
            models: {
              providers: {
                [id]: {
                  baseUrl: "https://device-harness.example/v1",
                  models: [],
                  agentRuntime: { id },
                },
              },
            },
          }
        : {},
    );
    expect(caps.executionMode).toBe(kind === "unclaimed" ? "worker-turn" : "remote-exec");
  },
);

it("sessions.patch rejects incompatible worker-turn runtimes", async () => {
  registerHarness("claude-cli", {
    cloudPlacement: undefined,
    autoSelection: { providerIds: ["claude-cli"] },
  });
  const placement = activePlacement("s6");
  const prepared = await prepareRuntimePatch("claude-cli", "claude-fable-5-1", () => placement);
  try {
    expect(prepared.validate()).toContain(
      "cannot select a runtime without cloud placement support",
    );
  } finally {
    prepared.release();
  }
});

it("sessions.patch allows auto fallback and rechecks execution mode", async () => {
  const placement = activePlacement("s8");
  let executionMode: "worker-turn" | "remote-exec" = "worker-turn";
  const prepared = await prepareRuntimePatch("some-provider", "some-model", () => ({
    ...placement,
    executionMode,
  }));
  try {
    expect(prepared.validate()).toBeUndefined();
    executionMode = "remote-exec";
    expect(prepared.validate()).toContain("cannot change cloud placement execution mode");
  } finally {
    prepared.release();
  }
});
