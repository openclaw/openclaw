import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { preparePublishedModelRuntimeChoice } from "../agents/model-runtime-choice.js";
import type { SessionEntry } from "../config/sessions.js";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import {
  createColdPluginFixture,
  isColdPluginRuntimeLoaded,
} from "../plugins/test-helpers/cold-plugin-fixtures.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import type { PrepareGatewaySessionLifecycle } from "./session-lifecycle-preparation.js";
import { writeSessionStore } from "./test-helpers.js";
import { agentDiscoveryMock, testState } from "./test-helpers.runtime-state.js";
import {
  directSessionReq,
  getGatewayConfigModule,
  sessionStoreEntry,
  setupGatewaySessionsHandlerTestHarness,
} from "./test/server-sessions.test-helpers.js";

// Prepared runtime eligibility is covered by the native choice owner tests.
vi.mock("../agents/model-runtime-choice.js", () => ({
  preparePublishedModelRuntimeChoice: vi.fn<typeof preparePublishedModelRuntimeChoice>(
    async ({ runtimeId, preferredRuntimeId }) => ({
      kind: "ready",
      runtimeId: runtimeId ?? preferredRuntimeId ?? "fixture-harness",
      validate: () => undefined,
    }),
  ),
}));

afterEach(() => {
  // Only the spawn-to-creation cases seed discovery; every other case in this
  // file relies on the real registry.
  Object.assign(agentDiscoveryMock, { enabled: false, models: [] });
  closeOpenClawStateDatabaseForTest();
});

// Register after the reset so stacked teardown drains fixture stores first.
const { createSelectedGlobalSessionStore } = setupGatewaySessionsHandlerTestHarness();

const mainModel = { id: "main-only", name: "Main Model", provider: "main-provider" };
const workModel = { id: "work-only", name: "Work Model", provider: "work-provider" };

function createAgentModelCatalogLoader() {
  return vi.fn(async (params?: { agentId?: string }) => {
    const entries = params?.agentId === "work" ? [workModel] : [mainModel];
    return { entries, routeVariants: entries };
  });
}

const mainRef = "main-provider/main-only";
const workRef = "work-provider/work-only";

type ModelSelectionCase = {
  label: string;
  explicitAgent?: boolean;
  globalAllow: string[];
  agentAllow?: string[];
  globalAlias?: string;
  agentAlias?: string;
  agentRuntime?: string;
  harness?: "enabled" | "disabled" | "denied";
  codexDenied?: boolean;
  model: string;
  expectedModel: string;
  denied?: boolean;
  error?: string;
};

function configureAgentModels(
  scenario: Pick<
    ModelSelectionCase,
    "globalAllow" | "agentAllow" | "globalAlias" | "agentAlias" | "agentRuntime"
  > & { subagentModel?: string },
  runtimeModel = workRef,
) {
  testState.agentConfig = {
    model: { primary: "synthetic/base" },
    modelPolicy: { allow: scenario.globalAllow },
    models: scenario.globalAlias ? { [workRef]: { alias: scenario.globalAlias } } : {},
  };
  testState.agentsConfig = {
    list: [
      {
        id: "main",
        default: true,
        modelPolicy: { allow: [mainRef] },
        models: { [mainRef]: { alias: "agent-choice" } },
      },
      {
        id: "work",
        subagents: scenario.subagentModel ? { model: scenario.subagentModel } : undefined,
        ...(scenario.agentAllow ? { modelPolicy: { allow: scenario.agentAllow } } : {}),
        models: {
          [workRef]: scenario.agentAlias ? { alias: scenario.agentAlias } : {},
          ...(scenario.agentRuntime
            ? { [runtimeModel]: { agentRuntime: { id: scenario.agentRuntime } } }
            : {}),
        },
      },
    ],
  };
}

