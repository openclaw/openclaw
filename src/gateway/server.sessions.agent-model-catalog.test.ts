import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import type { preparePublishedModelRuntimeChoice } from "../agents/model-runtime-choice.js";
import { setRuntimeConfigSnapshot } from "../config/io.js";
import type { SessionEntry } from "../config/sessions.js";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import * as coldPlugins from "../plugins/test-helpers/cold-plugin-fixtures.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import type { PrepareGatewaySessionLifecycle } from "./session-create-service.types.js";
import { loadGatewayTestConfig } from "./test-helpers.config-runtime.js";
import { writeSessionStore } from "./test-helpers.js";
import { testState } from "./test-helpers.runtime-state.js";
import * as sessions from "./test/server-sessions.test-helpers.js";

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

afterEach(closeOpenClawStateDatabaseForTest);
const { createSelectedGlobalSessionStore } = sessions.setupGatewaySessionsHandlerTestHarness();

const mainModel = { id: "main-only", name: "Main Model", provider: "main-provider" };
const workModel = { id: "work-only", name: "Work Model", provider: "work-provider" };

const catalog = (entries = [workModel]) => ({ entries, routeVariants: entries });
const loadAgentModelCatalog = async (params?: { agentId?: string }) =>
  catalog(params?.agentId === "work" ? [workModel] : [mainModel]);
const mainRef = "main-provider/main-only";
const workRef = "work-provider/work-only";
const selectedWork = { providerOverride: "work-provider", modelOverride: "work-only" };

async function seedWorkSession(storePath: string, key: string, entry: SessionEntry) {
  await writeSessionStore({
    agentId: "work",
    storePath,
    entries: { [key]: { label: "Original label", ...entry } },
  });
}

type ModelOptions = {
  explicitAgent?: boolean;
  globalAllow?: string[];
  agentAllow?: string[];
  globalAlias?: string;
  agentAlias?: string;
  harness?: "enabled" | "denied";
  denied?: boolean;
  subagentModel?: string;
};

function configureAgentModels(scenario: ModelOptions, runtimeModel = workRef) {
  testState.agentConfig = {
    model: { primary: "synthetic/base" },
    modelPolicy: { allow: scenario.globalAllow ?? [] },
    models: scenario.globalAlias ? { [workRef]: { alias: scenario.globalAlias } } : {},
  };
  testState.agentsConfig = {
    entries: {
      main: {
        modelPolicy: { allow: [mainRef] },
        models: { [mainRef]: { alias: "agent-choice" } },
      },
      work: {
        subagents: scenario.subagentModel ? { model: scenario.subagentModel } : undefined,
        ...(scenario.agentAllow ? { modelPolicy: { allow: scenario.agentAllow } } : {}),
        models: {
          [workRef]: scenario.agentAlias ? { alias: scenario.agentAlias } : {},
          ...(scenario.harness
            ? { [runtimeModel]: { agentRuntime: { id: "fixture-harness" } } }
            : {}),
        },
      },
    },
  };
  setRuntimeConfigSnapshot(loadGatewayTestConfig());
}

