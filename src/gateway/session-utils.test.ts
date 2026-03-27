import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  addSubagentRunForTests,
  resetSubagentRegistryForTests,
} from "../agents/subagent-registry.js";
import { clearConfigCache, writeConfigFile } from "../config/config.js";
import type { OpenClawConfig } from "../config/config.js";
import type { SessionEntry } from "../config/sessions.js";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import { withEnv } from "../test-utils/env.js";
import {
  capArrayByJsonBytes,
  classifySessionKey,
  deriveSessionTitle,
  listAgentsForGateway,
  listSessionsFromStore,
  loadCombinedSessionStoreForGateway,
  loadSessionEntry,
  migrateAndPruneGatewaySessionStoreKey,
  parseGroupKey,
  pruneLegacyStoreKeys,
  resolveGatewaySessionStoreTarget,
  resolveSessionModelIdentityRef,
  resolveSessionModelRef,
  resolveSessionStoreKey,
} from "./session-utils.js";

function resolveSyncRealpath(filePath: string): string {
  return fs.realpathSync.native(filePath);
}

function createSymlinkOrSkip(targetPath: string, linkPath: string): boolean {
  try {
    fs.symlinkSync(targetPath, linkPath);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (process.platform === "win32" && (code === "EPERM" || code === "EACCES")) {
      return false;
    }
    throw error;
  }
}

function createSingleAgentAvatarConfig(workspace: string): OpenClawConfig {
  return {
    session: { mainKey: "main" },
    agents: {
      list: [{ id: "main", default: true, workspace, identity: { avatar: "avatar-link.png" } }],
    },
  } as OpenClawConfig;
}

function createModelDefaultsConfig(params: {
  primary: string;
  models?: Record<string, Record<string, never>>;
}): OpenClawConfig {
  return {
    agents: {
      defaults: {
        model: { primary: params.primary },
        models: params.models,
      },
    },
  } as OpenClawConfig;
}

function createLegacyRuntimeListConfig(
  models?: Record<string, Record<string, never>>,
): OpenClawConfig {
  return createModelDefaultsConfig({
    primary: "google-gemini-cli/gemini-3-pro-preview",
    ...(models ? { models } : {}),
  });
}

function createLegacyRuntimeStore(model: string): Record<string, SessionEntry> {
  return {
    "agent:main:main": {
      sessionId: "sess-main",
      updatedAt: Date.now(),
      model,
    } as SessionEntry,
  };
}

