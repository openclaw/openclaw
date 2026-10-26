import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { prepareSharedAuthStoreOwnership } from "../../agents/auth-profiles/path-resolve.js";
import { clearRuntimeAuthProfileStoreSnapshotCore } from "../../agents/auth-profiles/runtime-snapshots.js";
import * as authStore from "../../agents/auth-profiles/store.js";
import type { ModelCatalogEntry } from "../../agents/model-catalog.js";
import { buildModelAliasIndex } from "../../agents/model-selection-shared.js";
import { createFixtureRouteModels } from "../../agents/test-helpers/model-fallback-config-fixture.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { clearSessionStoreCacheForTest } from "../../config/sessions/store-writer-state.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import type { ModelAliasIndex } from "./model-selection-directive.js";

const readPreparedModelCatalog = vi.hoisted(() => vi.fn(async () => modelCatalog));
const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-reset-model-lock-");
const sessionKey = "agent:main:dm:1";
const alternateModel = { providerOverride: "minimax", modelOverride: "m2.7" };
const defaultModel = { providerOverride: "openai", modelOverride: "gpt-4o-mini" };
afterEach(clearSessionStoreCacheForTest);

vi.mock("../../agents/prepared-model-catalog.js", () => ({
  loadProviderScopedThinkingCatalog: vi.fn(async () => []),
  readPreparedModelCatalog,
}));

import { applyResetModelOverride } from "./session-reset-model.js";

const modelCatalog: ModelCatalogEntry[] = [
  { provider: "minimax", id: "m2.7", name: "M2.7" },
  { provider: "openai", id: "gpt-4o-mini", name: "GPT-4o mini" },
];

function createResetFixture(entry: Partial<SessionEntry> = {}) {
  const cfg = {} as OpenClawConfig;
  const aliasIndex: ModelAliasIndex = { byAlias: new Map(), byKey: new Map() };
  const sessionEntry: SessionEntry = {
    sessionId: "s1",
    updatedAt: Date.now(),
    delivery: { kind: "none" },
    ...entry,
  };
  return {
    cfg,
    aliasIndex,
    sessionEntry,
    sessionStore: { [sessionKey]: sessionEntry } as Record<string, SessionEntry>,
    sessionCtx: { BodyStripped: "minimax summarize" },
  };
}

function apply(
  fixture: ReturnType<typeof createResetFixture>,
  overrides: Partial<Parameters<typeof applyResetModelOverride>[0]> = {},
) {
  return applyResetModelOverride({
    ...fixture,
    sessionKey,
    defaultProvider: "openai",
    defaultModel: "gpt-4o-mini",
    modelCatalog,
    bodyStripped: fixture.sessionCtx.BodyStripped,
    ...overrides,
  });
}

async function persist(
  fixture: ReturnType<typeof createResetFixture>,
  entry: Partial<SessionEntry>,
) {
  const storePath = path.join(sessionDirs.make(), "sessions.json");
  const persisted = { ...fixture.sessionEntry, ...entry };
  await replaceSessionEntry({ sessionKey, storePath }, persisted);
  return { storePath, persisted };
}

async function applyResetFixture(entry: Partial<SessionEntry>, bodyStripped = "minimax summarize") {
  const fixture = createResetFixture(entry);
  await apply(fixture, { bodyStripped });
  return fixture;
}

