import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  loadSessionEntry,
  replaceSessionEntry,
} from "../../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../../config/sessions/types.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import {
  loadCronJobsStore,
  resolveCronJobsStorePath,
  saveCronJobsStore,
} from "../../../cron/store.js";
import { clearPluginMetadataLifecycleCaches } from "../../../plugins/plugin-metadata-lifecycle.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../../test-utils/openclaw-test-state.js";
import { createTestModelDefinition } from "../../test-runtime-config-helpers.js";
import { repairCronCodexModelRefsAfterConfigWrite } from "../cron/legacy-repair.js";
import { maybeRepairCodexSessionRoutes } from "./codex-route-session-repair.js";
import {
  createDoctorModelRefResolver,
  inspectDoctorModelReferences,
} from "./model-reference-inventory.js";
import { prepareModelReplacementConfig } from "./model-replacement-config.js";
import { prepareExplicitModelReplacement } from "./model-replacement-preparation.js";
import { parseDoctorModelReplacements } from "./model-replacement.js";
import {
  createRetiredModelRefRepairResolver,
  repairRetiredConfigModelRefs,
  repairRetiredModelSlots,
} from "./retired-model-ref-repair.js";
import { repairRetiredSessionModelRef } from "./retired-session-model-repair.js";
import { repairStaleAgentModelRefs } from "./stale-agent-model-ref-repair.js";

const from = "openai/gpt-daybreak-blue-latest";
const to = "openai/gpt-specific-fixture";
const choice = { from, to, accessProgram: "daybreak_blue" as const };
let state: OpenClawTestState;
let cfg: OpenClawConfig;
beforeEach(async () => {
  state = await createOpenClawTestState({ label: "daybreak-model-replacement" });
  clearPluginMetadataLifecycleCaches();
  await state.writeAuthProfiles({
    version: 1,
    profiles: { "openai:work": { type: "api_key", provider: "openai", key: "synthetic-test-key" } },
  });
  cfg = {
    agents: {
      defaults: {
        workspace: state.workspaceDir,
        model: from,
        models: {
          [from]: {
            alias: "defensive",
            params: { temperature: 0.25, accessPrograms: { cyber: "daybreak_red" } },
          },
        },
      },
      entries: { main: {} },
    },
    auth: { profiles: { "openai:work": { provider: "openai", mode: "api_key" } } },
    models: {
      providers: {
        openai: {
          baseUrl: "https://api.openai.com/v1",
          api: "openai-responses",
          auth: "api-key",
          models: [createTestModelDefinition("gpt-specific-fixture")],
        },
      },
    },
    plugins: { allow: ["openai"], entries: { openai: { enabled: true } } },
  };
  await state.writeConfig(cfg);
});
afterEach(async () => {
  clearPluginMetadataLifecycleCaches();
  await state.cleanup();
});

function resolve(config = cfg) {
  return createRetiredModelRefRepairResolver({
    cfg: config,
    env: state.env,
    modelReplacements: [choice],
  });
}

it("requires an explicit current model and Access program and rejects conflicting maps", () => {
  expect(parseDoctorModelReplacements([JSON.stringify(choice)])).toEqual([choice]);
  for (const invalid of [
    { from, to },
    { ...choice, to: from },
    { ...choice, to: "custom/model" },
    { ...choice, to: to + "@work" },
    { ...choice, accessProgram: "auto" },
    { ...choice, extra: true },
  ]) {
    expect(() => parseDoctorModelReplacements([JSON.stringify(invalid)])).toThrow();
  }
  expect(() =>
    parseDoctorModelReplacements([JSON.stringify(choice), JSON.stringify(choice)]),
  ).toThrow("Duplicate");
  expect(() =>
    parseDoctorModelReplacements([
      JSON.stringify(choice),
      JSON.stringify({
        ...choice,
        from: "openai/gpt-daybreak-red-latest",
        accessProgram: "daybreak_red",
      }),
    ]),
  ).toThrow("Conflicting");
});

it("leaves retiring refs alone without a choice", () => {
  expect(
    createRetiredModelRefRepairResolver({ cfg, env: state.env })({
      modelRef: from,
      agentId: "main",
    }),
  ).toEqual({ kind: "unchanged" });
});

