// Tests reset model selection and persisted model override cleanup.
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { prepareSharedAuthStoreOwnership } from "../../agents/auth-profiles/path-resolve.js";
import { clearRuntimeAuthProfileStoreSnapshotCore } from "../../agents/auth-profiles/runtime-snapshots.js";
import * as authStore from "../../agents/auth-profiles/store.js";
import type { ModelCatalogEntry } from "../../agents/model-catalog.js";
import { buildModelAliasIndex } from "../../agents/model-selection-shared.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { clearSessionStoreCacheForTest } from "../../config/sessions/store-writer-state.js";
import { resolveStoredModelOverride } from "../../sessions/stored-model-overrides.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import type { ModelAliasIndex } from "./model-selection-directive.js";

const readPreparedModelCatalog = vi.hoisted(() => vi.fn(async () => modelCatalog));
const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-reset-model-lock-");

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
    sessionStore: { "agent:main:dm:1": sessionEntry } as Record<string, SessionEntry>,
    sessionCtx: { BodyStripped: "minimax summarize" },
  };
}

function resetModelParams(fixture: ReturnType<typeof createResetFixture>) {
  return {
    ...fixture,
    sessionKey: "agent:main:dm:1",
    defaultProvider: "openai",
    defaultModel: "gpt-4o-mini",
    modelCatalog,
  };
}

async function applyResetFixture(params: { sessionEntry?: Partial<SessionEntry>; body?: string }) {
  const fixture = createResetFixture(params.sessionEntry);
  await applyResetModelOverride({
    ...resetModelParams(fixture),
    bodyStripped: params.body ?? "minimax summarize",
  });
  return fixture;
}