describe("applyResetModelOverride", () => {
  it.each(["initial", "persisted"])("honors the %s session model lock", async (owner) => {
    const fixture = createResetFixture({ modelSelectionLocked: owner === "initial" });
    const { storePath, persisted } = await persist(fixture, { modelSelectionLocked: true });
    await expect(
      apply(fixture, { storePath, bodyStripped: "minimax/m2.7 summarize" }),
    ).rejects.toThrow("Model selection is locked");
    expect(fixture.sessionEntry.modelOverride).toBeUndefined();
    expect(loadSessionEntry({ sessionKey, storePath })).toEqual(persisted);
  });

  it.each([
    { name: "omitted", policy: undefined, allowed: true },
    { name: "empty", policy: {}, allowed: true },
    { name: "empty allow", policy: { allow: [] }, allowed: true },
    { name: "restricted", policy: { allow: ["openai/*"] }, allowed: false },
  ])("authorizes an off-catalog reset hint with $name policy", async ({ policy, allowed }) => {
    const fixture = createResetFixture({ thinkingLevel: "high" });
    fixture.cfg = {
      agents: { defaults: { modelPolicy: policy } },
      models: createFixtureRouteModels(),
    };
    fixture.sessionCtx.BodyStripped = "fixture-route/reasoner summarize";
    const initial = structuredClone(fixture.sessionEntry);
    await apply(fixture);

    if (allowed) {
      expect(fixture.sessionEntry).toMatchObject({
        providerOverride: "fixture-route",
        modelOverride: "reasoner",
        thinkingLevel: "high",
      });
      expect(fixture.sessionCtx.BodyStripped).toBe("summarize");
    } else {
      expect(fixture.sessionEntry).toEqual(initial);
      expect(fixture.sessionCtx.BodyStripped).toBe("fixture-route/reasoner summarize");
    }
  });

  it("recognizes an exact configured alias outside the picker inventory", async () => {
    const fixture = createResetFixture();
    fixture.cfg = {
      agents: {
        defaults: {
          modelPolicy: { allow: [] },
          models: { "fixture-route/reasoner": { alias: "quick" } },
        },
      },
      models: createFixtureRouteModels(),
    };
    await apply(fixture, {
      aliasIndex: buildModelAliasIndex({ cfg: fixture.cfg, defaultProvider: "openai" }),
      bodyStripped: "quick summarize",
    });
    expect(fixture.sessionEntry).toMatchObject({
      modelOverride: "reasoner",
      providerOverride: "fixture-route",
    });
    expect(fixture.sessionCtx.BodyStripped).toBe("summarize");
  });

  it.each([
    "summarize the previous conversation",
    "missing-provider/reasoner summarize",
    "missing-provider reasoner summarize",
  ])("keeps unrecognized model-hint text unchanged: %s", async (body) => {
    const fixture = createResetFixture();
    fixture.sessionCtx.BodyStripped = body;
    await apply(fixture, { sessionKey: undefined });

    expect(fixture.sessionCtx.BodyStripped).toBe(body);
    expect(fixture.sessionEntry.modelOverride).toBeUndefined();
  });

  it("loads the reset catalog for the active agent owner", async () => {
    const fixture = createResetFixture();
    const owner = {
      agentId: "worker",
      agentDir: "/tmp/shared-agent",
      workspaceDir: "/tmp/shared-workspace",
    };
    await apply(fixture, { ...owner, sessionEntry: undefined, modelCatalog: undefined });
    expect(readPreparedModelCatalog).toHaveBeenCalledWith({
      config: fixture.cfg,
      ...owner,
      readOnly: true,
    });
  });

  it.each(["minimax summarize", "minimax m2.7 summarize", "minimax/m2.7 summarize"])(
    "selects a model hint while preserving thinking: %s",
    async (body) => {
      const { sessionEntry, sessionCtx } = await applyResetFixture(
        { thinkingLevel: "ultra" },
        body,
      );

      expect(sessionEntry).toMatchObject({ ...alternateModel, thinkingLevel: "ultra" });
      expect(sessionCtx.BodyStripped).toBe("summarize");
    },
  );

  it.each([
    { name: "empty catalog", catalog: [], allowed: true },
    { name: "unrelated catalog", catalog: modelCatalog.slice(1), allowed: true },
    { name: "explicit policy restriction", catalog: modelCatalog, allowed: false },
  ])("applies configured-primary policy with $name", async ({ catalog, allowed }) => {
    const fixture = createResetFixture(allowed ? defaultModel : {});
    fixture.cfg.agents = {
      defaults: {
        model: { primary: "custom/private-model" },
        ...(!allowed ? { modelPolicy: { allow: ["openai/*"] } } : {}),
      },
    };
    if (allowed) {
      fixture.cfg.models = {
        providers: {
          custom: { api: "openai-responses", baseUrl: "https://fixture.invalid/v1", models: [] },
        },
      };
    }
    fixture.sessionCtx.BodyStripped = "custom/private-model summarize";
    await apply(fixture, {
      defaultProvider: "custom",
      defaultModel: "private-model",
      modelCatalog: catalog,
    });
    if (allowed) {
      expect(fixture.sessionEntry.modelOverrideSource).toBe("default");
    }
    expect(fixture.sessionCtx.BodyStripped).toBe(
      allowed ? "summarize" : "custom/private-model summarize",
    );
    expect(fixture.sessionEntry.providerOverride).toBeUndefined();
    expect(fixture.sessionEntry.modelOverride).toBeUndefined();
  });

  it("prepares a cold auth pin asynchronously and observes a subsequent owner write", async () => {
    await withOpenClawTestState({ layout: "state-only" }, async (state) => {
      const profileId = "team:prod";
      await prepareSharedAuthStoreOwnership(state.env);
      const writeCredential = (provider: string) =>
        state.writeAuthProfiles({
          version: 1,
          profiles: {
            [profileId]: { type: "api_key", provider, key: "test" },
          },
        });
      await writeCredential("minimax");
      const agentDir = state.agentDir();
      clearRuntimeAuthProfileStoreSnapshotCore(agentDir);
      const synchronousRead = vi
        .spyOn(authStore, "findPersistedAuthProfileCredential")
        .mockImplementation(() => {
          throw new Error("synchronous credential read during model selection");
        });
      try {
        const fixture = createResetFixture({
          authProfileOverride: profileId,
          authProfileOverrideSource: "user",
        });
        const reset = () => apply(fixture, { agentDir, bodyStripped: "minimax/m2.7 summarize" });

        await reset();
        expect(fixture.sessionEntry.authProfileOverride).toBe(profileId);

        await writeCredential("openai");
        await reset();
        expect(fixture.sessionEntry.authProfileOverride).toBeUndefined();
        expect(fixture.sessionEntry.authProfileOverrideSource).toBeUndefined();
      } finally {
        synchronousRead.mockRestore();
      }
    });
  });

  it.each([false, true])(
    "adopts a concurrent model winner (same-value hint: %s)",
    async (sameValue) => {
      const fixture = createResetFixture(
        sameValue ? { ...alternateModel, modelOverrideSource: "user" } : {},
      );
      const { storePath, persisted } = await persist(fixture, {
        updatedAt: fixture.sessionEntry.updatedAt + 1,
        ...defaultModel,
        modelOverrideSource: "user",
      });
      await apply(fixture, { storePath });
      expect(fixture.sessionCtx.BodyStripped).toBe("summarize");
      expect(fixture.sessionEntry).toMatchObject({ ...defaultModel, modelOverrideSource: "user" });
      expect(fixture.sessionEntry.updatedAt).toBeGreaterThanOrEqual(persisted.updatedAt);
      expect(fixture.sessionStore[sessionKey]).toEqual(fixture.sessionEntry);
      expect(loadSessionEntry({ sessionKey, storePath })).toEqual(fixture.sessionEntry);
    },
  );

  it("rejects a reset-model hint when the session rotates during persistence", async () => {
    const fixture = createResetFixture();
    const { storePath, persisted } = await persist(fixture, {
      sessionId: "s2",
      updatedAt: fixture.sessionEntry.updatedAt + 1,
      ...defaultModel,
      modelOverrideSource: "user",
    });
    await expect(apply(fixture, { storePath })).rejects.toThrow(/changed while starting work/i);
    expect(fixture.sessionEntry.sessionId).toBe("s1");
    expect(fixture.sessionEntry.modelOverride).toBeUndefined();
    expect(fixture.sessionStore[sessionKey]).toBe(fixture.sessionEntry);
    expect(loadSessionEntry({ sessionKey, storePath })).toEqual(persisted);
  });
});
