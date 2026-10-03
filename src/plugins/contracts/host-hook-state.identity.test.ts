import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolvePromptBuildHookResult } from "../../agents/embedded-agent-runner/run/attempt-prompt-helpers.js";
import {
  loadSessionEntryReadOnly,
  replaceSessionEntry,
  resolveSessionEntryAccessTarget,
} from "../../config/sessions/session-accessor.entry.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import {
  drainPluginNextTurnInjectionContext,
  enqueuePluginNextTurnInjection,
} from "../host-hook-state.js";
import { createEmptyPluginRegistry } from "../registry-empty.js";
import { clearActivePluginRegistry, setActivePluginRegistry } from "../runtime.js";
import { createPluginRecord } from "../status.test-helpers.js";

describe("next-turn injection identity", () => {
  let state: OpenClawTestState;
  beforeEach(async () => {
    state = await createOpenClawTestState({ prefix: "host-hook-identity-" });
    const registry = createEmptyPluginRegistry();
    registry.plugins.push(createPluginRecord({ id: "owner-fixture", status: "loaded" }));
    setActivePluginRegistry(registry);
  });
  afterEach(async () => {
    await clearActivePluginRegistry();
    await state.cleanup();
  });

  it.each(["absent", "empty"] as const)(
    "builds ordinary prompts when the selected queue is %s beside a populated colliding row",
    async (queue) => {
      const cfg: OpenClawConfig = {
        session: { store: state.path("{agentId}", "sessions.json"), scope: "global" },
        agents: { entries: { qa: {} } },
      };
      const raw = {
        agentId: "qa",
        storePath: state.path("qa", "sessions.json"),
        sessionKey: "global",
      };
      const literal = { ...raw, sessionKey: "agent:qa:global" };
      await replaceSessionEntry(raw, {
        sessionId: "raw-owner",
        updatedAt: 1,
        ...(queue === "empty" ? { pluginNextTurnInjections: {} } : {}),
      });
      await replaceSessionEntry(literal, { sessionId: "literal-owner", updatedAt: 1 });
      await enqueuePluginNextTurnInjection({
        cfg,
        pluginId: "owner-fixture",
        injection: { sessionKey: literal.sessionKey, agentId: "qa", text: "literal queue" },
      });
      const before = [raw, literal].map((scope) => loadSessionEntryReadOnly(scope));

      await expect(
        resolvePromptBuildHookResult({
          config: cfg,
          prompt: "Hello",
          messages: [],
          hookCtx: { agentId: "qa", sessionKey: "global" },
        }),
      ).resolves.toMatchObject({ prependContext: undefined, appendContext: undefined });

      expect([raw, literal].map((scope) => loadSessionEntryReadOnly(scope))).toEqual(before);
    },
  );

  it.each([false, true])(
    "preserves the recorded shared-store owner's queue when retired=%s",
    async (retired) => {
      const shared = state.path("shared.sqlite");
      const activeCfg: OpenClawConfig = {
        session: { store: shared, scope: "global" },
        agents: {
          entries: { work: { default: true }, ops: {}, storage: {} },
          defaults: { sessionStore: { agentId: "ops" } },
        },
      };
      const physical = (sessionKey: string) => ({
        agentId: "ops",
        defaultAgentId: "storage",
        storePath: shared,
        sessionKey,
      });
      for (const sessionKey of ["global", "unknown"]) {
        await replaceSessionEntry(physical(sessionKey), {
          sessionId: `ops-${sessionKey}`,
          updatedAt: 1,
        });
        await enqueuePluginNextTurnInjection({
          cfg: activeCfg,
          pluginId: "owner-fixture",
          injection: { sessionKey, agentId: "ops", text: `ops ${sessionKey}` },
        });
      }
      const selected = resolveSessionEntryAccessTarget(
        { cfg: activeCfg, sessionKey: "global" },
        { keyFormat: "agent-qualified" },
      );
      expect(selected).toMatchObject({
        agentId: "ops",
        canonicalKey: "agent:ops:global",
        storeKey: "global",
        readSource: { agentId: "storage", path: shared },
      });
      const before = ["global", "unknown"].map((key) => loadSessionEntryReadOnly(physical(key)));
      const cfg: OpenClawConfig = retired
        ? {
            ...activeCfg,
            agents: {
              ...activeCfg.agents,
              entries: { work: { default: true }, storage: {} },
            },
          }
        : activeCfg;
      for (const request of [
        { sessionKey: "global", agentId: "work" },
        { sessionKey: "unknown", agentId: "work" },
        { sessionKey: "main", agentId: "work" },
        { sessionKey: "agent:work:main", agentId: "work" },
        { sessionKey: "agent:work:main" },
      ]) {
        await expect(drainPluginNextTurnInjectionContext({ cfg, ...request })).rejects.toThrow(
          retired ? 'belongs to retired agent "ops"' : 'belongs to "ops", not "work"',
        );
      }
      expect(["global", "unknown"].map((key) => loadSessionEntryReadOnly(physical(key)))).toEqual(
        before,
      );
      await expect(
        drainPluginNextTurnInjectionContext({ cfg: activeCfg, sessionKey: "global" }),
      ).resolves.toMatchObject({ prependContext: "ops global" });
      expect(
        loadSessionEntryReadOnly(physical("global"))?.pluginNextTurnInjections,
      ).toBeUndefined();
      expect(loadSessionEntryReadOnly(physical("unknown"))).toEqual(before[1]);
      expect(
        loadSessionEntryReadOnly({ ...physical("agent:work:global"), agentId: "work" }),
      ).toBeUndefined();
    },
  );

  it.each([false, true])(
    "drains the original raw owner without rewriting it when collision=%s",
    async (collision) => {
      const cfg: OpenClawConfig = {
        session: { store: state.path("{agentId}", "sessions.json"), scope: "global" },
        agents: { entries: { qa: {}, beta: {} } },
      };
      const scope = (agentId: string) => ({
        agentId,
        storePath: state.path(agentId, "sessions.json"),
        sessionKey: "global",
      });
      for (const agentId of ["qa", "beta"]) {
        await replaceSessionEntry(scope(agentId), { sessionId: agentId, updatedAt: 1 });
        await enqueuePluginNextTurnInjection({
          cfg,
          pluginId: "owner-fixture",
          injection: { sessionKey: "global", agentId, text: agentId },
        });
      }
      const qaBefore = loadSessionEntryReadOnly(scope("qa"));
      const betaBefore = loadSessionEntryReadOnly(scope("beta"));
      const literal = { ...scope("qa"), sessionKey: "agent:qa:global" };
      if (collision) {
        await replaceSessionEntry(literal, { sessionId: "separate-literal", updatedAt: 1 });
      }
      const drain = drainPluginNextTurnInjectionContext({
        cfg,
        agentId: "qa",
        sessionKey: "global",
      });
      if (collision) {
        await expect(drain).rejects.toThrow("ambiguous stored identity");
        expect(loadSessionEntryReadOnly(scope("qa"))).toEqual(qaBefore);
        expect(loadSessionEntryReadOnly(literal)?.sessionId).toBe("separate-literal");
      } else {
        await expect(drain).resolves.toMatchObject({ prependContext: "qa" });
        expect(loadSessionEntryReadOnly(scope("qa"))?.pluginNextTurnInjections).toBeUndefined();
        expect(loadSessionEntryReadOnly(literal)).toBeUndefined();
      }
      expect(loadSessionEntryReadOnly(scope("beta"))).toEqual(betaBefore);
    },
  );
});
