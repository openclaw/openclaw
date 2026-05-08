import { describe, expect, it } from "vitest";
import type { SessionEntry } from "../../../config/sessions/types.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import {
  collectCodexRouteWarnings,
  maybeRepairCodexRoutes,
  repairCodexSessionStoreRoutes,
} from "./codex-route-warnings.js";

describe("collectCodexRouteWarnings", () => {
  it("does not warn or rewrite explicit openai-codex provider refs", () => {
    const cfg = {
      agents: {
        defaults: {
          model: "openai-codex/gpt-5.5",
          agentRuntime: { id: "pi" },
        },
        list: [
          {
            id: "worker",
            model: "openai-codex/gpt-5.5",
            agentRuntime: { id: "codex" },
          },
        ],
      },
    } as OpenClawConfig;

    expect(collectCodexRouteWarnings({ cfg })).toEqual([]);

    const result = maybeRepairCodexRoutes({ cfg, shouldRepair: true });

    expect(result).toEqual({ cfg, warnings: [], changes: [] });
  });

  it("warns when generic OpenAI refs are paired with the Codex runtime", () => {
    const warnings = collectCodexRouteWarnings({
      cfg: {
        agents: {
          defaults: {
            model: "openai/gpt-5.5",
            agentRuntime: { id: "codex" },
          },
        },
      } as OpenClawConfig,
    });

    expect(warnings).toEqual([expect.stringContaining("Generic `openai/*`")]);
    expect(warnings[0]).toContain("agents.defaults.model");
    expect(warnings[0]).toContain("openai-codex/gpt-5.5");
    expect(warnings[0]).toContain('runtime "codex"');
  });

  it("does not warn for generic OpenAI refs on the default runtime", () => {
    const warnings = collectCodexRouteWarnings({
      cfg: {
        agents: {
          defaults: {
            model: "openai/gpt-5.5",
          },
        },
      } as OpenClawConfig,
    });

    expect(warnings).toEqual([]);
  });

  it("repairs only risky Codex-runtime OpenAI refs to openai-codex refs", () => {
    const result = maybeRepairCodexRoutes({
      cfg: {
        agents: {
          defaults: {
            model: "openai/gpt-5.5",
            agentRuntime: { id: "codex" },
          },
          list: [
            {
              id: "pi-worker",
              model: "openai/gpt-5.4",
              agentRuntime: { id: "pi" },
            },
            {
              id: "codex-worker",
              model: {
                primary: "openai/gpt-5.5",
                fallbacks: ["openai/gpt-5.4", "anthropic/claude-sonnet-4-6"],
              },
              agentRuntime: { id: "codex" },
            },
          ],
        },
      } as OpenClawConfig,
      shouldRepair: true,
    });

    expect(result.warnings).toEqual([]);
    expect(result.changes).toEqual([expect.stringContaining("Repaired Codex model routes")]);
    expect(result.cfg.agents?.defaults?.model).toBe("openai-codex/gpt-5.5");
    expect(result.cfg.agents?.defaults?.agentRuntime).toEqual({ id: "codex" });
    expect(result.cfg.agents?.list?.[0]).toMatchObject({
      id: "pi-worker",
      model: "openai/gpt-5.4",
      agentRuntime: { id: "pi" },
    });
    expect(result.cfg.agents?.list?.[1]?.model).toEqual({
      primary: "openai-codex/gpt-5.5",
      fallbacks: ["openai/gpt-5.4", "anthropic/claude-sonnet-4-6"],
    });
  });

  it("preserves persisted openai-codex session routes and runtime pins", () => {
    const store: Record<string, SessionEntry> = {
      main: {
        sessionId: "s1",
        updatedAt: 1,
        modelProvider: "openai-codex",
        model: "gpt-5.5",
        providerOverride: "openai-codex",
        modelOverride: "openai-codex/gpt-5.4",
        agentRuntimeOverride: "codex",
        authProfileOverride: "openai-codex:default",
      },
    };

    const result = repairCodexSessionStoreRoutes({ store, now: 123 });

    expect(result).toEqual({ changed: false, sessionKeys: [] });
    expect(store.main).toMatchObject({
      updatedAt: 1,
      modelProvider: "openai-codex",
      providerOverride: "openai-codex",
      modelOverride: "openai-codex/gpt-5.4",
      agentRuntimeOverride: "codex",
      authProfileOverride: "openai-codex:default",
    });
  });

  it("repairs persisted OpenAI session routes only when Codex runtime is pinned", () => {
    const store: Record<string, SessionEntry> = {
      codex: {
        sessionId: "s1",
        updatedAt: 1,
        modelProvider: "openai",
        model: "gpt-5.5",
        providerOverride: "openai",
        modelOverride: "openai/gpt-5.4",
        agentRuntimeOverride: "codex",
        authProfileOverride: "openai-codex:default",
      },
      pi: {
        sessionId: "s2",
        updatedAt: 2,
        modelProvider: "openai",
        model: "gpt-5.5",
        agentRuntimeOverride: "pi",
      },
    };

    const result = repairCodexSessionStoreRoutes({ store, now: 123 });

    expect(result).toEqual({ changed: true, sessionKeys: ["codex"] });
    expect(store.codex).toMatchObject({
      updatedAt: 123,
      modelProvider: "openai-codex",
      model: "gpt-5.5",
      providerOverride: "openai-codex",
      modelOverride: "gpt-5.4",
      agentRuntimeOverride: "codex",
      authProfileOverride: "openai-codex:default",
    });
    expect(store.pi).toMatchObject({
      updatedAt: 2,
      modelProvider: "openai",
      agentRuntimeOverride: "pi",
    });
  });
});
