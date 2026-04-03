import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  replaceRuntimeAuthProfileStoreSnapshots,
} from "../../agents/auth-profiles.js";
import type { ModelCatalogEntry } from "../../agents/model-catalog.js";
import { buildModelAliasIndex } from "../../agents/model-selection.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import { applyResetModelOverride } from "./session-reset-model.js";

const TEST_AGENT_DIR = "/tmp/openclaw-reset-model-test-agent";

const modelCatalog: ModelCatalogEntry[] = [
  { provider: "minimax", id: "m2.7", name: "M2.7" },
  { provider: "openai", id: "gpt-4o-mini", name: "GPT-4o mini" },
  { provider: "openai-codex", id: "gpt-5.4", name: "GPT-5.4" },
  { provider: "openai-codex", id: "gpt-5.3-codex-spark", name: "GPT-5.3 Codex Spark" },
];

function createOAuthAccessToken(planType: string) {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      "https://api.openai.com/auth": {
        chatgpt_plan_type: planType,
      },
    }),
  ).toString("base64url");
  return `${header}.${payload}.sig`;
}

function createResetFixture(entry: Partial<SessionEntry> = {}) {
  const cfg = {
    agents: {
      defaults: {
        models: {
          "minimax/m2.7": {},
          "openai/gpt-4o-mini": {},
          "openai-codex/gpt-5.4": {},
          "openai-codex/gpt-5.3-codex-spark": { alias: "spark" },
        },
      },
      list: [{ id: "main", agentDir: TEST_AGENT_DIR }],
    },
  } as OpenClawConfig;
  const aliasIndex = buildModelAliasIndex({ cfg, defaultProvider: "openai" });
  const sessionEntry: SessionEntry = {
    sessionId: "s1",
    updatedAt: Date.now(),
    ...entry,
  };
  return {
    cfg,
    aliasIndex,
    sessionEntry,
    sessionStore: { "agent:main:dm:1": sessionEntry } as Record<string, SessionEntry>,
    sessionCtx: {
      Body: "minimax summarize",
      BodyForAgent: "minimax summarize",
      BodyStripped: "minimax summarize",
      BodyForCommands: "minimax summarize",
      CommandBody: "minimax summarize",
      RawBody: "minimax summarize",
    },
    ctx: { ChatType: "direct" },
  };
}

async function applyResetFixture(params: {
  resetTriggered: boolean;
  sessionEntry?: Partial<SessionEntry>;
  bodyStripped?: string;
  defaultProvider?: string;
  defaultModel?: string;
}) {
  const fixture = createResetFixture(params.sessionEntry);
  await applyResetModelOverride({
    cfg: fixture.cfg,
    agentId: "main",
    resetTriggered: params.resetTriggered,
    bodyStripped: params.bodyStripped ?? "minimax summarize",
    sessionCtx: fixture.sessionCtx,
    ctx: fixture.ctx,
    sessionEntry: fixture.sessionEntry,
    sessionStore: fixture.sessionStore,
    sessionKey: "agent:main:dm:1",
    defaultProvider: params.defaultProvider ?? "openai",
    defaultModel: params.defaultModel ?? "gpt-4o-mini",
    aliasIndex: fixture.aliasIndex,
    modelCatalog,
  });
  return fixture;
}

beforeEach(() => {
  clearRuntimeAuthProfileStoreSnapshots();
  replaceRuntimeAuthProfileStoreSnapshots([
    {
      agentDir: TEST_AGENT_DIR,
      store: { version: 1, profiles: {} },
    },
  ]);
});

afterEach(() => {
  clearRuntimeAuthProfileStoreSnapshots();
});