const cases: ModelSelectionCase[] = [
  {
    label: "rejects configured Codex selection when its harness is denied",
    globalAllow: [],
    agentRuntime: "codex",
    codexDenied: true,
    model: "openai/gpt-5.4",
    expectedModel: "openai/gpt-5.4",
    denied: true,
    error:
      'Model openai/gpt-5.4 requires agent harness "codex", but no enabled plugin provides it. Install and enable its plugin, restart the Gateway, then select the model again.',
  },
  {
    label: "preserves the session when the selected model requires an unavailable harness",
    globalAllow: [],
    agentRuntime: "missing-harness",
    model: workRef,
    expectedModel: workRef,
    denied: true,
    error:
      'Model work-provider/work-only requires agent harness "missing-harness", but no enabled plugin provides it. Install and enable its plugin, restart the Gateway, then select the model again.',
  },
  ...(["enabled", "disabled", "denied"] as const).map((harness) => ({
    label: `checks an installed ${harness} harness without loading its runtime`,
    globalAllow: [],
    agentRuntime: "fixture-harness",
    harness,
    model: workRef,
    expectedModel: workRef,
    denied: harness !== "enabled",
    error:
      'Model work-provider/work-only requires agent harness "fixture-harness", but no enabled plugin provides it. Install and enable its plugin, restart the Gateway, then select the model again.',
  })),
  {
    label: "loads the explicit agent model catalog",
    explicitAgent: true,
    globalAllow: [],
    model: workRef,
    expectedModel: workRef,
  },
  {
    label: "loads the agent-qualified session model catalog",
    globalAllow: [],
    model: workRef,
    expectedModel: workRef,
  },
  {
    label: "rejects outside agent policy despite unrestricted global policy",
    explicitAgent: true,
    globalAllow: [],
    agentAllow: [workRef],
    model: mainRef,
    expectedModel: mainRef,
    denied: true,
  },
  {
    label: "accepts an uncataloged model under explicit empty agent policy",
    globalAllow: [mainRef],
    agentAllow: [],
    model: "work-provider/uncataloged",
    expectedModel: "work-provider/uncataloged",
  },
  {
    label: "accepts the agent list instead of the opposing global list",
    explicitAgent: true,
    globalAllow: [mainRef],
    agentAllow: [workRef],
    model: workRef,
    expectedModel: workRef,
  },
  {
    label: "rejects the global list when the agent list replaces it",
    globalAllow: [mainRef],
    agentAllow: [workRef],
    model: mainRef,
    expectedModel: mainRef,
    denied: true,
  },
  {
    label: "resolves an agent-only alias under the target agent policy",
    globalAllow: [mainRef],
    agentAllow: [workRef],
    agentAlias: "agent-choice",
    model: "agent-choice",
    expectedModel: workRef,
  },
  {
    label: "uses the per-agent alias override for the same model key",
    explicitAgent: true,
    globalAllow: [mainRef],
    agentAllow: [workRef],
    globalAlias: "shared-choice",
    agentAlias: "agent-choice",
    model: "agent-choice",
    expectedModel: workRef,
  },
  {
    label: "rejects a displaced global alias",
    globalAllow: [workRef],
    agentAllow: [workRef],
    globalAlias: "shared-choice",
    agentAlias: "agent-choice",
    model: "shared-choice",
    expectedModel: "synthetic/shared-choice",
    denied: true,
  },
  {
    label: "checks the resolved agent alias against agent policy",
    globalAllow: [],
    agentAllow: [mainRef],
    agentAlias: "agent-choice",
    model: "agent-choice",
    expectedModel: workRef,
    denied: true,
  },
];

