import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTempDir } from "../../test-helpers/temp-dir.js";
import {
  canUseCombinedSessionStoreWindowForGateway,
  loadCombinedSessionStoreForGatewayAsync,
  loadCombinedSessionStoreWindowForGatewayAsync,
  resolveCombinedSessionStoreWindowDecisionForGateway,
} from "./combined-store-gateway.js";
import type { SessionEntry } from "./types.js";

async function writeStore(storePath: string, store: Record<string, SessionEntry>): Promise<void> {
  await fs.mkdir(path.dirname(storePath), { recursive: true });
  await fs.writeFile(storePath, JSON.stringify(store), "utf8");
}

describe("loadCombinedSessionStoreForGatewayAsync", () => {
  it("loads the default JSON adapter and canonicalizes agent session keys", async () => {
    await withTempDir({ prefix: "openclaw-combined-store-async-" }, async (dir) => {
      const storePath = path.join(dir, "sessions.json");
      const store: Record<string, SessionEntry> = {
        main: { sessionId: "session-main", updatedAt: 10, sessionStartedAt: 1 },
      };
      await writeStore(storePath, store);

      await expect(
        loadCombinedSessionStoreForGatewayAsync({ session: { store: storePath } }),
      ).resolves.toMatchObject({
        storePath,
        store: {
          "agent:main:main": { sessionId: "session-main", updatedAt: 10 },
        },
      });
    });
  });

  it("loads a bounded sessions.list window through the async list adapter", async () => {
    await withTempDir({ prefix: "openclaw-combined-store-window-" }, async (dir) => {
      const storePath = path.join(dir, "sessions.json");
      const store: Record<string, SessionEntry> = {
        global: { sessionId: "session-global", updatedAt: 100 },
        newer: { sessionId: "session-newer", updatedAt: 30, sessionStartedAt: 1, label: "focus" },
        middle: {
          sessionId: "session-middle",
          updatedAt: 20,
          sessionStartedAt: 2,
          label: "focus",
        },
        older: { sessionId: "session-older", updatedAt: 10, sessionStartedAt: 3, label: "backlog" },
        unknown: { sessionId: "session-unknown", updatedAt: 5 },
      };
      await writeStore(storePath, store);

      await expect(
        loadCombinedSessionStoreWindowForGatewayAsync(
          { session: { store: storePath } },
          { limit: 2, label: "focus", updatedAfter: 15 },
        ),
      ).resolves.toMatchObject({
        storePath,
        totalCount: 2,
        limitApplied: 2,
        offset: 0,
        hasMore: false,
        store: {
          "agent:main:newer": { sessionId: "session-newer", updatedAt: 30 },
          "agent:main:middle": { sessionId: "session-middle", updatedAt: 20 },
        },
      });
    });
  });

  it("bounds agent-scoped windows by selecting the requested agent store before listing", async () => {
    await withTempDir({ prefix: "openclaw-combined-store-agent-window-" }, async (dir) => {
      const storeTemplate = path.join(dir, "agents", "{agentId}", "sessions", "sessions.json");
      await writeStore(path.join(dir, "agents", "main", "sessions", "sessions.json"), {
        main: { sessionId: "main-session", updatedAt: 100 },
      });
      await writeStore(path.join(dir, "agents", "work", "sessions", "sessions.json"), {
        newest: { sessionId: "work-newest", updatedAt: 300 },
        older: { sessionId: "work-older", updatedAt: 200 },
      });

      await expect(
        loadCombinedSessionStoreWindowForGatewayAsync(
          {
            session: { store: storeTemplate },
            agents: { list: [{ id: "main", default: true }, { id: "work" }] },
          },
          { agentId: "work", limit: 1 },
        ),
      ).resolves.toMatchObject({
        totalCount: 2,
        limitApplied: 1,
        nextOffset: 1,
        hasMore: true,
        store: {
          "agent:work:newest": { sessionId: "work-newest", updatedAt: 300 },
        },
      });
    });
  });

  it("bounds configured-agent windows without discovering retired stores", async () => {
    await withTempDir({ prefix: "openclaw-combined-store-configured-window-" }, async (dir) => {
      const storeTemplate = path.join(dir, "agents", "{agentId}", "sessions", "sessions.json");
      await writeStore(path.join(dir, "agents", "main", "sessions", "sessions.json"), {
        main: { sessionId: "main-session", updatedAt: 100 },
      });
      await writeStore(path.join(dir, "agents", "work", "sessions", "sessions.json"), {
        work: { sessionId: "work-session", updatedAt: 300 },
      });
      await writeStore(path.join(dir, "agents", "retired", "sessions", "sessions.json"), {
        retired: { sessionId: "retired-session", updatedAt: 500 },
      });

      await expect(
        loadCombinedSessionStoreWindowForGatewayAsync(
          {
            session: { store: storeTemplate },
            agents: { list: [{ id: "main", default: true }, { id: "work" }] },
          },
          { configuredAgentsOnly: true, limit: 10 },
        ),
      ).resolves.toMatchObject({
        totalCount: 2,
        hasMore: false,
        store: {
          "agent:work:work": { sessionId: "work-session", updatedAt: 300 },
          "agent:main:main": { sessionId: "main-session", updatedAt: 100 },
        },
      });
    });
  });

  it("only enables bounded agent/configured windows when stores can be selected before reads", () => {
    const sharedStoreCfg = {
      session: { store: "/tmp/shared-sessions.json" },
      agents: { list: [{ id: "main", default: true }, { id: "work" }] },
    };
    const templatedCfg = {
      session: { store: "/tmp/agents/{agentId}/sessions/sessions.json" },
      agents: { list: [{ id: "main", default: true }, { id: "work" }] },
    };

    expect(canUseCombinedSessionStoreWindowForGateway(sharedStoreCfg, { agentId: "work" })).toBe(
      false,
    );
    expect(
      canUseCombinedSessionStoreWindowForGateway(sharedStoreCfg, { configuredAgentsOnly: true }),
    ).toBe(false);
    expect(canUseCombinedSessionStoreWindowForGateway(templatedCfg, { agentId: "work" })).toBe(
      true,
    );
    expect(
      canUseCombinedSessionStoreWindowForGateway(templatedCfg, {
        configuredAgentsOnly: true,
      }),
    ).toBe(true);
    expect(canUseCombinedSessionStoreWindowForGateway(templatedCfg, { search: "abc" })).toBe(false);
    expect(
      resolveCombinedSessionStoreWindowDecisionForGateway(templatedCfg, {
        spawnedBy: "agent:main:parent",
      }),
    ).toEqual({ allowed: false, reason: "spawnedBy_runtime_context_required" });
    expect(
      resolveCombinedSessionStoreWindowDecisionForGateway(templatedCfg, { search: "abc" }),
    ).toEqual({ allowed: false, reason: "search_runtime_context_required" });
    expect(
      resolveCombinedSessionStoreWindowDecisionForGateway(sharedStoreCfg, { agentId: "work" }),
    ).toEqual({ allowed: false, reason: "shared_store_agent_filter_requires_full_store" });
    expect(
      resolveCombinedSessionStoreWindowDecisionForGateway(sharedStoreCfg, {
        configuredAgentsOnly: true,
      }),
    ).toEqual({
      allowed: false,
      reason: "shared_store_configured_filter_requires_full_store",
    });
    expect(resolveCombinedSessionStoreWindowDecisionForGateway(templatedCfg)).toEqual({
      allowed: true,
    });
  });
});