it("migrates aliases and model settings, preserving source config and the explicit Access choice", () => {
  const before = structuredClone(cfg);
  const prepared = prepareModelReplacementConfig(cfg, [choice]);
  const repaired = repairRetiredConfigModelRefs(prepared.config, resolve(prepared.config));
  expect(repaired.config.agents?.defaults?.model).toBe(to);
  expect(repaired.config.agents?.defaults?.models?.[from]).toBeUndefined();
  expect(repaired.config.agents?.defaults?.models?.[to]).toMatchObject({
    alias: "defensive",
    params: { temperature: 0.25, accessPrograms: { cyber: "daybreak_blue" } },
  });
  expect(cfg).toEqual(before);
  expect(prepareModelReplacementConfig(repaired.config, [choice]).changes).toEqual([]);
  expect(repairRetiredConfigModelRefs(repaired.config, resolve(repaired.config)).changes).toEqual(
    [],
  );
});

it("prepares Access for session/job-only references and refuses to overwrite a target program", () => {
  cfg.agents!.defaults!.model = to;
  cfg.agents!.defaults!.models = {};
  expect(
    prepareModelReplacementConfig(cfg, [choice]).config.agents?.defaults?.models?.[to]?.params
      ?.accessPrograms,
  ).toEqual({ cyber: "daybreak_blue" });
  cfg.agents!.entries!.main!.models = {
    [to]: { params: { accessPrograms: { cyber: "standard" } } },
  };
  expect(() => prepareModelReplacementConfig(cfg, [choice])).toThrow("different Access program");
  expect(resolve()({ modelRef: from, agentId: "main" })).toEqual({ kind: "unchanged" });
});

it("migrates the saved selection without changing its account, runtime, or reasoning effort", () => {
  const entry: SessionEntry = {
    sessionId: "migration-fixture",
    updatedAt: 1,
    providerOverride: "openai",
    modelOverride: "gpt-daybreak-blue-latest",
    authProfileOverride: "openai:work",
    authProfileOverrideSource: "user",
    thinkingLevel: "high",
    agentRuntimeOverride: "codex",
    cyberAccessProgram: "daybreak_red",
  };
  expect(repairRetiredSessionModelRef(entry, "main", resolve(), to, [])).toBe(true);
  expect(entry).toMatchObject({
    modelOverride: "gpt-specific-fixture",
    providerOverride: "openai",
    authProfileOverride: "openai:work",
    authProfileOverrideSource: "user",
    thinkingLevel: "high",
    agentRuntimeOverride: "codex",
    cyberAccessProgram: "daybreak_blue",
  });
  expect(repairRetiredSessionModelRef(entry, "main", resolve(), to, [])).toBe(false);
});

it("preserves missing pinned accounts and disallowed successors", () => {
  expect(resolve()({ modelRef: from + "@openai:missing", agentId: "main" })).toEqual({
    kind: "unchanged",
  });
  cfg.agents!.defaults!.modelPolicy = { allow: [from] };
  const restricted = createRetiredModelRefRepairResolver({
    cfg,
    env: state.env,
    modelReplacements: [choice],
    checkModelPolicy: true,
  });
  expect(restricted({ modelRef: from, agentId: "main" })).toEqual({ kind: "unchanged" });
});

it("rewrites cron model and fallback selectors without changing schedules or payload text", () => {
  const payload = {
    model: "defensive",
    fallbacks: [from + "@openai:work", "openai/other"],
    message: "keep me",
  };
  repairRetiredModelSlots({
    owner: payload,
    path: "cron.fixture.payload",
    agentId: "main",
    resolve: resolve(),
    changes: [],
  });
  expect(payload).toEqual({
    model: to,
    fallbacks: [to + "@openai:work", "openai/other"],
    message: "keep me",
  });
});