describe.each(["sessions.create", "sessions.patch"] as const)("%s", (method) => {
  test.each(cases)("$label", async (scenario) => {
    const { dir, workStorePath } = await createSelectedGlobalSessionStore();
    configureAgentModels(scenario, scenario.expectedModel);
    let fixture: ReturnType<typeof createColdPluginFixture> | undefined;
    if (scenario.harness) {
      const rootDir = await fs.mkdtemp(path.join(dir, "harness-"));
      fixture = createColdPluginFixture({
        rootDir,
        pluginId: "fixture-harness",
        manifest: { activation: { onAgentHarnesses: ["fixture-harness"] } },
      });
      const { writeConfigFile } = await getGatewayConfigModule();
      await writeConfigFile({
        plugins: {
          load: { paths: [rootDir] },
          ...(scenario.harness === "denied"
            ? {}
            : { entries: { "fixture-harness": { enabled: scenario.harness !== "disabled" } } }),
          ...(scenario.harness === "denied" ? { deny: ["fixture-harness"] } : {}),
        },
      });
    } else if (scenario.codexDenied) {
      const { writeConfigFile } = await getGatewayConfigModule();
      await writeConfigFile({ plugins: { deny: ["codex"] } });
    }
    const key = "agent:work:dashboard:catalog-owner";
    const access = { agentId: "work", sessionKey: key, storePath: workStorePath };
    if (method === "sessions.patch") {
      await writeSessionStore({
        agentId: "work",
        storePath: workStorePath,
        entries: {
          [key]: sessionStoreEntry("work-catalog-patch", {
            label: "Original label",
            providerOverride: "synthetic",
            modelOverride: "previous",
            modelOverrideSource: "user",
          }),
        },
      });
    }
    const before = loadSessionEntry(access);
    const configModule = await getGatewayConfigModule();
    const { readConfigFileSnapshot } = configModule;
    const beforeConfig = await readConfigFileSnapshot();
    const loadGatewayModelCatalogSnapshot = createAgentModelCatalogLoader();
    const configMutations = vi.spyOn(configModule, "mutateConfigFileWithRetry");
    let result: Awaited<ReturnType<typeof directSessionReq<{ entry?: SessionEntry }>>>;
    try {
      result = await directSessionReq<{ entry?: SessionEntry }>(
        method,
        {
          key,
          ...(scenario.explicitAgent ? { agentId: "work" } : {}),
          model: scenario.model,
          label: "Updated label",
        },
        {
          context: { loadGatewayModelCatalogSnapshot },
          ...(scenario.error
            ? { client: { connect: { scopes: ["operator.admin"] } } as never }
            : {}),
        },
      );
    } finally {
      // Admin patches persist defaults in the background; join their writes before
      // the shared config fixture resets for the next case.
      await Promise.allSettled(
        configMutations.mock.results
          .filter((mutation) => mutation.type === "return")
          .map((mutation) => mutation.value),
      );
      configMutations.mockRestore();
    }

    expect(loadGatewayModelCatalogSnapshot).toHaveBeenCalledWith({ agentId: "work" });
    if (fixture) {
      expect(isColdPluginRuntimeLoaded(fixture)).toBe(false);
    }
    if (scenario.denied) {
      expect.soft(result.ok).toBe(false);
      expect.soft(result.error).toMatchObject({
        code: "INVALID_REQUEST",
        message: scenario.error ?? `model not allowed: ${scenario.expectedModel}`,
      });
      expect(loadSessionEntry(access)).toEqual(before);
      expect((await readConfigFileSnapshot()).config).toEqual(beforeConfig.config);
      return;
    }
    expect(result.ok, result.error?.message).toBe(true);
    const [providerOverride, modelOverride] = scenario.expectedModel.split("/");
    const selection = { providerOverride, modelOverride, modelOverrideSource: "user" };
    expect(result.payload?.entry).toMatchObject(selection);
    expect(loadSessionEntry(access)).toMatchObject({ ...selection, label: "Updated label" });
  });
});

test.each([
  {
    name: "target agent alias",
    globalAllow: [mainRef],
    agentAllow: [workRef],
    model: "agent-choice",
    expected: { providerOverride: "work-provider", modelOverride: "work-only" },
  },
  {
    name: "target agent denial despite unrestricted defaults",
    globalAllow: [],
    agentAllow: [workRef],
    model: mainRef,
    expected: null,
  },
  {
    name: "uncataloged model under an explicit empty agent policy",
    globalAllow: [mainRef],
    agentAllow: [],
    model: "work-provider/uncataloged",
    expected: { providerOverride: "work-provider", modelOverride: "uncataloged" },
  },
])("prepares session lifecycle selection for $name", async (scenario) => {
  await createSelectedGlobalSessionStore();
  configureAgentModels({ ...scenario, agentAlias: "agent-choice" });
  const { getRuntimeConfig } = await getGatewayConfigModule();
  const { createGatewaySession } = await import("./session-create-service.js");
  const prepareLifecycle = vi.fn<PrepareGatewaySessionLifecycle>(async () => ({
    ok: true,
    value: {},
  }));

  const result = await createGatewaySession({
    cfg: getRuntimeConfig(),
    key: "agent:work:dashboard:prepared-selection",
    agentId: "work",
    model: scenario.model,
    commandSource: "test",
    prepareLifecycle,
    loadGatewayModelCatalogSnapshot: async () => ({
      entries: [workModel],
      routeVariants: [workModel],
    }),
  });

  expect(result.ok).toBe(scenario.expected !== null);
  expect(prepareLifecycle).toHaveBeenCalledWith(
    expect.objectContaining({ agentId: "work", titleModelSelection: scenario.expected }),
  );
});