describe("gateway session utils", () => {
  afterEach(() => {
    resetSubagentRegistryForTests({ persist: false });
  });

  test("capArrayByJsonBytes trims from the front", () => {
    const res = capArrayByJsonBytes(["a", "b", "c"], 10);
    expect(res.items).toEqual(["b", "c"]);
  });

  test("parseGroupKey handles group keys", () => {
    expect(parseGroupKey("discord:group:dev")).toEqual({
      channel: "discord",
      kind: "group",
      id: "dev",
    });
    expect(parseGroupKey("agent:ops:discord:group:dev")).toEqual({
      channel: "discord",
      kind: "group",
      id: "dev",
    });
    expect(parseGroupKey("foo:bar")).toBeNull();
  });

  test("classifySessionKey respects chat type + prefixes", () => {
    expect(classifySessionKey("global")).toBe("global");
    expect(classifySessionKey("unknown")).toBe("unknown");
    expect(classifySessionKey("discord:group:dev")).toBe("group");
    expect(classifySessionKey("main")).toBe("direct");
    const entry = { chatType: "group" } as SessionEntry;
    expect(classifySessionKey("main", entry)).toBe("group");
  });

  test("resolveSessionStoreKey maps main aliases to default agent main", () => {
    const cfg = {
      session: { mainKey: "work" },
      agents: { list: [{ id: "ops", default: true }] },
    } as OpenClawConfig;
    expect(resolveSessionStoreKey({ cfg, sessionKey: "main" })).toBe("agent:ops:work");
    expect(resolveSessionStoreKey({ cfg, sessionKey: "work" })).toBe("agent:ops:work");
    expect(resolveSessionStoreKey({ cfg, sessionKey: "agent:ops:main" })).toBe("agent:ops:work");
    // Mixed-case main alias must also resolve to the configured mainKey (idempotent)
    expect(resolveSessionStoreKey({ cfg, sessionKey: "agent:ops:MAIN" })).toBe("agent:ops:work");
    expect(resolveSessionStoreKey({ cfg, sessionKey: "MAIN" })).toBe("agent:ops:work");
  });

  test("resolveSessionStoreKey canonicalizes bare keys to default agent", () => {
    const cfg = {
      session: { mainKey: "main" },
      agents: { list: [{ id: "ops", default: true }] },
    } as OpenClawConfig;
    expect(resolveSessionStoreKey({ cfg, sessionKey: "discord:group:123" })).toBe(
      "agent:ops:discord:group:123",
    );
    expect(resolveSessionStoreKey({ cfg, sessionKey: "agent:alpha:main" })).toBe(
      "agent:alpha:main",
    );
  });

  test("resolveSessionStoreKey falls back to first list entry when no agent is marked default", () => {
    const cfg = {
      session: { mainKey: "main" },
      agents: { list: [{ id: "ops" }, { id: "review" }] },
    } as OpenClawConfig;
    expect(resolveSessionStoreKey({ cfg, sessionKey: "main" })).toBe("agent:ops:main");
    expect(resolveSessionStoreKey({ cfg, sessionKey: "discord:group:123" })).toBe(
      "agent:ops:discord:group:123",
    );
  });

  test("resolveSessionStoreKey falls back to main when agents.list is missing", () => {
    const cfg = {
      session: { mainKey: "work" },
    } as OpenClawConfig;
    expect(resolveSessionStoreKey({ cfg, sessionKey: "main" })).toBe("agent:main:work");
    expect(resolveSessionStoreKey({ cfg, sessionKey: "thread-1" })).toBe("agent:main:thread-1");
  });

  test("resolveSessionStoreKey normalizes session key casing", () => {
    const cfg = {
      session: { mainKey: "main" },
      agents: { list: [{ id: "ops", default: true }] },
    } as OpenClawConfig;
    // Bare keys with different casing must resolve to the same canonical key
    expect(resolveSessionStoreKey({ cfg, sessionKey: "CoP" })).toBe(
      resolveSessionStoreKey({ cfg, sessionKey: "cop" }),
    );
    expect(resolveSessionStoreKey({ cfg, sessionKey: "MySession" })).toBe("agent:ops:mysession");
    // Prefixed agent keys with mixed-case rest must also normalize
    expect(resolveSessionStoreKey({ cfg, sessionKey: "agent:ops:CoP" })).toBe("agent:ops:cop");
    expect(resolveSessionStoreKey({ cfg, sessionKey: "agent:alpha:MySession" })).toBe(
      "agent:alpha:mysession",
    );
  });

  test("resolveSessionStoreKey honors global scope", () => {
    const cfg = {
      session: { scope: "global", mainKey: "work" },
      agents: { list: [{ id: "ops", default: true }] },
    } as OpenClawConfig;
    expect(resolveSessionStoreKey({ cfg, sessionKey: "main" })).toBe("global");
    const target = resolveGatewaySessionStoreTarget({ cfg, key: "main" });
    expect(target.canonicalKey).toBe("global");
    expect(target.agentId).toBe("ops");
  });

  test("resolveGatewaySessionStoreTarget uses canonical key for main alias", () => {
    const storeTemplate = path.join(
      os.tmpdir(),
      "openclaw-session-utils",
      "{agentId}",
      "sessions.json",
    );
    const cfg = {
      session: { mainKey: "main", store: storeTemplate },
      agents: { list: [{ id: "ops", default: true }] },
    } as OpenClawConfig;
    const target = resolveGatewaySessionStoreTarget({ cfg, key: "main" });
    expect(target.canonicalKey).toBe("agent:ops:main");
    expect(target.storeKeys).toEqual(expect.arrayContaining(["agent:ops:main", "main"]));
    expect(target.storePath).toBe(path.resolve(storeTemplate.replace("{agentId}", "ops")));
  });

  test("resolveGatewaySessionStoreTarget includes legacy mixed-case store key", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "session-utils-case-"));
    const storePath = path.join(dir, "sessions.json");
    // Simulate a legacy store with a mixed-case key
    fs.writeFileSync(
      storePath,
      JSON.stringify({ "agent:ops:MySession": { sessionId: "s1", updatedAt: 1 } }),
      "utf8",
    );
    const cfg = {
      session: { mainKey: "main", store: storePath },
      agents: { list: [{ id: "ops", default: true }] },
    } as OpenClawConfig;
    // Client passes the lowercased canonical key (as returned by sessions.list)
    const target = resolveGatewaySessionStoreTarget({ cfg, key: "agent:ops:mysession" });
    expect(target.canonicalKey).toBe("agent:ops:mysession");
    // storeKeys must include the legacy mixed-case key from the on-disk store
    expect(target.storeKeys).toEqual(
      expect.arrayContaining(["agent:ops:mysession", "agent:ops:MySession"]),
    );
    // The legacy key must resolve to the actual entry in the store
    const store = JSON.parse(fs.readFileSync(storePath, "utf8"));
    const found = target.storeKeys.some((k) => Boolean(store[k]));
    expect(found).toBe(true);
  });

  test("resolveGatewaySessionStoreTarget includes all case-variant duplicate keys", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "session-utils-dupes-"));
    const storePath = path.join(dir, "sessions.json");
    // Simulate a store with both canonical and legacy mixed-case entries
    fs.writeFileSync(
      storePath,
      JSON.stringify({
        "agent:ops:mysession": { sessionId: "s-lower", updatedAt: 2 },
        "agent:ops:MySession": { sessionId: "s-mixed", updatedAt: 1 },
      }),
      "utf8",
    );
    const cfg = {
      session: { mainKey: "main", store: storePath },
      agents: { list: [{ id: "ops", default: true }] },
    } as OpenClawConfig;
    const target = resolveGatewaySessionStoreTarget({ cfg, key: "agent:ops:mysession" });
    // storeKeys must include BOTH variants so delete/reset/patch can clean up all duplicates
    expect(target.storeKeys).toEqual(
      expect.arrayContaining(["agent:ops:mysession", "agent:ops:MySession"]),
    );
  });

  test("resolveGatewaySessionStoreTarget finds legacy main alias key when mainKey is customized", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "session-utils-alias-"));
    const storePath = path.join(dir, "sessions.json");
    // Legacy store has entry under "agent:ops:MAIN" but mainKey is "work"
    fs.writeFileSync(
      storePath,
      JSON.stringify({ "agent:ops:MAIN": { sessionId: "s1", updatedAt: 1 } }),
      "utf8",
    );
    const cfg = {
      session: { mainKey: "work", store: storePath },
      agents: { list: [{ id: "ops", default: true }] },
    } as OpenClawConfig;
    const target = resolveGatewaySessionStoreTarget({ cfg, key: "agent:ops:main" });
    expect(target.canonicalKey).toBe("agent:ops:work");
    // storeKeys must include the legacy mixed-case alias key
    expect(target.storeKeys).toEqual(expect.arrayContaining(["agent:ops:MAIN"]));
  });

  test("resolveGatewaySessionStoreTarget preserves discovered store paths for non-round-tripping agent dirs", async () => {
    await withStateDirEnv("session-utils-discovered-store-", async ({ stateDir }) => {
      const retiredSessionsDir = path.join(stateDir, "agents", "Retired Agent", "sessions");
      fs.mkdirSync(retiredSessionsDir, { recursive: true });
      const retiredStorePath = path.join(retiredSessionsDir, "sessions.json");
      fs.writeFileSync(
        retiredStorePath,
        JSON.stringify({
          "agent:retired-agent:main": { sessionId: "sess-retired", updatedAt: 1 },
        }),
        "utf8",
      );

      const cfg = {
        session: {
          mainKey: "main",
          store: path.join(stateDir, "agents", "{agentId}", "sessions", "sessions.json"),
        },
        agents: { list: [{ id: "main", default: true }] },
      } as OpenClawConfig;

      const target = resolveGatewaySessionStoreTarget({ cfg, key: "agent:retired-agent:main" });

      expect(target.storePath).toBe(resolveSyncRealpath(retiredStorePath));
    });
  });

  test("loadSessionEntry reads discovered stores from non-round-tripping agent dirs", async () => {
    clearConfigCache();
    try {
      await withStateDirEnv("session-utils-load-entry-", async ({ stateDir }) => {
        const retiredSessionsDir = path.join(stateDir, "agents", "Retired Agent", "sessions");
        fs.mkdirSync(retiredSessionsDir, { recursive: true });
        const retiredStorePath = path.join(retiredSessionsDir, "sessions.json");
        fs.writeFileSync(
          retiredStorePath,
          JSON.stringify({
            "agent:retired-agent:main": { sessionId: "sess-retired", updatedAt: 7 },
          }),
          "utf8",
        );
        await writeConfigFile({
          session: {
            mainKey: "main",
            store: path.join(stateDir, "agents", "{agentId}", "sessions", "sessions.json"),
          },
          agents: { list: [{ id: "main", default: true }] },
        });
        clearConfigCache();

        const loaded = loadSessionEntry("agent:retired-agent:main");

        expect(loaded.storePath).toBe(resolveSyncRealpath(retiredStorePath));
        expect(loaded.entry?.sessionId).toBe("sess-retired");
      });
    } finally {
      clearConfigCache();
    }
  });

  test("loadSessionEntry prefers the freshest duplicate row for a logical key", async () => {
    clearConfigCache();
    try {
      await withStateDirEnv("session-utils-load-entry-freshest-", async ({ stateDir }) => {
        const sessionsDir = path.join(stateDir, "agents", "main", "sessions");
        fs.mkdirSync(sessionsDir, { recursive: true });
        const storePath = path.join(sessionsDir, "sessions.json");
        fs.writeFileSync(
          storePath,
          JSON.stringify(
            {
              "agent:main:main": { sessionId: "sess-stale", updatedAt: 1 },
              "agent:main:MAIN": { sessionId: "sess-fresh", updatedAt: 2 },
            },
            null,
            2,
          ),
          "utf8",
        );
        await writeConfigFile({
          session: {
            mainKey: "main",
            store: path.join(stateDir, "agents", "{agentId}", "sessions", "sessions.json"),
          },
          agents: { list: [{ id: "main", default: true }] },
        });
        clearConfigCache();

        const loaded = loadSessionEntry("agent:main:main");

        expect(loaded.entry?.sessionId).toBe("sess-fresh");
      });
    } finally {
      clearConfigCache();
    }
  });

  test("loadSessionEntry prefers the freshest duplicate row across discovered stores", async () => {
    clearConfigCache();
    try {
      await withStateDirEnv("session-utils-load-entry-cross-store-", async ({ stateDir }) => {
        const canonicalSessionsDir = path.join(stateDir, "agents", "main", "sessions");
        fs.mkdirSync(canonicalSessionsDir, { recursive: true });
        fs.writeFileSync(
          path.join(canonicalSessionsDir, "sessions.json"),
          JSON.stringify(
            {
              "agent:main:main": { sessionId: "sess-canonical-stale", updatedAt: 10 },
              "agent:main:MAIN": { sessionId: "sess-canonical-fresh", updatedAt: 1000 },
            },
            null,
            2,
          ),
          "utf8",
        );

        const discoveredSessionsDir = path.join(stateDir, "agents", "main ", "sessions");
        fs.mkdirSync(discoveredSessionsDir, { recursive: true });
        fs.writeFileSync(
          path.join(discoveredSessionsDir, "sessions.json"),
          JSON.stringify(
            {
              "agent:main:main": { sessionId: "sess-discovered-mid", updatedAt: 500 },
            },
            null,
            2,
          ),
          "utf8",
        );

        await writeConfigFile({
          session: {
            mainKey: "main",
            store: path.join(stateDir, "agents", "{agentId}", "sessions", "sessions.json"),
          },
          agents: { list: [{ id: "main", default: true }] },
        });
        clearConfigCache();

        const loaded = loadSessionEntry("agent:main:main");

        expect(loaded.entry?.sessionId).toBe("sess-canonical-fresh");
      });
    } finally {
      clearConfigCache();
    }
  });

  test("pruneLegacyStoreKeys removes alias and case-variant ghost keys", () => {
    const store: Record<string, unknown> = {
      "agent:ops:work": { sessionId: "canonical", updatedAt: 3 },
      "agent:ops:MAIN": { sessionId: "legacy-upper", updatedAt: 1 },
      "agent:ops:Main": { sessionId: "legacy-mixed", updatedAt: 2 },
      "agent:ops:main": { sessionId: "legacy-lower", updatedAt: 4 },
    };
    pruneLegacyStoreKeys({
      store,
      canonicalKey: "agent:ops:work",
      candidates: ["agent:ops:work", "agent:ops:main"],
    });
    expect(Object.keys(store).toSorted()).toEqual(["agent:ops:work"]);
  });

  test("migrateAndPruneGatewaySessionStoreKey promotes the freshest duplicate row", () => {
    const cfg = {
      session: { mainKey: "main" },
      agents: { list: [{ id: "main", default: true }] },
    } as OpenClawConfig;
    const store: Record<string, SessionEntry> = {
      "agent:main:Main": {
        sessionId: "sess-stale",
        updatedAt: 1,
      } as SessionEntry,
      "agent:main:MAIN": {
        sessionId: "sess-fresh",
        updatedAt: 2,
      } as SessionEntry,
    };

    const result = migrateAndPruneGatewaySessionStoreKey({
      cfg,
      key: "agent:main:main",
      store,
    });

    expect(result.primaryKey).toBe("agent:main:main");
    expect(result.entry?.sessionId).toBe("sess-fresh");
    expect(store["agent:main:main"]?.sessionId).toBe("sess-fresh");
    expect(store["agent:main:MAIN"]).toBeUndefined();
    expect(store["agent:main:Main"]).toBeUndefined();
  });

  test("migrateAndPruneGatewaySessionStoreKey replaces a stale canonical row with a fresher duplicate", () => {
    const cfg = {
      session: { mainKey: "main" },
      agents: { list: [{ id: "main", default: true }] },
    } as OpenClawConfig;
    const store: Record<string, SessionEntry> = {
      "agent:main:main": {
        sessionId: "sess-stale",
        updatedAt: 1,
      } as SessionEntry,
      "agent:main:MAIN": {
        sessionId: "sess-fresh",
        updatedAt: 2,
      } as SessionEntry,
    };

    const result = migrateAndPruneGatewaySessionStoreKey({
      cfg,
      key: "agent:main:main",
      store,
    });

    expect(result.primaryKey).toBe("agent:main:main");
    expect(result.entry?.sessionId).toBe("sess-fresh");
    expect(store["agent:main:main"]?.sessionId).toBe("sess-fresh");
    expect(store["agent:main:MAIN"]).toBeUndefined();
  });

  test("listAgentsForGateway rejects avatar symlink escapes outside workspace", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "session-utils-avatar-outside-"));
    const workspace = path.join(root, "workspace");
    fs.mkdirSync(workspace, { recursive: true });
    const outsideFile = path.join(root, "outside.txt");
    fs.writeFileSync(outsideFile, "top-secret", "utf8");
    const linkPath = path.join(workspace, "avatar-link.png");
    if (!createSymlinkOrSkip(outsideFile, linkPath)) {
      return;
    }

    const cfg = createSingleAgentAvatarConfig(workspace);

    const result = listAgentsForGateway(cfg);
    expect(result.agents[0]?.identity?.avatarUrl).toBeUndefined();
  });

  test("listAgentsForGateway allows avatar symlinks that stay inside workspace", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "session-utils-avatar-inside-"));
    const workspace = path.join(root, "workspace");
    fs.mkdirSync(path.join(workspace, "avatars"), { recursive: true });
    const targetPath = path.join(workspace, "avatars", "actual.png");
    fs.writeFileSync(targetPath, "avatar", "utf8");
    const linkPath = path.join(workspace, "avatar-link.png");
    if (!createSymlinkOrSkip(targetPath, linkPath)) {
      return;
    }

    const cfg = createSingleAgentAvatarConfig(workspace);

    const result = listAgentsForGateway(cfg);
    expect(result.agents[0]?.identity?.avatarUrl).toBe(
      `data:image/png;base64,${Buffer.from("avatar").toString("base64")}`,
    );
  });

  test("listAgentsForGateway keeps explicit agents.list scope over disk-only agents (scope boundary)", async () => {
    await withStateDirEnv("openclaw-agent-list-scope-", async ({ stateDir }) => {
      fs.mkdirSync(path.join(stateDir, "agents", "main"), { recursive: true });
      fs.mkdirSync(path.join(stateDir, "agents", "codex"), { recursive: true });

      const cfg = {
        session: { mainKey: "main" },
        agents: { list: [{ id: "main", default: true }] },
      } as OpenClawConfig;

      const { agents } = listAgentsForGateway(cfg);
      expect(agents.map((agent) => agent.id)).toEqual(["main"]);
    });
  });
});