describe("applyResetModelOverride", () => {
  it.each(["initial", "persisted"])("honors the %s session model lock", async (owner) => {
    const fixture = createResetFixture({ modelSelectionLocked: owner === "initial" });
    const storePath = path.join(sessionDirs.make(), "sessions.json");
    const lockedEntry: SessionEntry = { ...fixture.sessionEntry, modelSelectionLocked: true };
    const sessionKey = "agent:main:dm:1";
    await replaceSessionEntry({ sessionKey, storePath }, lockedEntry);

    await expect(
      applyResetModelOverride({
        ...resetModelParams(fixture),
        sessionKey,
        storePath,
        bodyStripped: "minimax/m2.7 summarize",
      }),
    ).rejects.toThrow("Model selection is locked");
    expect(fixture.sessionEntry.modelOverride).toBeUndefined();
    expect(loadSessionEntry({ sessionKey, storePath })).toEqual(lockedEntry);
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
      models: {
        providers: {
          "fixture-route": {
            api: "openai-responses",
            baseUrl: "https://fixture.invalid/v1",
            models: [],
          },
        },
      },
    };
    fixture.sessionCtx.BodyStripped = "fixture-route/reasoner summarize";
    const initial = structuredClone(fixture.sessionEntry);
    await applyResetModelOverride({
      ...resetModelParams(fixture),
      bodyStripped: fixture.sessionCtx.BodyStripped,
    });

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
      models: {
        providers: {
          "fixture-route": {
            api: "openai-responses",
            baseUrl: "https://fixture.invalid/v1",
            models: [],
          },
        },
      },
    };
    await applyResetModelOverride({
      ...resetModelParams(fixture),
      aliasIndex: buildModelAliasIndex({ cfg: fixture.cfg, defaultProvider: "openai" }),
      bodyStripped: "quick summarize",
    });
    expect(fixture.sessionEntry.modelOverride).toBe("reasoner");
    expect(fixture.sessionCtx.BodyStripped).toBe("summarize");
    expect(fixture.sessionEntry.providerOverride).toBe("fixture-route");
  });

  it.each([
    "summarize the previous conversation",
    "missing-provider/reasoner summarize",
    "missing-provider reasoner summarize",
  ])("keeps unrecognized model-hint text unchanged: %s", async (body) => {
    const fixture = createResetFixture();
    fixture.sessionCtx.BodyStripped = body;
    await applyResetModelOverride({
      ...fixture,
      bodyStripped: fixture.sessionCtx.BodyStripped,
      defaultProvider: "openai",
      defaultModel: "gpt-4o-mini",
      modelCatalog,
    });

    expect(fixture.sessionCtx.BodyStripped).toBe(body);
    expect(fixture.sessionEntry.modelOverride).toBeUndefined();
  });

  it("loads the reset catalog for the active agent owner", async () => {
    const fixture = createResetFixture();

    await applyResetModelOverride({
      cfg: fixture.cfg,
      agentId: "worker",
      agentDir: "/tmp/shared-agent",
      workspaceDir: "/tmp/shared-workspace",
      bodyStripped: "minimax summarize",
      sessionCtx: fixture.sessionCtx,
      defaultProvider: "openai",
      defaultModel: "gpt-4o-mini",
      aliasIndex: fixture.aliasIndex,
    });

    expect(readPreparedModelCatalog).toHaveBeenCalledWith({
      config: fixture.cfg,
      agentId: "worker",
      agentDir: "/tmp/shared-agent",
      workspaceDir: "/tmp/shared-workspace",
      readOnly: true,
    });
  });

  it.each(["minimax summarize", "minimax m2.7 summarize", "minimax/m2.7 summarize"])(
    "selects a model hint while preserving thinking: %s",
    async (body) => {
      const { sessionEntry, sessionCtx } = await applyResetFixture({
        sessionEntry: { thinkingLevel: "ultra" },
        body,
      });

      expect(sessionEntry.providerOverride).toBe("minimax");
      expect(sessionEntry.modelOverride).toBe("m2.7");
      expect(sessionEntry.thinkingLevel).toBe("ultra");
      expect(sessionCtx.BodyStripped).toBe("summarize");
    },
  );

  it("persists explicit default intent so a later turn does not re-inherit its parent", async () => {
    const parentKey = "agent:main:parent";
    const fixture = createResetFixture({
      providerOverride: "minimax",
      modelOverride: "m2.7",
      modelOverrideSource: "user",
    });

    await applyResetModelOverride({
      ...resetModelParams(fixture),
      bodyStripped: "openai/gpt-4o-mini summarize",
      sessionKey: "agent:main:child",
    });

    expect(fixture.sessionEntry.modelOverrideSource).toBe("default");
    expect(
      resolveStoredModelOverride({
        sessionEntry: fixture.sessionEntry,
        sessionStore: {
          [parentKey]: {
            sessionId: "parent-session",
            updatedAt: 1,
            providerOverride: "minimax",
            modelOverride: "m2.7",
            modelOverrideSource: "user",
          },
        },
        sessionKey: "agent:main:child",
        parentSessionKey: parentKey,
        defaultProvider: "openai",
      }),
    ).toBeNull();
  });

  it.each([
    { name: "empty catalog", catalog: [] },
    {
      name: "unrelated catalog",
      catalog: [{ provider: "openai", id: "gpt-4o-mini", name: "GPT-4o mini" }],
    },
  ] satisfies Array<{ name: string; catalog: ModelCatalogEntry[] }>)(
    "honors a configured primary missing from the $name",
    async ({ catalog }) => {
      const fixture = createResetFixture({
        providerOverride: "openai",
        modelOverride: "gpt-4o-mini",
      });
      fixture.cfg.agents = {
        defaults: { model: { primary: "custom/private-model" } },
      };
      fixture.cfg.models = {
        providers: {
          custom: { api: "openai-responses", baseUrl: "https://fixture.invalid/v1", models: [] },
        },
      };
      fixture.sessionCtx.BodyStripped = "custom/private-model summarize";

      await applyResetModelOverride({
        ...resetModelParams(fixture),
        bodyStripped: fixture.sessionCtx.BodyStripped,
        defaultProvider: "custom",
        defaultModel: "private-model",
        modelCatalog: catalog,
      });

      expect(fixture.sessionEntry.modelOverrideSource).toBe("default");
      expect(fixture.sessionCtx.BodyStripped).toBe("summarize");
      expect(fixture.sessionEntry.providerOverride).toBeUndefined();
      expect(fixture.sessionEntry.modelOverride).toBeUndefined();
    },
  );

  it("does not let the configured primary bypass an explicit model policy", async () => {
    const fixture = createResetFixture();
    fixture.cfg.agents = {
      defaults: {
        model: { primary: "custom/private-model" },
        modelPolicy: { allow: ["openai/*"] },
      },
    };
    fixture.sessionCtx.BodyStripped = "custom/private-model summarize";

    await applyResetModelOverride({
      ...resetModelParams(fixture),
      bodyStripped: fixture.sessionCtx.BodyStripped,
      defaultProvider: "custom",
      defaultModel: "private-model",
    });

    expect(fixture.sessionCtx.BodyStripped).toBe("custom/private-model summarize");
    expect(fixture.sessionEntry.providerOverride).toBeUndefined();
    expect(fixture.sessionEntry.modelOverride).toBeUndefined();
  });

  it("clears auth profile overrides when reset applies a model", async () => {
    await prepareSharedAuthStoreOwnership();
    const { sessionEntry } = await applyResetFixture({
      sessionEntry: {
        authProfileOverride: "anthropic:default",
        authProfileOverrideSource: "user",
        authProfileOverrideCompactionCount: 2,
      },
    });

    expect(sessionEntry.authProfileOverride).toBeUndefined();
    expect(sessionEntry.authProfileOverrideSource).toBeUndefined();
    expect(sessionEntry.authProfileOverrideCompactionCount).toBeUndefined();
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
        const apply = () =>
          applyResetModelOverride({
            ...resetModelParams(fixture),
            agentDir,
            bodyStripped: "minimax/m2.7 summarize",
          });

        await apply();
        expect(fixture.sessionEntry.authProfileOverride).toBe(profileId);

        await writeCredential("openai");
        await apply();
        expect(fixture.sessionEntry.authProfileOverride).toBeUndefined();
        expect(fixture.sessionEntry.authProfileOverrideSource).toBeUndefined();
      } finally {
        synchronousRead.mockRestore();
      }
    });
  });

  it("adopts a concurrent model winner", async () => {
    const tempRoot = sessionDirs.make();
    const storePath = path.join(tempRoot, "sessions.json");
    const fixture = createResetFixture();
    const concurrentEntry: SessionEntry = {
      ...fixture.sessionEntry,
      updatedAt: fixture.sessionEntry.updatedAt + 1,
      providerOverride: "openai",
      modelOverride: "gpt-4o-mini",
      modelOverrideSource: "user",
    };
    await replaceSessionEntry({ sessionKey: "agent:main:dm:1", storePath }, concurrentEntry);

    try {
      await applyResetModelOverride({
        ...resetModelParams(fixture),
        bodyStripped: "minimax summarize",
        storePath,
      });

      expect(fixture.sessionCtx.BodyStripped).toBe("summarize");
      expect(fixture.sessionEntry).toMatchObject({
        providerOverride: "openai",
        modelOverride: "gpt-4o-mini",
        modelOverrideSource: "user",
      });
      expect(fixture.sessionEntry.updatedAt).toBeGreaterThanOrEqual(concurrentEntry.updatedAt);
      expect(fixture.sessionStore["agent:main:dm:1"]).toEqual(fixture.sessionEntry);
      expect(loadSessionEntry({ sessionKey: "agent:main:dm:1", storePath })).toEqual(
        fixture.sessionEntry,
      );
    } finally {
      clearSessionStoreCacheForTest();
    }
  });

  it("checks the persisted winner for an explicit same-value reset hint", async () => {
    const tempRoot = sessionDirs.make();
    const storePath = path.join(tempRoot, "sessions.json");
    const fixture = createResetFixture({
      providerOverride: "minimax",
      modelOverride: "m2.7",
      modelOverrideSource: "user",
    });
    const concurrentEntry: SessionEntry = {
      ...fixture.sessionEntry,
      updatedAt: fixture.sessionEntry.updatedAt + 1,
      providerOverride: "openai",
      modelOverride: "gpt-4o-mini",
    };
    await replaceSessionEntry({ sessionKey: "agent:main:dm:1", storePath }, concurrentEntry);

    try {
      await applyResetModelOverride({
        ...resetModelParams(fixture),
        bodyStripped: "minimax summarize",
        storePath,
      });

      expect(fixture.sessionEntry).toMatchObject({
        providerOverride: "openai",
        modelOverride: "gpt-4o-mini",
      });
      expect(fixture.sessionStore["agent:main:dm:1"]).toEqual(fixture.sessionEntry);
    } finally {
      clearSessionStoreCacheForTest();
    }
  });

  it("rejects a reset-model hint when the session rotates during persistence", async () => {
    const tempRoot = sessionDirs.make();
    const storePath = path.join(tempRoot, "sessions.json");
    const fixture = createResetFixture();
    const rotatedEntry: SessionEntry = {
      sessionId: "s2",
      updatedAt: fixture.sessionEntry.updatedAt + 1,
      delivery: { kind: "none" },
      providerOverride: "openai",
      modelOverride: "gpt-4o-mini",
      modelOverrideSource: "user",
    };
    await replaceSessionEntry({ sessionKey: "agent:main:dm:1", storePath }, rotatedEntry);

    try {
      await expect(
        applyResetModelOverride({
          ...resetModelParams(fixture),
          bodyStripped: "minimax summarize",
          storePath,
        }),
      ).rejects.toThrow(/changed while starting work/i);

      expect(fixture.sessionEntry.sessionId).toBe("s1");
      expect(fixture.sessionEntry.modelOverride).toBeUndefined();
      expect(fixture.sessionStore["agent:main:dm:1"]).toBe(fixture.sessionEntry);
      expect(loadSessionEntry({ sessionKey: "agent:main:dm:1", storePath })).toEqual(rotatedEntry);
    } finally {
      clearSessionStoreCacheForTest();
    }
  });
});