test.each([
  { name: "pinned model requested by agent alias", subagent: false },
  { name: "configured subagent default alias requested by canonical model", subagent: true },
])("sessions.create preserves write-scoped adoption of $name", async ({ subagent }) => {
  const { workStorePath } = await createSelectedGlobalSessionStore();
  const otherRef = "work-provider/other";
  configureAgentModels({
    // The subagent request is globally allowed so only its default-alias comparison loses scope.
    globalAllow: subagent ? [workRef, otherRef] : [mainRef],
    agentAllow: [workRef, otherRef],
    agentAlias: "agent-choice",
    subagentModel: subagent ? "agent-choice" : undefined,
  });
  const key = `agent:work:${subagent ? "subagent" : "dashboard"}:adopt-selection`;
  const access = { agentId: "work", sessionKey: key, storePath: workStorePath };
  await writeSessionStore({
    agentId: "work",
    storePath: workStorePath,
    entries: {
      [key]: sessionStoreEntry("existing-selection", {
        label: "Original label",
        ...(subagent ? {} : { providerOverride: "work-provider", modelOverride: "work-only" }),
      }),
    },
  });
  const context = { loadGatewayModelCatalogSnapshot: createAgentModelCatalogLoader() };
  const writeClient = { connect: { scopes: ["operator.write"] } } as never;
  const sameSelection = await directSessionReq<{ entry?: SessionEntry }>(
    "sessions.create",
    { key, model: subagent ? workRef : "agent-choice" },
    { client: writeClient, context },
  );

  expect(sameSelection.ok, sameSelection.error?.message).toBe(true);
  expect(loadSessionEntry(access)).toMatchObject({
    sessionId: "existing-selection",
    providerOverride: "work-provider",
    modelOverride: "work-only",
    modelOverrideSource: "user",
  });
  const beforeChange = loadSessionEntry(access);
  const denied = await directSessionReq(
    "sessions.create",
    { key, model: otherRef, label: "Must not change" },
    { client: writeClient, context },
  );
  expect(denied).toMatchObject({
    ok: false,
    error: { code: "FORBIDDEN", message: "missing scope: operator.admin" },
  });
  expect(loadSessionEntry(access)).toEqual(beforeChange);

  const changed = await directSessionReq(
    "sessions.create",
    { key, model: otherRef },
    { client: { connect: { scopes: ["operator.admin"] } } as never, context },
  );
  expect(changed.ok, changed.error?.message).toBe(true);
  expect(loadSessionEntry(access)).toMatchObject({
    sessionId: "existing-selection",
    providerOverride: "work-provider",
    modelOverride: "other",
    modelOverrideSource: "user",
  });
});

// A visible spawn forwards its inherited level as an explicit `thinkingLevel`,
// and the real creation path rejects an explicit level the prepared catalog does
// not support. These cases pin that boundary for a catalog-defined off-only
// model: the unclamped level fails creation outright, the clamped one persists.
const offOnlyModel = {
  id: "off-only",
  name: "Off Only",
  provider: "off-provider",
  reasoning: false,
};
const offOnlyRef = "off-provider/off-only";

test.each([
  {
    label: "rejects an unclamped inherited level for an off-only model",
    thinkingLevel: "high",
    created: false,
  },
  {
    label: "accepts the catalog-clamped level for an off-only model",
    thinkingLevel: "off",
    created: true,
  },
])("sessions.create $label", async (scenario) => {
  const { workStorePath } = await createSelectedGlobalSessionStore();
  testState.agentConfig = { model: { primary: "synthetic/base" } };
  testState.agentsConfig = { list: [{ id: "main", default: true }, { id: "work" }] };
  const key = "agent:work:dashboard:off-only-child";
  const access = { agentId: "work", sessionKey: key, storePath: workStorePath };
  const loadGatewayModelCatalog = vi.fn(async () => [offOnlyModel]);

  const result = await directSessionReq<{ entry?: SessionEntry }>(
    "sessions.create",
    {
      key,
      agentId: "work",
      model: offOnlyRef,
      thinkingLevel: scenario.thinkingLevel,
      task: "inspect issue",
    },
    { context: { loadGatewayModelCatalog } },
  );

  expect(loadGatewayModelCatalog).toHaveBeenCalledWith({ agentId: "work" });
  if (!scenario.created) {
    expect.soft(result.ok).toBe(false);
    expect.soft(result.error).toMatchObject({
      code: "INVALID_REQUEST",
      message: `thinkingLevel "high" is not supported for ${offOnlyRef} (use off)`,
    });
    expect(loadSessionEntry(access)).toBeUndefined();
    return;
  }
  expect(result.ok, result.error?.message).toBe(true);
  expect(loadSessionEntry(access)).toMatchObject({
    providerOverride: "off-provider",
    modelOverride: "off-only",
    thinkingLevel: "off",
  });
});

