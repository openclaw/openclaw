import path from "node:path";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import { AgentSelectionRequiredError } from "../../agents/agent-scope-config.js";
import { retainLegacyDefaultAgentId } from "../legacy.default-agent-owner.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import { loadCombinedSessionStoreForGateway } from "./combined-store-gateway.js";
import { replaceSessionEntry } from "./session-accessor.js";
import { persistSessionTranscriptTurn } from "./session-accessor.transcript-turn.js";

function retainedOwnerConfig(storePath: string): OpenClawConfig {
  return retainLegacyDefaultAgentId(
    {
      agents: { ownership: "explicit", entries: { ops: {}, research: {} } },
      session: { store: storePath },
    },
    "ops",
  );
}

describe("retained legacy session ownership", () => {
  it("attributes a fixed-store bare row to the retained owner", async () => {
    await withTempHome(async (home) => {
      const storePath = path.join(home, "sessions.json");
      const cfg = retainedOwnerConfig(storePath);
      await replaceSessionEntry(
        { agentId: "ops", sessionKey: "main", storePath },
        { sessionId: "legacy-fixed-session", updatedAt: 1 },
      );

      expect(loadCombinedSessionStoreForGateway(cfg).store).toHaveProperty("agent:ops:main");
      expect(
        loadCombinedSessionStoreForGateway(cfg, { agentId: "research" }).store,
      ).not.toHaveProperty("agent:research:main");
      expect(loadCombinedSessionStoreForGateway(cfg, { agentId: "ops" }).store).toHaveProperty(
        "agent:ops:main",
      );
    });
  });

  it("resolves retained ownership for guarded and ordinary transcript turns", async () => {
    await withTempHome(async (home) => {
      const storePath = path.join(home, "sessions.json");
      const cfg = retainedOwnerConfig(storePath);
      const scope = {
        sessionId: "legacy-transcript-session",
        sessionKey: "main",
        storePath,
      };
      await replaceSessionEntry(
        { agentId: "ops", sessionKey: "main", storePath },
        { sessionId: scope.sessionId, updatedAt: 1 },
      );

      await expect(
        persistSessionTranscriptTurn(scope, { config: cfg, messages: [], updateMode: "none" }),
      ).resolves.toMatchObject({ appendedCount: 0 });
      await expect(
        persistSessionTranscriptTurn(scope, {
          config: cfg,
          expectedSessionId: scope.sessionId,
          messages: [],
          updateMode: "none",
        }),
      ).resolves.toMatchObject({ appendedCount: 0 });
      await expect(
        persistSessionTranscriptTurn(
          { ...scope, agentId: "" },
          { config: cfg, messages: [], updateMode: "none" },
        ),
      ).resolves.toMatchObject({ appendedCount: 0 });
    });
  });

  it("resolves persisted fixed-store ownership after restart", async () => {
    await withTempHome(async (home) => {
      const storePath = path.join(home, "sessions.json");
      const cfg = {
        agents: {
          ownership: "explicit",
          defaults: { sessionStore: { agentId: "ops" } },
          entries: { ops: {}, research: {} },
        },
        session: { store: storePath },
      } satisfies OpenClawConfig;
      const scope = {
        sessionId: "persisted-owner-session",
        sessionKey: "main",
        storePath,
      };
      await replaceSessionEntry(
        { agentId: "ops", sessionKey: "main", storePath },
        { sessionId: scope.sessionId, updatedAt: 1 },
      );

      expect(loadCombinedSessionStoreForGateway(cfg).store).toHaveProperty("agent:ops:main");
      await expect(
        persistSessionTranscriptTurn(scope, { config: cfg, messages: [], updateMode: "none" }),
      ).resolves.toMatchObject({ appendedCount: 0 });
      await expect(
        persistSessionTranscriptTurn(scope, {
          config: cfg,
          expectedSessionId: scope.sessionId,
          messages: [],
          updateMode: "none",
        }),
      ).resolves.toMatchObject({ appendedCount: 0 });
    });
  });

  it("requires an owner for bare transcript turns in an explicit per-agent store", async () => {
    const cfg = {
      agents: {
        ownership: "explicit",
        entries: { ops: {}, research: {} },
      },
      session: { store: "/tmp/openclaw/{agentId}/sessions.json" },
    } satisfies OpenClawConfig;
    const scope = {
      sessionId: "ownerless-template-session",
      sessionKey: "main",
      storePath: "/tmp/openclaw/ops/sessions.json",
    };

    await expect(
      persistSessionTranscriptTurn(scope, { config: cfg, messages: [], updateMode: "none" }),
    ).rejects.toBeInstanceOf(AgentSelectionRequiredError);
    await expect(
      persistSessionTranscriptTurn(scope, {
        config: cfg,
        expectedSessionId: scope.sessionId,
        messages: [],
        updateMode: "none",
      }),
    ).rejects.toBeInstanceOf(AgentSelectionRequiredError);
  });

  it("requires an owner for bare transcript turns in an explicit fixed store", async () => {
    const cfg = {
      agents: { ownership: "explicit", entries: { ops: {}, research: {} } },
      session: { store: "/tmp/openclaw/shared-sessions.json" },
    } satisfies OpenClawConfig;
    const scope = {
      sessionId: "ownerless-fixed-session",
      sessionKey: "main",
      storePath: "/tmp/openclaw/shared-sessions.json",
    };

    await expect(
      persistSessionTranscriptTurn(scope, { config: cfg, messages: [], updateMode: "none" }),
    ).rejects.toBeInstanceOf(AgentSelectionRequiredError);
    await expect(
      persistSessionTranscriptTurn(scope, {
        config: cfg,
        expectedSessionId: scope.sessionId,
        messages: [],
        updateMode: "none",
      }),
    ).rejects.toBeInstanceOf(AgentSelectionRequiredError);
  });
});