it("inventories configured aliases while ignoring arbitrary text and other providers", async () => {
  cfg.agents!.entries!.main!.model = "defensive";
  cfg.agents!.entries!.main!.name = from;
  const inventory = await inspectDoctorModelReferences({
    cfg,
    env: state.env,
    matches: (ref) => ref === from,
  });
  expect(inventory.warnings).toEqual([]);
  expect(inventory.references.map((ref) => ref.path)).toEqual(
    expect.arrayContaining([
      "agents.defaults.model",
      "agents.defaults.models." + from,
      "agents.entries.main.model",
    ]),
  );
  expect(inventory.references.map((ref) => ref.path)).not.toContain("agents.entries.main.name");
  expect(createDoctorModelRefResolver(cfg)("custom/gpt-daybreak-blue-latest", "main")).toBe(
    "custom/gpt-daybreak-blue-latest",
  );
});

it("finds and migrates persisted session and scheduled-job aliases after saving the target config", async () => {
  const sessionKey = "agent:main:daybreak-fixture";
  const address = {
    storePath: path.join(state.sessionsDir(), "sessions.json"),
    sessionKey,
    env: state.env,
  };
  await replaceSessionEntry(address, {
    sessionId: "fixture",
    updatedAt: 1,
    modelOverride: "defensive",
    authProfileOverride: "openai:work",
    authProfileOverrideSource: "user",
    cyberAccessProgram: "daybreak_red",
  });
  const storePath = resolveCronJobsStorePath(undefined, state.env);
  await saveCronJobsStore(storePath, {
    version: 1,
    jobs: [
      {
        id: "fixture",
        agentId: "main",
        name: "Fixture reminder",
        enabled: false,
        createdAtMs: 1,
        updatedAtMs: 1,
        schedule: { kind: "every", everyMs: 60000 },
        sessionTarget: "isolated",
        wakeMode: "now",
        payload: {
          kind: "agentTurn",
          message: "Unchanged reminder",
          model: "defensive",
          fallbacks: [from],
        },
        state: {},
      },
    ],
  });
  const originalSession = loadSessionEntry(address);
  const inventory = await inspectDoctorModelReferences({
    cfg,
    env: state.env,
    matches: (ref) => ref === from,
  });
  expect(inventory.warnings).toEqual([]);
  expect(inventory.references.map((ref) => ref.path)).toEqual(
    expect.arrayContaining([
      "sessions.main." + sessionKey + ".modelOverride",
      "cron.fixture.payload.model",
      "cron.fixture.payload.fallbacks.0",
    ]),
  );
  expect(loadSessionEntry(address)).toEqual(originalSession);
  await prepareExplicitModelReplacement({ cfg, env: state.env, choices: [choice] });
  expect(loadSessionEntry(address)?.modelOverride).toBe(from);
  expect((await loadCronJobsStore(storePath)).jobs[0]?.payload).toMatchObject({ model: from });
  const repaired = repairStaleAgentModelRefs(cfg, { env: state.env, modelReplacements: [choice] });
  expect(repaired.config.agents?.defaults?.model).toBe(to);
  await state.writeConfig(repaired.config);
  const sessions = await maybeRepairCodexSessionRoutes({
    cfg: repaired.config,
    retiredModelRefConfig: repaired.retiredModelRefConfig,
    modelReplacements: [choice],
    env: state.env,
    shouldRepair: true,
  });
  expect(sessions.warnings).toEqual([]);
  expect(loadSessionEntry(address)).toMatchObject({
    modelOverride: "gpt-specific-fixture",
    authProfileOverride: "openai:work",
    authProfileOverrideSource: "user",
    cyberAccessProgram: "daybreak_blue",
  });
  const cron = await repairCronCodexModelRefsAfterConfigWrite({
    cfg: repaired.config,
    retiredModelRefConfig: repaired.retiredModelRefConfig,
    modelReplacements: [choice],
    migrateCodexModelRefs: false,
    repairRetiredModelRefs: true,
  });
  expect(cron.warnings).toEqual([]);
  expect((await loadCronJobsStore(storePath)).jobs[0]).toMatchObject({
    enabled: false,
    payload: { message: "Unchanged reminder", model: to, fallbacks: [to] },
  });
  expect(
    (
      await inspectDoctorModelReferences({
        cfg: repaired.config,
        env: state.env,
        matches: (ref) => ref === from,
      })
    ).references,
  ).toEqual([]);
});