// Integrated boundary: the visible spawn tool's own clamp feeds the real
// `sessions.create` handler, with one shared authoritative catalog for both
// sides. The unclamped level is the same one the cases above prove creation
// rejects, so a regression in the clamp fails here as a creation failure.
//
// The real spawn path resolves its model through `prepareModelChoice`, so the
// fixture model has to exist in discovery as well as in the prepared catalog.
const runtimeVariantModel = {
  id: "reasoner",
  name: "Reasoner",
  provider: "runtime-fixture",
  reasoning: true,
};
const runtimeVariantRef = "runtime-fixture/reasoner";

type VisibleSpawnBoundaryCase = {
  label: string;
  model: { id: string; provider: string; [key: string]: unknown };
  ref: string;
  /** Rows the prepared catalog publishes as route variants for that model. */
  routeVariants?: { id: string; provider: string; [key: string]: unknown }[];
  agentRuntime?: string;
  inherited: string;
  expectedLevel: string;
  /** Creation must reject the unclamped inherited level for this catalog. */
  rejectsUnclamped?: boolean;
};

const visibleSpawnBoundaryCases: VisibleSpawnBoundaryCase[] = [
  {
    label: "an off-only child",
    model: offOnlyModel,
    ref: offOnlyRef,
    inherited: "high",
    expectedLevel: "off",
  },
  {
    label: "a reasoning-capable child",
    model: { ...offOnlyModel, reasoning: true },
    ref: offOnlyRef,
    inherited: "high",
    expectedLevel: "high",
  },
  // Logical row advertises max, the row for the runtime that will own the turn
  // advertises only high. `sessions.create` validates against the latter, so
  // forwarding max here fails creation outright.
  {
    label: "a child clamped to its selected runtime row",
    model: { ...runtimeVariantModel, compat: { supportedReasoningEfforts: ["max"] } },
    ref: runtimeVariantRef,
    routeVariants: [
      { ...runtimeVariantModel, compat: { supportedReasoningEfforts: ["max"] } },
      {
        ...runtimeVariantModel,
        nativeRuntime: "fixture-native",
        compat: { supportedReasoningEfforts: ["high"] },
      },
    ],
    agentRuntime: "fixture-native",
    inherited: "max",
    expectedLevel: "high",
    rejectsUnclamped: true,
  },
  // The inverse mismatch: grading against the logical row alone would drop an
  // effort the selected runtime row genuinely supports.
  {
    label: "a child keeping effort its selected runtime row supports",
    model: { ...runtimeVariantModel, compat: { supportedReasoningEfforts: ["high"] } },
    ref: runtimeVariantRef,
    routeVariants: [
      { ...runtimeVariantModel, compat: { supportedReasoningEfforts: ["high"] } },
      {
        ...runtimeVariantModel,
        nativeRuntime: "fixture-native",
        compat: { supportedReasoningEfforts: ["max"] },
      },
    ],
    agentRuntime: "fixture-native",
    inherited: "max",
    expectedLevel: "max",
  },
];