describe("applyResetModelOverride", () => {
  it("selects a model hint and strips it from the body", async () => {
    const { sessionEntry, sessionCtx } = await applyResetFixture({
      resetTriggered: true,
    });

    expect(sessionEntry.providerOverride).toBe("minimax");
    expect(sessionEntry.modelOverride).toBe("m2.7");
    expect(sessionCtx.Body).toBe("summarize");
    expect(sessionCtx.BodyForAgent).toBe("summarize");
    expect(sessionCtx.BodyStripped).toBe("summarize");
    expect(sessionCtx.BodyForCommands).toBe("summarize");
    expect(sessionCtx.CommandBody).toBe("summarize");
    expect(sessionCtx.RawBody).toBe("summarize");
  });

  it("preserves the current auth profile path when reset applies a model", async () => {
    replaceRuntimeAuthProfileStoreSnapshots([
      {
        agentDir: TEST_AGENT_DIR,
        store: {
          version: 1,
          profiles: {
            "openai-codex:p1": {
              type: "api_key",
              provider: "openai-codex",
              key: "sk-test-p1",
            },
          },
        },
      },
    ]);

    const { sessionEntry } = await applyResetFixture({
      resetTriggered: true,
      sessionEntry: {
        authProfileOverride: "openai-codex:p1",
        authProfileOverrideSource: "auto",
        authProfileOverrideCompactionCount: 2,
      },
      bodyStripped: "spark summarize",
      defaultProvider: "openai-codex",
      defaultModel: "gpt-5.4",
    });

    expect(sessionEntry.authProfileOverride).toBe("openai-codex:p1");
    expect(sessionEntry.authProfileOverrideSource).toBe("auto");
    expect(sessionEntry.authProfileOverrideCompactionCount).toBeUndefined();
  });

  it("skips when resetTriggered is false", async () => {
    const { sessionEntry, sessionCtx } = await applyResetFixture({
      resetTriggered: false,
    });

    expect(sessionEntry.providerOverride).toBeUndefined();
    expect(sessionEntry.modelOverride).toBeUndefined();
    expect(sessionCtx.BodyStripped).toBe("minimax summarize");
  });

  it("persists explicit auth profile overrides for alias selections", async () => {
    replaceRuntimeAuthProfileStoreSnapshots([
      {
        agentDir: TEST_AGENT_DIR,
        store: {
          version: 1,
          profiles: {
            "openai-codex:default": {
              type: "api_key",
              provider: "openai-codex",
              key: "sk-test",
            },
          },
        },
      },
    ]);

    const { sessionEntry, sessionCtx } = await applyResetFixture({
      resetTriggered: true,
      bodyStripped: "spark@openai-codex:default summarize",
      defaultProvider: "openai-codex",
      defaultModel: "gpt-5.3-codex-spark",
    });

    expect(sessionEntry.providerOverride).toBe("openai-codex");
    expect(sessionEntry.modelOverride).toBe("gpt-5.3-codex-spark");
    expect(sessionEntry.authProfileOverride).toBe("openai-codex:default");
    expect(sessionEntry.authProfileOverrideSource).toBe("user");
    expect(sessionCtx.BodyStripped).toBe("summarize");
    expect(sessionCtx.BodyForAgent).toBe("summarize");
  });

  it("persists explicit auth profile overrides for provider model selections", async () => {
    replaceRuntimeAuthProfileStoreSnapshots([
      {
        agentDir: TEST_AGENT_DIR,
        store: {
          version: 1,
          profiles: {
            "openai-codex:p1": {
              type: "api_key",
              provider: "openai-codex",
              key: "sk-test-2",
            },
          },
        },
      },
    ]);

    const { sessionEntry, sessionCtx } = await applyResetFixture({
      resetTriggered: true,
      bodyStripped: "openai-codex gpt-5.4@openai-codex:p1 summarize",
      defaultProvider: "openai-codex",
      defaultModel: "gpt-5.3-codex-spark",
    });

    expect(sessionEntry.providerOverride).toBe("openai-codex");
    expect(sessionEntry.modelOverride).toBe("gpt-5.4");
    expect(sessionEntry.authProfileOverride).toBe("openai-codex:p1");
    expect(sessionEntry.authProfileOverrideSource).toBe("user");
    expect(sessionCtx.BodyStripped).toBe("summarize");
    expect(sessionCtx.BodyForAgent).toBe("summarize");
  });

  it("rejects spark on an unsupported current auth profile and keeps selection unchanged", async () => {
    replaceRuntimeAuthProfileStoreSnapshots([
      {
        agentDir: TEST_AGENT_DIR,
        store: {
          version: 1,
          profiles: {
            "openai-codex:plus": {
              type: "oauth",
              provider: "openai-codex",
              access: createOAuthAccessToken("plus"),
              refresh: "rt-test",
              expires: Date.now() + 60_000,
            },
          },
        },
      },
    ]);

    const { sessionEntry, sessionCtx } = await applyResetFixture({
      resetTriggered: true,
      bodyStripped: "spark summarize",
      sessionEntry: {
        providerOverride: "openai-codex",
        modelOverride: "gpt-5.4",
        authProfileOverride: "openai-codex:plus",
        authProfileOverrideSource: "user",
      },
      defaultProvider: "openai-codex",
      defaultModel: "gpt-5.4",
    });

    expect(sessionEntry.providerOverride).toBe("openai-codex");
    expect(sessionEntry.modelOverride).toBe("gpt-5.4");
    expect(sessionEntry.authProfileOverride).toBe("openai-codex:plus");
    expect(sessionCtx.BodyForAgent).toContain(
      'System: Spark is not supported on auth profile "openai-codex:plus" (Plus plan).',
    );
    expect(sessionCtx.BodyForAgent).toContain("summarize");
  });
});