it("preserves alias identity across interruption after config save and retries with the chosen Access", async () => {
  const address = {
    storePath: path.join(state.sessionsDir(), "sessions.json"),
    sessionKey: "agent:main:retry",
    env: state.env,
  };
  await replaceSessionEntry(address, {
    sessionId: "retry",
    updatedAt: 1,
    modelOverride: "defensive",
    cyberAccessProgram: "daybreak_red",
    authProfileOverride: "openai:missing",
    authProfileOverrideSource: "user",
  });
  await prepareExplicitModelReplacement({ cfg, env: state.env, choices: [choice] });
  expect(loadSessionEntry(address)).toMatchObject({
    modelOverride: from,
    cyberAccessProgram: "daybreak_red",
    authProfileOverride: "openai:missing",
  });
  const repaired = repairStaleAgentModelRefs(cfg, { env: state.env, modelReplacements: [choice] });
  await state.writeConfig(repaired.config);
  // Simulate process loss here: the old alias snapshot is no longer available.
  await maybeRepairCodexSessionRoutes({
    cfg: repaired.config,
    env: state.env,
    modelReplacements: [choice],
    shouldRepair: true,
  });
  expect(loadSessionEntry(address)?.modelOverride).toBe(from);
  expect(
    (
      await inspectDoctorModelReferences({
        cfg: repaired.config,
        env: state.env,
        matches: (ref) => ref === from,
      })
    ).references.map((ref) => ref.path),
  ).toContain("sessions.main.agent:main:retry.modelOverride");
  await replaceSessionEntry(address, {
    ...loadSessionEntry(address)!,
    authProfileOverride: "openai:work",
  });
  await maybeRepairCodexSessionRoutes({
    cfg: repaired.config,
    env: state.env,
    modelReplacements: [choice],
    shouldRepair: true,
  });
  expect(loadSessionEntry(address)).toMatchObject({
    modelOverride: "gpt-specific-fixture",
    cyberAccessProgram: "daybreak_blue",
    authProfileOverride: "openai:work",
  });
});

it("refuses to retarget config aliases while a locked saved alias cannot be prepared", async () => {
  const address = {
    storePath: path.join(state.sessionsDir(), "sessions.json"),
    sessionKey: "agent:main:locked",
    env: state.env,
  };
  await replaceSessionEntry(address, {
    sessionId: "locked",
    updatedAt: 1,
    modelOverride: "defensive",
    modelSelectionLocked: true,
    cyberAccessProgram: "daybreak_red",
  });
  const before = structuredClone(cfg);
  await expect(
    prepareExplicitModelReplacement({ cfg, env: state.env, choices: [choice] }),
  ).rejects.toThrow("Config aliases were not retargeted");
  expect(cfg).toEqual(before);
  expect(loadSessionEntry(address)).toMatchObject({
    modelOverride: "defensive",
    cyberAccessProgram: "daybreak_red",
    modelSelectionLocked: true,
  });
});

it("preserves a profile pinned in the model selector when migrating a saved session", () => {
  const entry: SessionEntry = {
    sessionId: "suffix",
    updatedAt: 1,
    modelOverride: from + "@openai:work",
    cyberAccessProgram: "daybreak_red",
  };
  expect(repairRetiredSessionModelRef(entry, "main", resolve(), to, [])).toBe(true);
  expect(entry).toMatchObject({
    modelOverride: "gpt-specific-fixture",
    authProfileOverride: "openai:work",
    authProfileOverrideSource: "user",
    cyberAccessProgram: "daybreak_blue",
  });
});

it("applies the chosen Access to inherited settings even when local source settings differ", () => {
  const prepared = prepareModelReplacementConfig(cfg, [choice]);
  const owner: Record<string, unknown> = {
    models: { [from]: { params: { temperature: 0.5, accessPrograms: { cyber: "daybreak_red" } } } },
  };
  repairRetiredModelSlots({
    owner,
    agentId: "main",
    path: "agents.entries.main",
    resolve: resolve(prepared.config),
    changes: [],
    inheritedModels: cfg.agents?.defaults?.models,
  });
  expect(owner.models).toMatchObject({
    [to]: { params: { temperature: 0.5, accessPrograms: { cyber: "daybreak_blue" } } },
  });
});