describe("resolveSessionModelRef", () => {
  test("prefers runtime model/provider from session entry", () => {
    const cfg = createModelDefaultsConfig({
      primary: "anthropic/claude-opus-4-6",
    });

    const resolved = resolveSessionModelRef(cfg, {
      sessionId: "s1",
      updatedAt: Date.now(),
      modelProvider: "openai-codex",
      model: "gpt-5.4",
      modelOverride: "claude-opus-4-6",
      providerOverride: "anthropic",
    });

    expect(resolved).toEqual({ provider: "openai-codex", model: "gpt-5.4" });
  });

  test("preserves openrouter provider when model contains vendor prefix", () => {
    const cfg = createModelDefaultsConfig({
      primary: "openrouter/minimax/minimax-m2.7",
    });

    const resolved = resolveSessionModelRef(cfg, {
      sessionId: "s-or",
      updatedAt: Date.now(),
      modelProvider: "openrouter",
      model: "anthropic/claude-haiku-4.5",
    });

    expect(resolved).toEqual({
      provider: "openrouter",
      model: "anthropic/claude-haiku-4.5",
    });
  });

  test("falls back to override when runtime model is not recorded yet", () => {
    const cfg = createModelDefaultsConfig({
      primary: "anthropic/claude-opus-4-6",
    });

    const resolved = resolveSessionModelRef(cfg, {
      sessionId: "s2",
      updatedAt: Date.now(),
      modelOverride: "openai-codex/gpt-5.4",
    });

    expect(resolved).toEqual({ provider: "openai-codex", model: "gpt-5.4" });
  });

  test("falls back to resolved provider for unprefixed legacy runtime model", () => {
    const cfg = createModelDefaultsConfig({
      primary: "google-gemini-cli/gemini-3-pro-preview",
    });

    const resolved = resolveSessionModelRef(cfg, {
      sessionId: "legacy-session",
      updatedAt: Date.now(),
      model: "claude-sonnet-4-6",
      modelProvider: undefined,
    });

    expect(resolved).toEqual({
      provider: "google-gemini-cli",
      model: "claude-sonnet-4-6",
    });
  });

  test("preserves provider from slash-prefixed model when modelProvider is missing", () => {
    // When model string contains a provider prefix (e.g. "anthropic/claude-sonnet-4-6")
    // parseModelRef should extract it correctly even without modelProvider set.
    const cfg = createModelDefaultsConfig({
      primary: "google-gemini-cli/gemini-3-pro-preview",
    });

    const resolved = resolveSessionModelRef(cfg, {
      sessionId: "slash-model",
      updatedAt: Date.now(),
      model: "anthropic/claude-sonnet-4-6",
      modelProvider: undefined,
    });

    expect(resolved).toEqual({ provider: "anthropic", model: "claude-sonnet-4-6" });
  });
});

describe("resolveSessionModelIdentityRef", () => {
  const resolveLegacyIdentityRef = (
    cfg: OpenClawConfig,
    modelProvider: string | undefined = undefined,
  ) =>
    resolveSessionModelIdentityRef(cfg, {
      sessionId: "legacy-session",
      updatedAt: Date.now(),
      model: "claude-sonnet-4-6",
      modelProvider,
    });

  test("does not inherit default provider for unprefixed legacy runtime model", () => {
    const cfg = createModelDefaultsConfig({
      primary: "google-gemini-cli/gemini-3-pro-preview",
    });

    const resolved = resolveLegacyIdentityRef(cfg);

    expect(resolved).toEqual({ model: "claude-sonnet-4-6" });
  });

  test("infers provider from configured model allowlist when unambiguous", () => {
    const cfg = createModelDefaultsConfig({
      primary: "google-gemini-cli/gemini-3-pro-preview",
      models: {
        "anthropic/claude-sonnet-4-6": {},
      },
    });

    const resolved = resolveLegacyIdentityRef(cfg);

    expect(resolved).toEqual({ provider: "anthropic", model: "claude-sonnet-4-6" });
  });

  test("keeps provider unknown when configured models are ambiguous", () => {
    const cfg = createModelDefaultsConfig({
      primary: "google-gemini-cli/gemini-3-pro-preview",
      models: {
        "anthropic/claude-sonnet-4-6": {},
        "minimax/claude-sonnet-4-6": {},
      },
    });

    const resolved = resolveLegacyIdentityRef(cfg);

    expect(resolved).toEqual({ model: "claude-sonnet-4-6" });
  });

  test("preserves provider from slash-prefixed runtime model", () => {
    const cfg = createModelDefaultsConfig({
      primary: "google-gemini-cli/gemini-3-pro-preview",
    });

    const resolved = resolveSessionModelIdentityRef(cfg, {
      sessionId: "slash-model",
      updatedAt: Date.now(),
      model: "anthropic/claude-sonnet-4-6",
      modelProvider: undefined,
    });

    expect(resolved).toEqual({ provider: "anthropic", model: "claude-sonnet-4-6" });
  });

  test("infers wrapper provider for slash-prefixed runtime model when allowlist match is unique", () => {
    const cfg = createModelDefaultsConfig({
      primary: "google-gemini-cli/gemini-3-pro-preview",
      models: {
        "vercel-ai-gateway/anthropic/claude-sonnet-4-6": {},
      },
    });

    const resolved = resolveSessionModelIdentityRef(cfg, {
      sessionId: "slash-model",
      updatedAt: Date.now(),
      model: "anthropic/claude-sonnet-4-6",
      modelProvider: undefined,
    });

    expect(resolved).toEqual({
      provider: "vercel-ai-gateway",
      model: "anthropic/claude-sonnet-4-6",
    });
  });
});

