import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelCatalogEntry } from "../../agents/model-catalog.js";
import { buildModelAliasIndex } from "../../agents/model-selection.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";

vi.mock("../../config/sessions.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../config/sessions.js")>();
  return {
    ...original,
    updateSessionStore: vi.fn(async () => undefined),
  };
});

const modelCatalog: ModelCatalogEntry[] = [
  { provider: "minimax", id: "m2.7", name: "M2.7" },
  { provider: "openai", id: "gpt-4o-mini", name: "GPT-4o mini" },
];

function createResetFixture(entry: Partial<SessionEntry> = {}) {
  const cfg = {} as OpenClawConfig;
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
    sessionCtx: { BodyStripped: "minimax summarize" },
    ctx: { ChatType: "direct" },
  };
}

async function applyResetFixture(params: {
  resetTriggered: boolean;
  sessionEntry?: Partial<SessionEntry>;
}) {
  const fixture = createResetFixture(params.sessionEntry);
  const { applyResetModelOverride } = await import("./session-reset-model.js");
  await applyResetModelOverride({
    cfg: fixture.cfg,
    resetTriggered: params.resetTriggered,
    bodyStripped: "minimax summarize",
    sessionCtx: fixture.sessionCtx,
    ctx: fixture.ctx,
    sessionEntry: fixture.sessionEntry,
    sessionStore: fixture.sessionStore,
    sessionKey: "agent:main:dm:1",
    defaultProvider: "openai",
    defaultModel: "gpt-4o-mini",
    aliasIndex: fixture.aliasIndex,
    modelCatalog,
  });
  return fixture;
}

describe("applyResetModelOverride", () => {
  let applyResetModelOverride: typeof import("./session-reset-model.js").applyResetModelOverride;
  let updateSessionStore: typeof import("../../config/sessions.js").updateSessionStore;

  beforeEach(async () => {
    vi.resetModules();
    ({ applyResetModelOverride } = await import("./session-reset-model.js"));
    ({ updateSessionStore } = await import("../../config/sessions.js"));
  });

  it("does not pass a mutable base store to fire-and-forget persistence", async () => {
    const cfg = {} as OpenClawConfig;
    const aliasIndex = buildModelAliasIndex({ cfg, defaultProvider: "openai" });
    const sessionKey = "agent:main:dm:1";
    const sessionEntry: SessionEntry = {
      sessionId: "s1",
      updatedAt: Date.now(),
    };
    const sessionStore: Record<string, SessionEntry> = { [sessionKey]: sessionEntry };
    const sessionCtx = { BodyStripped: "minimax summarize" };
    const ctx = { ChatType: "direct" };

    vi.mocked(updateSessionStore).mockClear();

    await applyResetModelOverride({
      cfg,
      resetTriggered: true,
      bodyStripped: "minimax summarize",
      sessionCtx,
      ctx,
      sessionEntry,
      sessionStore,
      sessionKey,
      storePath: "/tmp/sessions.json",
      defaultProvider: "openai",
      defaultModel: "gpt-4o-mini",
      aliasIndex,
      modelCatalog,
    });

    expect(updateSessionStore).toHaveBeenCalledTimes(1);
    expect(vi.mocked(updateSessionStore).mock.calls[0]?.[2]).toBeUndefined();
  });

  it("selects a model hint and strips it from the body", async () => {
    const { sessionEntry, sessionCtx } = await applyResetFixture({
      resetTriggered: true,
    });

    expect(sessionEntry.providerOverride).toBe("minimax");
    expect(sessionEntry.modelOverride).toBe("m2.7");
    expect(sessionCtx.BodyStripped).toBe("summarize");
  });

  it("clears auth profile overrides when reset applies a model", async () => {
    const { sessionEntry } = await applyResetFixture({
      resetTriggered: true,
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

  it("skips when resetTriggered is false", async () => {
    const { sessionEntry, sessionCtx } = await applyResetFixture({
      resetTriggered: false,
    });

    expect(sessionEntry.providerOverride).toBeUndefined();
    expect(sessionEntry.modelOverride).toBeUndefined();
    expect(sessionCtx.BodyStripped).toBe("minimax summarize");
  });
});
