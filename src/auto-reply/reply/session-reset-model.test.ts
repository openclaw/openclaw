// Tests reset model selection and persisted model override cleanup.
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { ModelCatalogEntry } from "../../agents/model-catalog.js";
import { buildModelAliasIndex } from "../../agents/model-selection-shared.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { clearSessionStoreCacheForTest } from "../../config/sessions/store-writer-state.js";
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

async function applyResetFixture(params: {
  resetTriggered: boolean;
  sessionEntry?: Partial<SessionEntry>;
  body?: string;
}) {
  const fixture = createResetFixture(params.sessionEntry);
  await applyResetModelOverride({
    ...resetModelParams(fixture),
    resetTriggered: params.resetTriggered,
    bodyStripped: params.body ?? "minimax summarize",
  });
  return fixture;
}

describe("applyResetModelOverride", () => {
  it.each(["persisted"])("honors the %s session model lock", async (owner) => {
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
        resetTriggered: true,
        bodyStripped: "minimax/m2.7 summarize",
      }),
    ).rejects.toThrow("Model selection is locked");
    expect(fixture.sessionEntry.modelOverride).toBeUndefined();
    expect(loadSessionEntry({ sessionKey, storePath })).toEqual(lockedEntry);
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
    const result = await applyResetModelOverride({
      ...resetModelParams(fixture),
      aliasIndex: buildModelAliasIndex({ cfg: fixture.cfg, defaultProvider: "openai" }),
      resetTriggered: true,
      bodyStripped: "quick summarize",
    });
    expect(result).toMatchObject({
      selection: { provider: "fixture-route", model: "reasoner", alias: "quick" },
      cleanedBody: "summarize",
    });
    expect(fixture.sessionEntry.providerOverride).toBe("fixture-route");
  });

  it.each(["summarize the previous conversation", "missing-provider/reasoner summarize"])(
    "keeps unrecognized model-hint text unchanged: %s",
    async (body) => {
      const fixture = createResetFixture();
      fixture.sessionCtx.BodyStripped = body;
      const result = await applyResetModelOverride({
        ...fixture,
        resetTriggered: true,
        bodyStripped: fixture.sessionCtx.BodyStripped,
        defaultProvider: "openai",
        defaultModel: "gpt-4o-mini",
        modelCatalog,
      });

      expect(result).toEqual({});
      expect(fixture.sessionCtx.BodyStripped).toBe(body);
      expect(fixture.sessionEntry.modelOverride).toBeUndefined();
    },
  );

  it("loads the reset catalog for the active agent owner", async () => {
    const fixture = createResetFixture();

    await applyResetModelOverride({
      cfg: fixture.cfg,
      agentId: "worker",
      agentDir: "/tmp/shared-agent",
      workspaceDir: "/tmp/shared-workspace",
      resetTriggered: true,
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

  it.each(["minimax m2.7 summarize"])(
    "selects a model hint while preserving thinking: %s",
    async (body) => {
      const { sessionEntry, sessionCtx } = await applyResetFixture({
        resetTriggered: true,
        sessionEntry: { thinkingLevel: "ultra" },
        body,
      });

      expect(sessionEntry.providerOverride).toBe("minimax");
      expect(sessionEntry.modelOverride).toBe("m2.7");
      expect(sessionEntry.thinkingLevel).toBe("ultra");
      expect(sessionCtx.BodyStripped).toBe("summarize");
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

    const result = await applyResetModelOverride({
      ...resetModelParams(fixture),
      resetTriggered: true,
      bodyStripped: fixture.sessionCtx.BodyStripped,
      defaultProvider: "custom",
      defaultModel: "private-model",
    });

    expect(result).toEqual({});
    expect(fixture.sessionCtx.BodyStripped).toBe("custom/private-model summarize");
    expect(fixture.sessionEntry.providerOverride).toBeUndefined();
    expect(fixture.sessionEntry.modelOverride).toBeUndefined();
  });

  it("adopts a concurrent model winner instead of acknowledging the reset hint", async () => {
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
      const result = await applyResetModelOverride({
        ...resetModelParams(fixture),
        resetTriggered: true,
        bodyStripped: "minimax summarize",
        storePath,
      });

      expect(result.selection).toBeUndefined();
      expect(result.cleanedBody).toBe("summarize");
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
      const result = await applyResetModelOverride({
        ...resetModelParams(fixture),
        resetTriggered: true,
        bodyStripped: "minimax summarize",
        storePath,
      });

      expect(result.selection).toBeUndefined();
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
          resetTriggered: true,
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

  it("skips when resetTriggered is false", async () => {
    const { sessionEntry, sessionCtx } = await applyResetFixture({
      resetTriggered: false,
    });

    expect(sessionEntry.providerOverride).toBeUndefined();
    expect(sessionEntry.modelOverride).toBeUndefined();
    expect(sessionCtx.BodyStripped).toBe("minimax summarize");
  });
});