describe("deriveSessionTitle", () => {
  test("returns undefined for undefined entry", () => {
    expect(deriveSessionTitle(undefined)).toBeUndefined();
  });

  test("prefers displayName when set", () => {
    const entry = {
      sessionId: "abc123",
      updatedAt: Date.now(),
      displayName: "My Custom Session",
      subject: "Group Chat",
    } as SessionEntry;
    expect(deriveSessionTitle(entry)).toBe("My Custom Session");
  });

  test("falls back to subject when displayName is missing", () => {
    const entry = {
      sessionId: "abc123",
      updatedAt: Date.now(),
      subject: "Dev Team Chat",
    } as SessionEntry;
    expect(deriveSessionTitle(entry)).toBe("Dev Team Chat");
  });

  test("uses first user message when displayName and subject missing", () => {
    const entry = {
      sessionId: "abc123",
      updatedAt: Date.now(),
    } as SessionEntry;
    expect(deriveSessionTitle(entry, "Hello, how are you?")).toBe("Hello, how are you?");
  });

  test("truncates long first user message to 60 chars with ellipsis", () => {
    const entry = {
      sessionId: "abc123",
      updatedAt: Date.now(),
    } as SessionEntry;
    const longMsg =
      "This is a very long message that exceeds sixty characters and should be truncated appropriately";
    const result = deriveSessionTitle(entry, longMsg);
    expect(result).toBeDefined();
    expect(result!.length).toBeLessThanOrEqual(60);
    expect(result!.endsWith("…")).toBe(true);
  });

  test("truncates at word boundary when possible", () => {
    const entry = {
      sessionId: "abc123",
      updatedAt: Date.now(),
    } as SessionEntry;
    const longMsg = "This message has many words and should be truncated at a word boundary nicely";
    const result = deriveSessionTitle(entry, longMsg);
    expect(result).toBeDefined();
    expect(result!.endsWith("…")).toBe(true);
    expect(result!.includes("  ")).toBe(false);
  });

  test("falls back to sessionId prefix with date", () => {
    const entry = {
      sessionId: "abcd1234-5678-90ef-ghij-klmnopqrstuv",
      updatedAt: new Date("2024-03-15T10:30:00Z").getTime(),
    } as SessionEntry;
    const result = deriveSessionTitle(entry);
    expect(result).toBe("abcd1234 (2024-03-15)");
  });

  test("falls back to sessionId prefix without date when updatedAt missing", () => {
    const entry = {
      sessionId: "abcd1234-5678-90ef-ghij-klmnopqrstuv",
      updatedAt: 0,
    } as SessionEntry;
    const result = deriveSessionTitle(entry);
    expect(result).toBe("abcd1234");
  });

  test("trims whitespace from displayName", () => {
    const entry = {
      sessionId: "abc123",
      updatedAt: Date.now(),
      displayName: "  Padded Name  ",
    } as SessionEntry;
    expect(deriveSessionTitle(entry)).toBe("Padded Name");
  });

  test("ignores empty displayName and falls through", () => {
    const entry = {
      sessionId: "abc123",
      updatedAt: Date.now(),
      displayName: "   ",
      subject: "Actual Subject",
    } as SessionEntry;
    expect(deriveSessionTitle(entry)).toBe("Actual Subject");
  });
});