test.each<["create" | "patch", string, ModelOptions]>([
  ["create", workRef, { harness: "enabled" }],
  ["patch", workRef, { harness: "denied", denied: true }],
  ["create", mainRef, { agentAllow: [workRef], explicitAgent: true, denied: true }],
  ["create", "work-provider/uncataloged", { globalAllow: [mainRef], agentAllow: [] }],
  [
    "patch",
    "agent-choice",
    {
      globalAllow: [mainRef],
      agentAllow: [workRef],
      explicitAgent: true,
      globalAlias: "shared-choice",
      agentAlias: "agent-choice",
    },
  ],
])("%s selects %s under %j", async (method, model, scenario) => {
  const expectedModel = model === "agent-choice" ? workRef : model;
  const { dir, workStorePath } = await createSelectedGlobalSessionStore();
  configureAgentModels(scenario, expectedModel);
  let fixture: ReturnType<typeof coldPlugins.createColdPluginFixture> | undefined;
  const { writeConfigFile, readConfigFileSnapshot } = await sessions.getGatewayConfigModule();
  if (scenario.harness) {
    const rootDir = await fs.mkdtemp(path.join(dir, "harness-"));
    fixture = coldPlugins.createColdPluginFixture({
      rootDir,
      pluginId: "fixture-harness",
      manifest: { activation: { onAgentHarnesses: ["fixture-harness"] } },
    });
    const policy =
      scenario.harness === "denied"
        ? { deny: ["fixture-harness"] }
        : { entries: { "fixture-harness": { enabled: true } } };
    await writeConfigFile({ plugins: { load: { paths: [rootDir] }, ...policy } });
  }
  const key = "agent:work:dashboard:catalog-owner";
  const access = { agentId: "work", sessionKey: key, storePath: workStorePath };
  if (method === "patch") {
    await seedWorkSession(
      workStorePath,
      key,
      sessions.sessionStoreEntry("work-catalog-patch", {
        providerOverride: "synthetic",
        modelOverride: "previous",
        modelOverrideSource: "user",
      }),
    );
  }
  const before = loadSessionEntry(access);
  const beforeConfig = await readConfigFileSnapshot();
  const result = await sessions.directSessionReq<{ entry?: SessionEntry }>(
    `sessions.${method}`,
    {
      key,
      ...(scenario.explicitAgent ? { agentId: "work" } : {}),
      model,
      label: "Updated label",
    },
    {
      context: { loadGatewayModelCatalogSnapshot: loadAgentModelCatalog },
      ...(scenario.harness ? { client: { connect: { scopes: ["operator.admin"] } } as never } : {}),
    },
  );

  if (fixture) {
    expect(coldPlugins.isColdPluginRuntimeLoaded(fixture)).toBe(false);
  }
  if (scenario.denied) {
    expect.soft(result).toMatchObject({
      ok: false,
      error: {
        code: "INVALID_REQUEST",
        message: scenario.harness
          ? 'Model work-provider/work-only requires agent harness "fixture-harness", but no enabled plugin provides it. Install and enable its plugin, restart the Gateway, then select the model again.'
          : `model not allowed: ${expectedModel}`,
      },
    });
    expect(loadSessionEntry(access)).toEqual(before);
    expect((await readConfigFileSnapshot()).config).toEqual(beforeConfig.config);
    return;
  }
  expect(result.ok, result.error?.message).toBe(true);
  const [providerOverride, modelOverride] = expectedModel.split("/");
  const selection = { providerOverride, modelOverride, modelOverrideSource: "user" };
  expect(result.payload?.entry).toMatchObject(selection);
  expect(loadSessionEntry(access)).toMatchObject({ ...selection, label: "Updated label" });
});

test.each([
  { model: "agent-choice", globalAllow: [mainRef], expected: selectedWork },
  { model: mainRef, globalAllow: [], expected: null },
])("prepares session lifecycle selection for $model", async (scenario) => {
  await createSelectedGlobalSessionStore();
  configureAgentModels({ ...scenario, agentAllow: [workRef], agentAlias: "agent-choice" });
  const { getRuntimeConfig } = await sessions.getGatewayConfigModule();
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
    loadGatewayModelCatalogSnapshot: async () => catalog(),
  });

  expect(result.ok).toBe(scenario.expected !== null);
  expect(prepareLifecycle).toHaveBeenCalledWith(
    expect.objectContaining({ agentId: "work", titleModelSelection: scenario.expected }),
  );
});

test.each([false, true])("preserves write-scoped adoption (subagent: %s)", async (subagent) => {
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
  await seedWorkSession(
    workStorePath,
    key,
    sessions.sessionStoreEntry("existing-selection", subagent ? {} : selectedWork),
  );
  const context = { loadGatewayModelCatalogSnapshot: loadAgentModelCatalog };
  const writeClient = { connect: { scopes: ["operator.write"] } } as never;
  const create = (
    model: string,
    client: NonNullable<Parameters<typeof sessions.directSessionReq>[2]>["client"] = writeClient,
    extra: { label?: string } = {},
  ) => sessions.directSessionReq("sessions.create", { key, model, ...extra }, { client, context });
  const sameSelection = await create(subagent ? workRef : "agent-choice");

  expect(sameSelection.ok, sameSelection.error?.message).toBe(true);
  const adopted = {
    sessionId: "existing-selection",
    ...selectedWork,
    modelOverrideSource: "user",
  };
  expect(loadSessionEntry(access)).toMatchObject(adopted);
  const beforeChange = loadSessionEntry(access);
  const denied = await create(otherRef, writeClient, { label: "Must not change" });
  expect(denied).toMatchObject({
    ok: false,
    error: { code: "FORBIDDEN", message: "missing scope: operator.admin" },
  });
  expect(loadSessionEntry(access)).toEqual(beforeChange);

  const changed = await create(otherRef, { connect: { scopes: ["operator.admin"] } } as never);
  expect(changed.ok, changed.error?.message).toBe(true);
  expect(loadSessionEntry(access)).toMatchObject({ ...adopted, modelOverride: "other" });
});