test.each(visibleSpawnBoundaryCases)(
  "visible spawn creates $label through the real sessions.create path",
  async (scenario) => {
    const { dir, workStorePath } = await createSelectedGlobalSessionStore();
    if (scenario.agentRuntime) {
      // A model pinned to a harness is refused at creation unless that harness
      // is installed and enabled, so the runtime-variant cases need a fixture.
      const rootDir = await fs.mkdtemp(path.join(dir, "harness-"));
      createColdPluginFixture({
        rootDir,
        pluginId: scenario.agentRuntime,
        manifest: { activation: { onAgentHarnesses: [scenario.agentRuntime] } },
      });
      const { writeConfigFile } = await getGatewayConfigModule();
      await writeConfigFile({
        plugins: {
          load: { paths: [rootDir] },
          entries: { [scenario.agentRuntime]: { enabled: true } },
        },
      });
    }
    testState.agentConfig = { model: { primary: scenario.ref } };
    testState.agentsConfig = {
      list: [
        { id: "main", default: true },
        {
          id: "work",
          ...(scenario.agentRuntime
            ? { models: { [scenario.ref]: { agentRuntime: { id: scenario.agentRuntime } } } }
            : {}),
        },
      ],
    };
    agentDiscoveryMock.enabled = true;
    agentDiscoveryMock.models = [{ ...scenario.model, input: ["text"] }];
    const parentKey = "agent:work:dashboard:visible-spawn-parent";
    // Real creation validates declared spawn lineage, so the requester must exist.
    await writeSessionStore({
      agentId: "work",
      storePath: workStorePath,
      entries: { [parentKey]: sessionStoreEntry("visible-spawn-parent") },
    });
    const { getRuntimeConfig } = await getGatewayConfigModule();
    const { maybeSpawnVisibleSession } = await import("../agents/tools/sessions-spawn-visible.js");
    const entries = [scenario.model];
    const routeVariants = scenario.routeVariants ?? entries;
    const loadGatewayModelCatalogSnapshot = vi.fn(async (request?: { agentId?: string }) => ({
      entries,
      routeVariants,
      agentId: request?.agentId ?? "work",
      agentDir: path.join(dir, "catalog-agent"),
      workspaceDir: path.join(dir, "catalog-workspace"),
      config: getRuntimeConfig(),
      catalogComplete: true,
    }));
    const registerRun = vi.fn();
    const gatewayCalls: { method: string; params: Record<string, unknown> }[] = [];

    const result = await maybeSpawnVisibleSession({
      raw: { visible: true, task: "inspect issue" },
      task: "inspect issue",
      label: "Visible child",
      runtime: "subagent",
      requestedAgentId: "work",
      sandbox: "inherit",
      expectsCompletionMessage: true,
      options: {
        config: getRuntimeConfig(),
        agentSessionKey: parentKey,
        requesterThinkingLevel: scenario.inherited as never,
        loadModelCatalog: loadGatewayModelCatalogSnapshot as never,
        registerRun: registerRun as never,
        countActiveRuns: () => 0,
        callGateway: async (method, params) => {
          gatewayCalls.push({ method, params: params as Record<string, unknown> });
          const response = await directSessionReq<Record<string, unknown>>(
            method as "sessions.create",
            params as Record<string, unknown>,
            { context: { loadGatewayModelCatalogSnapshot } },
          );
          if (!response.ok) {
            throw new Error(response.error?.message ?? "sessions.create failed");
          }
          return response.payload as never;
        },
      },
    });

    if (scenario.rejectsUnclamped) {
      // Same handler, same catalog: the level a logical-row-only clamp would
      // have forwarded is refused, so the clamp below is load-bearing rather
      // than cosmetic.
      const rejected = await directSessionReq(
        "sessions.create",
        {
          key: "agent:work:dashboard:unclamped-probe",
          agentId: "work",
          model: scenario.ref,
          thinkingLevel: scenario.inherited,
          task: "inspect issue",
        },
        { context: { loadGatewayModelCatalogSnapshot } },
      );
      expect(rejected.ok).toBe(false);
      expect(rejected.error?.message).toContain(
        `thinkingLevel "${scenario.inherited}" is not supported for ${scenario.ref}`,
      );
    }

    expect(result?.error).toBeUndefined();
    expect(result).toMatchObject({ status: "accepted" });
    expect(gatewayCalls[0]).toMatchObject({
      method: "sessions.create",
      params: { agentId: "work", model: scenario.ref, thinkingLevel: scenario.expectedLevel },
    });
    // The tool mints the child key, so read the persisted row it reports back.
    const childSessionKey = result?.childSessionKey as string;
    expect(childSessionKey).toBeTruthy();
    expect(
      loadSessionEntry({ agentId: "work", sessionKey: childSessionKey, storePath: workStorePath }),
    ).toMatchObject({ thinkingLevel: scenario.expectedLevel });
  },
);