describe("listSessionsFromStore search", () => {
  const baseCfg = {
    session: { mainKey: "main" },
    agents: { list: [{ id: "main", default: true }] },
  } as OpenClawConfig;

  const makeStore = (): Record<string, SessionEntry> => ({
    "agent:main:work-project": {
      sessionId: "sess-work-1",
      updatedAt: Date.now(),
      displayName: "Work Project Alpha",
      label: "work",
    } as SessionEntry,
    "agent:main:personal-chat": {
      sessionId: "sess-personal-1",
      updatedAt: Date.now() - 1000,
      displayName: "Personal Chat",
      subject: "Family Reunion Planning",
    } as SessionEntry,
    "agent:main:discord:group:dev-team": {
      sessionId: "sess-discord-1",
      updatedAt: Date.now() - 2000,
      label: "discord",
      subject: "Dev Team Discussion",
    } as SessionEntry,
  });

  test("returns all sessions when search is empty or missing", () => {
    const cases = [{ opts: { search: "" } }, { opts: {} }] as const;
    for (const testCase of cases) {
      const result = listSessionsFromStore({
        cfg: baseCfg,
        storePath: "/tmp/sessions.json",
        store: makeStore(),
        opts: testCase.opts,
      });
      expect(result.sessions).toHaveLength(3);
    }
  });

  test("filters sessions across display metadata and key fields", () => {
    const cases = [
      { search: "WORK PROJECT", expectedKey: "agent:main:work-project" },
      { search: "reunion", expectedKey: "agent:main:personal-chat" },
      { search: "discord", expectedKey: "agent:main:discord:group:dev-team" },
      { search: "sess-personal", expectedKey: "agent:main:personal-chat" },
      { search: "dev-team", expectedKey: "agent:main:discord:group:dev-team" },
      { search: "alpha", expectedKey: "agent:main:work-project" },
      { search: "  personal  ", expectedKey: "agent:main:personal-chat" },
      { search: "nonexistent-term", expectedKey: undefined },
    ] as const;

    for (const testCase of cases) {
      const result = listSessionsFromStore({
        cfg: baseCfg,
        storePath: "/tmp/sessions.json",
        store: makeStore(),
        opts: { search: testCase.search },
      });
      if (!testCase.expectedKey) {
        expect(result.sessions).toHaveLength(0);
        continue;
      }
      expect(result.sessions).toHaveLength(1);
      expect(result.sessions[0].key).toBe(testCase.expectedKey);
    }
  });

  test("hides cron run alias session keys from sessions list", () => {
    const now = Date.now();
    const store: Record<string, SessionEntry> = {
      "agent:main:cron:job-1": {
        sessionId: "run-abc",
        updatedAt: now,
        label: "Cron: job-1",
      } as SessionEntry,
      "agent:main:cron:job-1:run:run-abc": {
        sessionId: "run-abc",
        updatedAt: now,
        label: "Cron: job-1",
      } as SessionEntry,
    };

    const result = listSessionsFromStore({
      cfg: baseCfg,
      storePath: "/tmp/sessions.json",
      store,
      opts: {},
    });

    expect(result.sessions.map((session) => session.key)).toEqual(["agent:main:cron:job-1"]);
  });

  test.each([
    {
      name: "does not guess provider for legacy runtime model without modelProvider",
      cfg: createLegacyRuntimeListConfig(),
      runtimeModel: "claude-sonnet-4-6",
      expectedProvider: undefined,
    },
    {
      name: "infers provider for legacy runtime model when allowlist match is unique",
      cfg: createLegacyRuntimeListConfig({ "anthropic/claude-sonnet-4-6": {} }),
      runtimeModel: "claude-sonnet-4-6",
      expectedProvider: "anthropic",
    },
    {
      name: "infers wrapper provider for slash-prefixed legacy runtime model when allowlist match is unique",
      cfg: createLegacyRuntimeListConfig({
        "vercel-ai-gateway/anthropic/claude-sonnet-4-6": {},
      }),
      runtimeModel: "anthropic/claude-sonnet-4-6",
      expectedProvider: "vercel-ai-gateway",
    },
  ])("$name", ({ cfg, runtimeModel, expectedProvider }) => {
    const result = listSessionsFromStore({
      cfg,
      storePath: "/tmp/sessions.json",
      store: createLegacyRuntimeStore(runtimeModel),
      opts: {},
    });

    expect(result.sessions[0]?.modelProvider).toBe(expectedProvider);
    expect(result.sessions[0]?.model).toBe(runtimeModel);
  });

  test("exposes unknown totals when freshness is stale or missing", () => {
    const now = Date.now();
    const store: Record<string, SessionEntry> = {
      "agent:main:fresh": {
        sessionId: "sess-fresh",
        updatedAt: now,
        totalTokens: 1200,
        totalTokensFresh: true,
      } as SessionEntry,
      "agent:main:stale": {
        sessionId: "sess-stale",
        updatedAt: now - 1000,
        totalTokens: 2200,
        totalTokensFresh: false,
      } as SessionEntry,
      "agent:main:missing": {
        sessionId: "sess-missing",
        updatedAt: now - 2000,
        inputTokens: 100,
        outputTokens: 200,
      } as SessionEntry,
    };

    const result = listSessionsFromStore({
      cfg: baseCfg,
      storePath: "/tmp/sessions.json",
      store,
      opts: {},
    });

    const fresh = result.sessions.find((row) => row.key === "agent:main:fresh");
    const stale = result.sessions.find((row) => row.key === "agent:main:stale");
    const missing = result.sessions.find((row) => row.key === "agent:main:missing");
    expect(fresh?.totalTokens).toBe(1200);
    expect(fresh?.totalTokensFresh).toBe(true);
    expect(stale?.totalTokens).toBeUndefined();
    expect(stale?.totalTokensFresh).toBe(false);
    expect(missing?.totalTokens).toBeUndefined();
    expect(missing?.totalTokensFresh).toBe(false);
  });

  test("includes estimated session cost when model pricing is configured", () => {
    const cfg = {
      session: { mainKey: "main" },
      agents: { list: [{ id: "main", default: true }] },
      models: {
        providers: {
          openai: {
            models: [
              {
                id: "gpt-5.4",
                label: "GPT 5.4",
                baseUrl: "https://api.openai.com/v1",
                cost: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0.5 },
              },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig;
    const result = listSessionsFromStore({
      cfg,
      storePath: "/tmp/sessions.json",
      store: {
        "agent:main:main": {
          sessionId: "sess-main",
          updatedAt: Date.now(),
          modelProvider: "openai",
          model: "gpt-5.4",
          inputTokens: 2_000,
          outputTokens: 500,
          cacheRead: 1_000,
          cacheWrite: 200,
        } as SessionEntry,
      },
      opts: {},
    });

    expect(result.sessions[0]?.estimatedCostUsd).toBeCloseTo(0.007725, 8);
  });

  test("prefers persisted estimated session cost from the store", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-session-utils-store-cost-"));
    const storePath = path.join(tmpDir, "sessions.json");
    fs.writeFileSync(
      path.join(tmpDir, "sess-main.jsonl"),
      [
        JSON.stringify({ type: "session", version: 1, id: "sess-main" }),
        JSON.stringify({
          message: {
            role: "assistant",
            provider: "anthropic",
            model: "claude-sonnet-4-6",
            usage: {
              input: 2_000,
              output: 500,
              cacheRead: 1_200,
              cost: { total: 0.007725 },
            },
          },
        }),
      ].join("\n"),
      "utf-8",
    );

    try {
      const result = listSessionsFromStore({
        cfg: baseCfg,
        storePath,
        store: {
          "agent:main:main": {
            sessionId: "sess-main",
            updatedAt: Date.now(),
            modelProvider: "anthropic",
            model: "claude-sonnet-4-6",
            estimatedCostUsd: 0.1234,
            totalTokens: 0,
            totalTokensFresh: false,
          } as SessionEntry,
        },
        opts: {},
      });

      expect(result.sessions[0]?.estimatedCostUsd).toBe(0.1234);
      expect(result.sessions[0]?.totalTokens).toBe(3_200);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("keeps zero estimated session cost when configured model pricing resolves to free", () => {
    const cfg = {
      session: { mainKey: "main" },
      agents: { list: [{ id: "main", default: true }] },
      models: {
        providers: {
          "openai-codex": {
            models: [
              {
                id: "gpt-5.3-codex-spark",
                label: "GPT 5.3 Codex Spark",
                baseUrl: "https://api.openai.com/v1",
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig;
    const result = listSessionsFromStore({
      cfg,
      storePath: "/tmp/sessions.json",
      store: {
        "agent:main:main": {
          sessionId: "sess-main",
          updatedAt: Date.now(),
          modelProvider: "openai-codex",
          model: "gpt-5.3-codex-spark",
          inputTokens: 5_107,
          outputTokens: 1_827,
          cacheRead: 1_536,
          cacheWrite: 0,
        } as SessionEntry,
      },
      opts: {},
    });

    expect(result.sessions[0]?.estimatedCostUsd).toBe(0);
  });

  test("falls back to transcript usage for totalTokens and zero estimatedCostUsd", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-session-utils-zero-cost-"));
    const storePath = path.join(tmpDir, "sessions.json");
    fs.writeFileSync(
      path.join(tmpDir, "sess-main.jsonl"),
      [
        JSON.stringify({ type: "session", version: 1, id: "sess-main" }),
        JSON.stringify({
          message: {
            role: "assistant",
            provider: "openai-codex",
            model: "gpt-5.3-codex-spark",
            usage: {
              input: 5_107,
              output: 1_827,
              cacheRead: 1_536,
              cost: { total: 0 },
            },
          },
        }),
      ].join("\n"),
      "utf-8",
    );

    try {
      const result = listSessionsFromStore({
        cfg: baseCfg,
        storePath,
        store: {
          "agent:main:main": {
            sessionId: "sess-main",
            updatedAt: Date.now(),
            modelProvider: "openai-codex",
            model: "gpt-5.3-codex-spark",
            totalTokens: 0,
            totalTokensFresh: false,
            inputTokens: 0,
            outputTokens: 0,
            cacheRead: 0,
            cacheWrite: 0,
          } as SessionEntry,
        },
        opts: {},
      });

      expect(result.sessions[0]?.totalTokens).toBe(6_643);
      expect(result.sessions[0]?.totalTokensFresh).toBe(true);
      expect(result.sessions[0]?.estimatedCostUsd).toBe(0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("falls back to transcript usage for totalTokens and estimatedCostUsd, and derives contextTokens from the resolved model", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-session-utils-"));
    const storePath = path.join(tmpDir, "sessions.json");
    const cfg = {
      session: { mainKey: "main" },
      agents: {
        list: [{ id: "main", default: true }],
        defaults: {
          models: {
            "anthropic/claude-sonnet-4-6": { params: { context1m: true } },
          },
        },
      },
    } as unknown as OpenClawConfig;
    fs.writeFileSync(
      path.join(tmpDir, "sess-main.jsonl"),
      [
        JSON.stringify({ type: "session", version: 1, id: "sess-main" }),
        JSON.stringify({
          message: {
            role: "assistant",
            provider: "anthropic",
            model: "claude-sonnet-4-6",
            usage: {
              input: 2_000,
              output: 500,
              cacheRead: 1_200,
              cost: { total: 0.007725 },
            },
          },
        }),
      ].join("\n"),
      "utf-8",
    );

    try {
      const result = listSessionsFromStore({
        cfg,
        storePath,
        store: {
          "agent:main:main": {
            sessionId: "sess-main",
            updatedAt: Date.now(),
            modelProvider: "anthropic",
            model: "claude-sonnet-4-6",
            totalTokens: 0,
            totalTokensFresh: false,
            inputTokens: 0,
            outputTokens: 0,
            cacheRead: 0,
            cacheWrite: 0,
          } as SessionEntry,
        },
        opts: {},
      });

      expect(result.sessions[0]?.totalTokens).toBe(3_200);
      expect(result.sessions[0]?.totalTokensFresh).toBe(true);
      expect(result.sessions[0]?.contextTokens).toBe(1_048_576);
      expect(result.sessions[0]?.estimatedCostUsd).toBeCloseTo(0.007725, 8);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("uses subagent run model immediately for child sessions while transcript usage fills live totals", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-session-utils-subagent-"));
    const storePath = path.join(tmpDir, "sessions.json");
    const now = Date.now();
    const cfg = {
      session: { mainKey: "main" },
      agents: {
        list: [{ id: "main", default: true }],
        defaults: {
          models: {
            "anthropic/claude-sonnet-4-6": { params: { context1m: true } },
          },
        },
      },
    } as unknown as OpenClawConfig;
    fs.writeFileSync(
      path.join(tmpDir, "sess-child.jsonl"),
      [
        JSON.stringify({ type: "session", version: 1, id: "sess-child" }),
        JSON.stringify({
          message: {
            role: "assistant",
            provider: "anthropic",
            model: "claude-sonnet-4-6",
            usage: {
              input: 2_000,
              output: 500,
              cacheRead: 1_200,
              cost: { total: 0.007725 },
            },
          },
        }),
      ].join("\n"),
      "utf-8",
    );

    addSubagentRunForTests({
      runId: "run-child-live",
      childSessionKey: "agent:main:subagent:child-live",
      controllerSessionKey: "agent:main:main",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "child task",
      cleanup: "keep",
      createdAt: now - 5_000,
      startedAt: now - 4_000,
      model: "anthropic/claude-sonnet-4-6",
    });

    try {
      const result = listSessionsFromStore({
        cfg,
        storePath,
        store: {
          "agent:main:subagent:child-live": {
            sessionId: "sess-child",
            updatedAt: now,
            spawnedBy: "agent:main:main",
            totalTokens: 0,
            totalTokensFresh: false,
          } as SessionEntry,
        },
        opts: {},
      });

      expect(result.sessions[0]).toMatchObject({
        key: "agent:main:subagent:child-live",
        status: "running",
        modelProvider: "anthropic",
        model: "claude-sonnet-4-6",
        totalTokens: 3_200,
        totalTokensFresh: true,
        contextTokens: 1_048_576,
      });
      expect(result.sessions[0]?.estimatedCostUsd).toBeCloseTo(0.007725, 8);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("listSessionsFromStore subagent metadata", () => {
  afterEach(() => {
    resetSubagentRegistryForTests({ persist: false });
  });
  beforeEach(() => {
    resetSubagentRegistryForTests({ persist: false });
  });

  const cfg = {
    session: { mainKey: "main" },
    agents: { list: [{ id: "main", default: true }] },
  } as OpenClawConfig;

  test("includes subagent status timing and direct child session keys", () => {
    const now = Date.now();
    const store: Record<string, SessionEntry> = {
      "agent:main:main": {
        sessionId: "sess-main",
        updatedAt: now,
      } as SessionEntry,
      "agent:main:subagent:parent": {
        sessionId: "sess-parent",
        updatedAt: now - 2_000,
        spawnedBy: "agent:main:main",
      } as SessionEntry,
      "agent:main:subagent:child": {
        sessionId: "sess-child",
        updatedAt: now - 1_000,
        spawnedBy: "agent:main:subagent:parent",
      } as SessionEntry,
      "agent:main:subagent:failed": {
        sessionId: "sess-failed",
        updatedAt: now - 500,
        spawnedBy: "agent:main:main",
      } as SessionEntry,
    };

    addSubagentRunForTests({
      runId: "run-parent",
      childSessionKey: "agent:main:subagent:parent",
      controllerSessionKey: "agent:main:main",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "parent task",
      cleanup: "keep",
      createdAt: now - 10_000,
      startedAt: now - 9_000,
      model: "openai/gpt-5.4",
    });
    addSubagentRunForTests({
      runId: "run-child",
      childSessionKey: "agent:main:subagent:child",
      controllerSessionKey: "agent:main:subagent:parent",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "child task",
      cleanup: "keep",
      createdAt: now - 8_000,
      startedAt: now - 7_500,
      endedAt: now - 2_500,
      outcome: { status: "ok" },
      model: "openai/gpt-5.4",
    });
    addSubagentRunForTests({
      runId: "run-failed",
      childSessionKey: "agent:main:subagent:failed",
      controllerSessionKey: "agent:main:main",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "failed task",
      cleanup: "keep",
      createdAt: now - 6_000,
      startedAt: now - 5_500,
      endedAt: now - 500,
      outcome: { status: "error", error: "boom" },
      model: "openai/gpt-5.4",
    });

    const result = listSessionsFromStore({
      cfg,
      storePath: "/tmp/sessions.json",
      store,
      opts: {},
    });

    const main = result.sessions.find((session) => session.key === "agent:main:main");
    expect(main?.childSessions).toEqual([
      "agent:main:subagent:parent",
      "agent:main:subagent:failed",
    ]);
    expect(main?.status).toBeUndefined();

    const parent = result.sessions.find((session) => session.key === "agent:main:subagent:parent");
    expect(parent?.status).toBe("running");
    expect(parent?.startedAt).toBe(now - 9_000);
    expect(parent?.endedAt).toBeUndefined();
    expect(parent?.runtimeMs).toBeGreaterThanOrEqual(9_000);
    expect(parent?.childSessions).toEqual(["agent:main:subagent:child"]);

    const child = result.sessions.find((session) => session.key === "agent:main:subagent:child");
    expect(child?.status).toBe("done");
    expect(child?.startedAt).toBe(now - 7_500);
    expect(child?.endedAt).toBe(now - 2_500);
    expect(child?.runtimeMs).toBe(5_000);
    expect(child?.childSessions).toBeUndefined();

    const failed = result.sessions.find((session) => session.key === "agent:main:subagent:failed");
    expect(failed?.status).toBe("failed");
    expect(failed?.runtimeMs).toBe(5_000);
  });

  test("does not keep childSessions attached to a stale older controller row", () => {
    const now = Date.now();
    const store: Record<string, SessionEntry> = {
      "agent:main:main": {
        sessionId: "sess-main",
        updatedAt: now,
      } as SessionEntry,
      "agent:main:subagent:old-parent": {
        sessionId: "sess-old-parent",
        updatedAt: now - 4_000,
        spawnedBy: "agent:main:main",
      } as SessionEntry,
      "agent:main:subagent:new-parent": {
        sessionId: "sess-new-parent",
        updatedAt: now - 3_000,
        spawnedBy: "agent:main:main",
      } as SessionEntry,
      "agent:main:subagent:shared-child": {
        sessionId: "sess-shared-child",
        updatedAt: now - 1_000,
        spawnedBy: "agent:main:subagent:new-parent",
      } as SessionEntry,
    };

    addSubagentRunForTests({
      runId: "run-old-parent",
      childSessionKey: "agent:main:subagent:old-parent",
      controllerSessionKey: "agent:main:main",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "old parent task",
      cleanup: "keep",
      createdAt: now - 10_000,
      startedAt: now - 9_000,
    });
    addSubagentRunForTests({
      runId: "run-new-parent",
      childSessionKey: "agent:main:subagent:new-parent",
      controllerSessionKey: "agent:main:main",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "new parent task",
      cleanup: "keep",
      createdAt: now - 8_000,
      startedAt: now - 7_000,
    });
    addSubagentRunForTests({
      runId: "run-child-stale-parent",
      childSessionKey: "agent:main:subagent:shared-child",
      controllerSessionKey: "agent:main:subagent:old-parent",
      requesterSessionKey: "agent:main:subagent:old-parent",
      requesterDisplayKey: "old-parent",
      task: "shared child stale parent",
      cleanup: "keep",
      createdAt: now - 6_000,
      startedAt: now - 5_500,
      endedAt: now - 4_500,
      outcome: { status: "ok" },
    });
    addSubagentRunForTests({
      runId: "run-child-current-parent",
      childSessionKey: "agent:main:subagent:shared-child",
      controllerSessionKey: "agent:main:subagent:new-parent",
      requesterSessionKey: "agent:main:subagent:new-parent",
      requesterDisplayKey: "new-parent",
      task: "shared child current parent",
      cleanup: "keep",
      createdAt: now - 2_000,
      startedAt: now - 1_500,
    });

    const result = listSessionsFromStore({
      cfg,
      storePath: "/tmp/sessions.json",
      store,
      opts: {},
    });

    const oldParent = result.sessions.find(
      (session) => session.key === "agent:main:subagent:old-parent",
    );
    const newParent = result.sessions.find(
      (session) => session.key === "agent:main:subagent:new-parent",
    );

    expect(oldParent?.childSessions).toBeUndefined();
    expect(newParent?.childSessions).toEqual(["agent:main:subagent:shared-child"]);
  });

  test("does not reattach moved children through stale spawnedBy store metadata", () => {
    const now = Date.now();
    const store: Record<string, SessionEntry> = {
      "agent:main:main": {
        sessionId: "sess-main",
        updatedAt: now,
      } as SessionEntry,
      "agent:main:subagent:old-parent-store": {
        sessionId: "sess-old-parent-store",
        updatedAt: now - 4_000,
        spawnedBy: "agent:main:main",
      } as SessionEntry,
      "agent:main:subagent:new-parent-store": {
        sessionId: "sess-new-parent-store",
        updatedAt: now - 3_000,
        spawnedBy: "agent:main:main",
      } as SessionEntry,
      "agent:main:subagent:shared-child-store": {
        sessionId: "sess-shared-child-store",
        updatedAt: now - 1_000,
        spawnedBy: "agent:main:subagent:old-parent-store",
      } as SessionEntry,
    };

    addSubagentRunForTests({
      runId: "run-old-parent-store",
      childSessionKey: "agent:main:subagent:old-parent-store",
      controllerSessionKey: "agent:main:main",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "old parent store task",
      cleanup: "keep",
      createdAt: now - 10_000,
      startedAt: now - 9_000,
    });
    addSubagentRunForTests({
      runId: "run-new-parent-store",
      childSessionKey: "agent:main:subagent:new-parent-store",
      controllerSessionKey: "agent:main:main",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "new parent store task",
      cleanup: "keep",
      createdAt: now - 8_000,
      startedAt: now - 7_000,
    });
    addSubagentRunForTests({
      runId: "run-child-store-stale-parent",
      childSessionKey: "agent:main:subagent:shared-child-store",
      controllerSessionKey: "agent:main:subagent:old-parent-store",
      requesterSessionKey: "agent:main:subagent:old-parent-store",
      requesterDisplayKey: "old-parent-store",
      task: "shared child stale store parent",
      cleanup: "keep",
      createdAt: now - 6_000,
      startedAt: now - 5_500,
      endedAt: now - 4_500,
      outcome: { status: "ok" },
    });
    addSubagentRunForTests({
      runId: "run-child-store-current-parent",
      childSessionKey: "agent:main:subagent:shared-child-store",
      controllerSessionKey: "agent:main:subagent:new-parent-store",
      requesterSessionKey: "agent:main:subagent:new-parent-store",
      requesterDisplayKey: "new-parent-store",
      task: "shared child current store parent",
      cleanup: "keep",
      createdAt: now - 2_000,
      startedAt: now - 1_500,
    });

    const result = listSessionsFromStore({
      cfg,
      storePath: "/tmp/sessions.json",
      store,
      opts: {},
    });

    const oldParent = result.sessions.find(
      (session) => session.key === "agent:main:subagent:old-parent-store",
    );
    const newParent = result.sessions.find(
      (session) => session.key === "agent:main:subagent:new-parent-store",
    );

    expect(oldParent?.childSessions).toBeUndefined();
    expect(newParent?.childSessions).toEqual(["agent:main:subagent:shared-child-store"]);
  });

  test("does not return moved child sessions from stale spawnedBy filters", () => {
    const now = Date.now();
    const store: Record<string, SessionEntry> = {
      "agent:main:main": {
        sessionId: "sess-main",
        updatedAt: now,
      } as SessionEntry,
      "agent:main:subagent:old-parent-filter": {
        sessionId: "sess-old-parent-filter",
        updatedAt: now - 4_000,
        spawnedBy: "agent:main:main",
      } as SessionEntry,
      "agent:main:subagent:new-parent-filter": {
        sessionId: "sess-new-parent-filter",
        updatedAt: now - 3_000,
        spawnedBy: "agent:main:main",
      } as SessionEntry,
      "agent:main:subagent:shared-child-filter": {
        sessionId: "sess-shared-child-filter",
        updatedAt: now - 1_000,
        spawnedBy: "agent:main:subagent:old-parent-filter",
      } as SessionEntry,
    };

    addSubagentRunForTests({
      runId: "run-old-parent-filter",
      childSessionKey: "agent:main:subagent:old-parent-filter",
      controllerSessionKey: "agent:main:main",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "old parent filter task",
      cleanup: "keep",
      createdAt: now - 10_000,
      startedAt: now - 9_000,
    });
    addSubagentRunForTests({
      runId: "run-new-parent-filter",
      childSessionKey: "agent:main:subagent:new-parent-filter",
      controllerSessionKey: "agent:main:main",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "new parent filter task",
      cleanup: "keep",
      createdAt: now - 8_000,
      startedAt: now - 7_000,
    });
    addSubagentRunForTests({
      runId: "run-child-filter-stale-parent",
      childSessionKey: "agent:main:subagent:shared-child-filter",
      controllerSessionKey: "agent:main:subagent:old-parent-filter",
      requesterSessionKey: "agent:main:subagent:old-parent-filter",
      requesterDisplayKey: "old-parent-filter",
      task: "shared child stale filter parent",
      cleanup: "keep",
      createdAt: now - 6_000,
      startedAt: now - 5_500,
      endedAt: now - 4_500,
      outcome: { status: "ok" },
    });
    addSubagentRunForTests({
      runId: "run-child-filter-current-parent",
      childSessionKey: "agent:main:subagent:shared-child-filter",
      controllerSessionKey: "agent:main:subagent:new-parent-filter",
      requesterSessionKey: "agent:main:subagent:new-parent-filter",
      requesterDisplayKey: "new-parent-filter",
      task: "shared child current filter parent",
      cleanup: "keep",
      createdAt: now - 2_000,
      startedAt: now - 1_500,
    });

    const result = listSessionsFromStore({
      cfg,
      storePath: "/tmp/sessions.json",
      store,
      opts: {
        spawnedBy: "agent:main:subagent:old-parent-filter",
      },
    });

    expect(result.sessions.map((session) => session.key)).toEqual([]);
  });

  test("reports the newest run owner for moved child session rows", () => {
    const now = Date.now();
    const childSessionKey = "agent:main:subagent:shared-child-owner";
    const store: Record<string, SessionEntry> = {
      [childSessionKey]: {
        sessionId: "sess-shared-child-owner",
        updatedAt: now,
        spawnedBy: "agent:main:subagent:old-parent-owner",
      } as SessionEntry,
    };

    addSubagentRunForTests({
      runId: "run-child-owner-stale-parent",
      childSessionKey,
      controllerSessionKey: "agent:main:subagent:old-parent-owner",
      requesterSessionKey: "agent:main:subagent:old-parent-owner",
      requesterDisplayKey: "old-parent-owner",
      task: "shared child stale owner parent",
      cleanup: "keep",
      createdAt: now - 6_000,
      startedAt: now - 5_500,
      endedAt: now - 4_500,
      outcome: { status: "ok" },
    });
    addSubagentRunForTests({
      runId: "run-child-owner-current-parent",
      childSessionKey,
      controllerSessionKey: "agent:main:subagent:new-parent-owner",
      requesterSessionKey: "agent:main:subagent:new-parent-owner",
      requesterDisplayKey: "new-parent-owner",
      task: "shared child current owner parent",
      cleanup: "keep",
      createdAt: now - 2_000,
      startedAt: now - 1_500,
    });

    const result = listSessionsFromStore({
      cfg,
      storePath: "/tmp/sessions.json",
      store,
      opts: {},
    });

    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]).toMatchObject({
      key: childSessionKey,
      spawnedBy: "agent:main:subagent:new-parent-owner",
    });
  });

  test("reports the newest parentSessionKey for moved child session rows", () => {
    const now = Date.now();
    const childSessionKey = "agent:main:subagent:shared-child-parent";
    const store: Record<string, SessionEntry> = {
      [childSessionKey]: {
        sessionId: "sess-shared-child-parent",
        updatedAt: now,
        parentSessionKey: "agent:main:subagent:old-parent-parent",
      } as SessionEntry,
    };

    addSubagentRunForTests({
      runId: "run-child-parent-stale-parent",
      childSessionKey,
      controllerSessionKey: "agent:main:subagent:old-parent-parent",
      requesterSessionKey: "agent:main:subagent:old-parent-parent",
      requesterDisplayKey: "old-parent-parent",
      task: "shared child stale parentSessionKey parent",
      cleanup: "keep",
      createdAt: now - 6_000,
      startedAt: now - 5_500,
      endedAt: now - 4_500,
      outcome: { status: "ok" },
    });
    addSubagentRunForTests({
      runId: "run-child-parent-current-parent",
      childSessionKey,
      controllerSessionKey: "agent:main:subagent:new-parent-parent",
      requesterSessionKey: "agent:main:subagent:new-parent-parent",
      requesterDisplayKey: "new-parent-parent",
      task: "shared child current parentSessionKey parent",
      cleanup: "keep",
      createdAt: now - 2_000,
      startedAt: now - 1_500,
    });

    const result = listSessionsFromStore({
      cfg,
      storePath: "/tmp/sessions.json",
      store,
      opts: {},
    });

    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]).toMatchObject({
      key: childSessionKey,
      parentSessionKey: "agent:main:subagent:new-parent-parent",
    });
  });

  test("preserves original session timing across follow-up replacement runs", () => {
    const now = Date.now();
    const store: Record<string, SessionEntry> = {
      "agent:main:subagent:followup": {
        sessionId: "sess-followup",
        updatedAt: now,
        spawnedBy: "agent:main:main",
      } as SessionEntry,
    };

    addSubagentRunForTests({
      runId: "run-followup-new",
      childSessionKey: "agent:main:subagent:followup",
      controllerSessionKey: "agent:main:main",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "follow-up task",
      cleanup: "keep",
      createdAt: now - 10_000,
      startedAt: now - 30_000,
      sessionStartedAt: now - 150_000,
      accumulatedRuntimeMs: 120_000,
      model: "openai/gpt-5.4",
    });

    const result = listSessionsFromStore({
      cfg,
      storePath: "/tmp/sessions.json",
      store,
      opts: {},
    });

    const followup = result.sessions.find(
      (session) => session.key === "agent:main:subagent:followup",
    );
    expect(followup?.status).toBe("running");
    expect(followup?.startedAt).toBe(now - 150_000);
    expect(followup?.runtimeMs).toBeGreaterThanOrEqual(150_000);
  });

  test("uses the newest child-session row for stale/current replacement pairs", () => {
    const now = Date.now();
    const childSessionKey = "agent:main:subagent:stale-current";
    const store: Record<string, SessionEntry> = {
      [childSessionKey]: {
        sessionId: "sess-stale-current",
        updatedAt: now,
        spawnedBy: "agent:main:main",
      } as SessionEntry,
    };

    addSubagentRunForTests({
      runId: "run-stale-active",
      childSessionKey,
      controllerSessionKey: "agent:main:main",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "stale active row",
      cleanup: "keep",
      createdAt: now - 5_000,
      startedAt: now - 4_500,
      model: "openai/gpt-5.4",
    });
    addSubagentRunForTests({
      runId: "run-current-ended",
      childSessionKey,
      controllerSessionKey: "agent:main:main",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "current ended row",
      cleanup: "keep",
      createdAt: now - 1_000,
      startedAt: now - 900,
      endedAt: now - 200,
      outcome: { status: "ok" },
      model: "openai/gpt-5.4",
    });

    const result = listSessionsFromStore({
      cfg,
      storePath: "/tmp/sessions.json",
      store,
      opts: {},
    });

    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]).toMatchObject({
      key: childSessionKey,
      status: "done",
      startedAt: now - 900,
      endedAt: now - 200,
    });
  });

  test("uses persisted active subagent runs when the local worker only has terminal snapshots", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-session-utils-subagent-"));
    const stateDir = path.join(tempRoot, "state");
    fs.mkdirSync(stateDir, { recursive: true });
    try {
      const now = Date.now();
      const childSessionKey = "agent:main:subagent:disk-live";
      const registryPath = path.join(stateDir, "subagents", "runs.json");
      fs.mkdirSync(path.dirname(registryPath), { recursive: true });
      fs.writeFileSync(
        registryPath,
        JSON.stringify(
          {
            version: 2,
            runs: {
              "run-complete": {
                runId: "run-complete",
                childSessionKey,
                requesterSessionKey: "agent:main:main",
                requesterDisplayKey: "main",
                task: "finished too early",
                cleanup: "keep",
                createdAt: now - 2_000,
                startedAt: now - 1_900,
                endedAt: now - 1_800,
                outcome: { status: "ok" },
              },
              "run-live": {
                runId: "run-live",
                childSessionKey,
                requesterSessionKey: "agent:main:main",
                requesterDisplayKey: "main",
                task: "still running",
                cleanup: "keep",
                createdAt: now - 10_000,
                startedAt: now - 9_000,
              },
            },
          },
          null,
          2,
        ),
        "utf-8",
      );

      const row = withEnv(
        {
          OPENCLAW_STATE_DIR: stateDir,
          OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_DISK: "1",
        },
        () => {
          const result = listSessionsFromStore({
            cfg,
            storePath: "/tmp/sessions.json",
            store: {
              [childSessionKey]: {
                sessionId: "sess-disk-live",
                updatedAt: now,
                spawnedBy: "agent:main:main",
                status: "done",
                endedAt: now - 1_800,
                runtimeMs: 100,
              } as SessionEntry,
            },
            opts: {},
          });
          return result.sessions.find((session) => session.key === childSessionKey);
        },
      );

      expect(row?.status).toBe("running");
      expect(row?.startedAt).toBe(now - 9_000);
      expect(row?.endedAt).toBeUndefined();
      expect(row?.runtimeMs).toBeGreaterThanOrEqual(9_000);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test("includes explicit parentSessionKey relationships for dashboard child sessions", () => {
    resetSubagentRegistryForTests({ persist: false });
    const now = Date.now();
    const store: Record<string, SessionEntry> = {
      "agent:main:main": {
        sessionId: "sess-main",
        updatedAt: now,
      } as SessionEntry,
      "agent:main:dashboard:child": {
        sessionId: "sess-child",
        updatedAt: now - 1_000,
        parentSessionKey: "agent:main:main",
      } as SessionEntry,
    };

    const result = listSessionsFromStore({
      cfg,
      storePath: "/tmp/sessions.json",
      store,
      opts: {},
    });

    const main = result.sessions.find((session) => session.key === "agent:main:main");
    const child = result.sessions.find((session) => session.key === "agent:main:dashboard:child");
    expect(main?.childSessions).toEqual(["agent:main:dashboard:child"]);
    expect(child?.parentSessionKey).toBe("agent:main:main");
  });

  test("returns dashboard child sessions when filtering by parentSessionKey owner", () => {
    resetSubagentRegistryForTests({ persist: false });
    const now = Date.now();
    const store: Record<string, SessionEntry> = {
      "agent:main:main": {
        sessionId: "sess-main",
        updatedAt: now,
      } as SessionEntry,
      "agent:main:dashboard:child": {
        sessionId: "sess-dashboard-child",
        updatedAt: now - 1_000,
        parentSessionKey: "agent:main:main",
      } as SessionEntry,
    };

    const result = listSessionsFromStore({
      cfg,
      storePath: "/tmp/sessions.json",
      store,
      opts: {
        spawnedBy: "agent:main:main",
      },
    });

    expect(result.sessions.map((session) => session.key)).toEqual(["agent:main:dashboard:child"]);
  });

  test("falls back to persisted subagent timing after run archival", () => {
    const now = Date.now();
    const store: Record<string, SessionEntry> = {
      "agent:main:subagent:archived": {
        sessionId: "sess-archived",
        updatedAt: now,
        spawnedBy: "agent:main:main",
        startedAt: now - 20_000,
        endedAt: now - 5_000,
        runtimeMs: 15_000,
        status: "done",
      } as SessionEntry,
    };

    const result = listSessionsFromStore({
      cfg,
      storePath: "/tmp/sessions.json",
      store,
      opts: {},
    });

    const archived = result.sessions.find(
      (session) => session.key === "agent:main:subagent:archived",
    );
    expect(archived?.status).toBe("done");
    expect(archived?.startedAt).toBe(now - 20_000);
    expect(archived?.endedAt).toBe(now - 5_000);
    expect(archived?.runtimeMs).toBe(15_000);
  });

  test("maps timeout outcomes to timeout status and clamps negative runtime", () => {
    const now = Date.now();
    const store: Record<string, SessionEntry> = {
      "agent:main:subagent:timeout": {
        sessionId: "sess-timeout",
        updatedAt: now,
        spawnedBy: "agent:main:main",
      } as SessionEntry,
    };

    addSubagentRunForTests({
      runId: "run-timeout",
      childSessionKey: "agent:main:subagent:timeout",
      controllerSessionKey: "agent:main:main",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "timeout task",
      cleanup: "keep",
      createdAt: now - 10_000,
      startedAt: now - 1_000,
      endedAt: now - 2_000,
      outcome: { status: "timeout" },
      model: "openai/gpt-5.4",
    });

    const result = listSessionsFromStore({
      cfg,
      storePath: "/tmp/sessions.json",
      store,
      opts: {},
    });

    const timeout = result.sessions.find(
      (session) => session.key === "agent:main:subagent:timeout",
    );
    expect(timeout?.status).toBe("timeout");
    expect(timeout?.runtimeMs).toBe(0);
  });
});

describe("loadCombinedSessionStoreForGateway includes disk-only agents (#32804)", () => {
  test("ACP agent sessions are visible even when agents.list is configured", async () => {
    await withStateDirEnv("openclaw-acp-vis-", async ({ stateDir }) => {
      const customRoot = path.join(stateDir, "custom-state");
      const agentsDir = path.join(customRoot, "agents");
      const mainDir = path.join(agentsDir, "main", "sessions");
      const codexDir = path.join(agentsDir, "codex", "sessions");
      fs.mkdirSync(mainDir, { recursive: true });
      fs.mkdirSync(codexDir, { recursive: true });

      fs.writeFileSync(
        path.join(mainDir, "sessions.json"),
        JSON.stringify({
          "agent:main:main": { sessionId: "s-main", updatedAt: 100 },
        }),
        "utf8",
      );

      fs.writeFileSync(
        path.join(codexDir, "sessions.json"),
        JSON.stringify({
          "agent:codex:acp-task": { sessionId: "s-codex", updatedAt: 200 },
        }),
        "utf8",
      );

      const cfg = {
        session: {
          mainKey: "main",
          store: path.join(customRoot, "agents", "{agentId}", "sessions", "sessions.json"),
        },
        agents: {
          list: [{ id: "main", default: true }],
        },
      } as OpenClawConfig;

      const { store } = loadCombinedSessionStoreForGateway(cfg);
      expect(store["agent:main:main"]).toBeDefined();
      expect(store["agent:codex:acp-task"]).toBeDefined();
    });
  });
});

describe("listSessionsFromStore pre-apply limit optimization", () => {
  const baseCfg = {
    session: { mainKey: "main" },
    agents: { list: [{ id: "main", default: true }] },
  } as OpenClawConfig;

  let tmpDir: string;
  let storePath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-limit-preapply-"));
    storePath = path.join(tmpDir, "sessions.json");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  function writeTranscript(sessionId: string, totalTokens: number) {
    fs.writeFileSync(
      path.join(tmpDir, `${sessionId}.jsonl`),
      [
        JSON.stringify({ type: "session", version: 1, id: sessionId }),
        JSON.stringify({
          message: {
            role: "assistant",
            provider: "anthropic",
            model: "claude-sonnet-4-6",
            usage: {
              input: Math.floor(totalTokens / 2),
              output: totalTokens - Math.floor(totalTokens / 2),
            },
          },
        }),
      ].join("\n"),
      "utf-8",
    );
  }

  test("with limit and no search, only limited sessions' transcripts are read", () => {
    const now = Date.now();
    // Create 5 sessions that will trigger the transcript usage fallback
    // (totalTokens: 0 forces fallback).
    const store: Record<string, SessionEntry> = {};
    for (let i = 0; i < 5; i++) {
      const key = `agent:main:sess-${i}`;
      const sessionId = `limit-preapply-${i}`;
      store[key] = {
        sessionId,
        updatedAt: now - i * 1000, // sess-0 is most recent, sess-4 is oldest
        totalTokens: 0,
        totalTokensFresh: false,
      } as SessionEntry;
      writeTranscript(sessionId, 100 * (i + 1));
    }

    // Spy on fs.openSync to count how many transcript files are opened for reading.
    const originalOpenSync = fs.openSync;
    let transcriptReadCount = 0;
    const _readSpy = vi.spyOn(fs, "openSync").mockImplementation((...args: unknown[]) => {
      const filePath = String(args[0]);
      if (
        typeof filePath === "string" &&
        filePath.includes("limit-preapply-") &&
        filePath.endsWith(".jsonl")
      ) {
        transcriptReadCount++;
      }
      return originalOpenSync.apply(fs, args as Parameters<typeof fs.openSync>);
    });

    const result = listSessionsFromStore({
      cfg: baseCfg,
      storePath,
      store,
      opts: { limit: 2 },
    });

    // Should return exactly 2 sessions (the most recent by updatedAt).
    expect(result.sessions).toHaveLength(2);
    expect(result.sessions[0].key).toBe("agent:main:sess-0");
    expect(result.sessions[1].key).toBe("agent:main:sess-1");

    // Only 2 transcript files should have been stat'd (not all 5).
    expect(transcriptReadCount).toBe(2);
  });

  test("with search present, all sessions are still processed", () => {
    const now = Date.now();
    const store: Record<string, SessionEntry> = {};
    for (let i = 0; i < 5; i++) {
      const key = `agent:main:search-sess-${i}`;
      const sessionId = `search-preapply-${i}`;
      store[key] = {
        sessionId,
        updatedAt: now - i * 1000,
        displayName: i === 4 ? "target-needle" : `Session ${i}`,
        totalTokens: 0,
        totalTokensFresh: false,
      } as SessionEntry;
      writeTranscript(sessionId, 100 * (i + 1));
    }

    const originalOpenSync = fs.openSync;
    let transcriptReadCount = 0;
    const _readSpy = vi.spyOn(fs, "openSync").mockImplementation((...args: unknown[]) => {
      const filePath = String(args[0]);
      if (
        typeof filePath === "string" &&
        filePath.includes("search-preapply-") &&
        filePath.endsWith(".jsonl")
      ) {
        transcriptReadCount++;
      }
      return originalOpenSync.apply(fs, args as Parameters<typeof fs.openSync>);
    });

    const result = listSessionsFromStore({
      cfg: baseCfg,
      storePath,
      store,
      opts: { search: "target-needle", limit: 2 },
    });

    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0].key).toBe("agent:main:search-sess-4");

    // All 5 transcript files should have been read because search bypasses pre-limit.
    expect(transcriptReadCount).toBe(5);
  });

  test("activeMinutes filter is applied before transcript fallback reads", () => {
    const now = Date.now();
    const store: Record<string, SessionEntry> = {};
    // Create 4 sessions: 2 within activeMinutes, 2 outside.
    for (let i = 0; i < 4; i++) {
      const key = `agent:main:active-sess-${i}`;
      const sessionId = `active-preapply-${i}`;
      // Sessions 0 and 1 are recent (within 5 minutes), sessions 2 and 3 are old.
      const updatedAt = i < 2 ? now - i * 60_000 : now - 30 * 60_000 - i * 1000;
      store[key] = {
        sessionId,
        updatedAt,
        totalTokens: 0,
        totalTokensFresh: false,
      } as SessionEntry;
      writeTranscript(sessionId, 100 * (i + 1));
    }

    const originalOpenSync = fs.openSync;
    let transcriptReadCount = 0;
    const _readSpy = vi.spyOn(fs, "openSync").mockImplementation((...args: unknown[]) => {
      const filePath = String(args[0]);
      if (
        typeof filePath === "string" &&
        filePath.includes("active-preapply-") &&
        filePath.endsWith(".jsonl")
      ) {
        transcriptReadCount++;
      }
      return originalOpenSync.apply(fs, args as Parameters<typeof fs.openSync>);
    });

    const result = listSessionsFromStore({
      cfg: baseCfg,
      storePath,
      store,
      opts: { activeMinutes: 5 },
    });

    // Only the 2 recent sessions should be returned.
    expect(result.sessions).toHaveLength(2);
    expect(result.sessions.map((s) => s.key)).toEqual([
      "agent:main:active-sess-0",
      "agent:main:active-sess-1",
    ]);

    // Only 2 transcript files should have been stat'd (not all 4).
    expect(transcriptReadCount).toBe(2);
  });
});
