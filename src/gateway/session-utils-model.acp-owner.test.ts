// Session model projection consumes prepared ACP metadata without reading storage.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearAgentHarnesses,
  listRegisteredAgentHarnesses,
  registerAgentHarness,
} from "../agents/harness/registry.js";
import { restoreRegisteredAgentHarnesses } from "../agents/harness/registry.test-support.js";
import * as thinking from "../auto-reply/thinking.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  resolveGatewayModelThinkingProfile,
  resolveGatewaySessionThinkingProjectionInternal,
} from "./session-utils-model.js";

describe("resolveGatewaySessionThinkingProjectionInternal", () => {
  const registeredHarnesses = listRegisteredAgentHarnesses();
  beforeEach(() => {
    clearAgentHarnesses();
  });
  afterAll(() => restoreRegisteredAgentHarnesses(registeredHarnesses));

  it.each([
    { api: true, baseUrl: true, levels: ["Off", "High"] },
    { api: false, baseUrl: true, levels: ["Off"] },
    { api: true, baseUrl: false, levels: ["Off"] },
  ])("uses catalog-only runtime route facts (api=$api, baseUrl=$baseUrl)", (scenario) => {
    const api = "openai-responses" as const;
    const baseUrl = "https://catalog-route.example.test/v1";
    registerAgentHarness({
      id: "catalog-route",
      label: "Catalog route",
      supports: ({ modelProvider }) =>
        modelProvider?.api === api && modelProvider.baseUrl === baseUrl
          ? { supported: true }
          : { supported: false, fallbackRuntime: "openclaw" },
      runAttempt: async () => {
        throw new Error("projection must not execute");
      },
    });
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          thinkingDefault: "off",
          models: { "route-provider/route-model": { agentRuntime: { id: "catalog-route" } } },
        },
      },
    };
    const profile = vi.spyOn(thinking, "resolveThinkingProfile").mockImplementation((params) => ({
      levels: [
        { id: "off", label: "Off", rank: 0 },
        ...(params.agentRuntime === "catalog-route"
          ? [{ id: "high" as const, label: "High", rank: 3 }]
          : []),
      ],
      defaultLevel: "off",
    }));
    const params = {
      cfg,
      agentId: "main",
      provider: "route-provider",
      model: "route-model",
      sessionKey: "agent:main:catalog-route",
      modelCatalog: [
        {
          provider: "route-provider",
          id: "route-model",
          name: "Route model",
          reasoning: true,
          ...(scenario.api ? { api } : {}),
          ...(scenario.baseUrl ? { baseUrl } : {}),
        },
      ],
    };
    try {
      expect(
        resolveGatewayModelThinkingProfile(params).thinkingLevels.map(({ label }) => label),
      ).toEqual(scenario.levels);
      expect(
        resolveGatewaySessionThinkingProjectionInternal({
          ...params,
          entry: { sessionId: "catalog-route", updatedAt: 1 },
        }).thinkingOptions,
      ).toEqual(scenario.levels);
    } finally {
      profile.mockRestore();
    }
  });

  it.each([false, true])(
    "projects the effective model runtime with authored transport=%s",
    (transportOverride) => {
      registerAgentHarness({
        id: "codex",
        label: "Codex",
        supports: (ctx) =>
          ctx.modelProvider?.requestTransportOverrides === "present"
            ? { supported: false, fallbackRuntime: "openclaw" }
            : { supported: true },
        runAttempt: async () => {
          throw new Error("projection must not execute");
        },
      });
      const cfg: OpenClawConfig = {
        agents: {
          defaults: { models: { "openai/gpt-5.6-sol": { agentRuntime: { id: "codex" } } } },
        },
        models: {
          providers: {
            openai: {
              baseUrl: "https://api.openai.com/v1",
              api: "openai-responses",
              models: [
                {
                  id: "gpt-5.6-sol",
                  name: "Sol",
                  reasoning: true,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  maxTokens: 8192,
                  compat: {
                    supportsReasoningEffort: true,
                    supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
                    ...(transportOverride ? { supportsStore: false } : {}),
                  },
                },
              ],
            },
          },
        },
      };
      const projection = resolveGatewaySessionThinkingProjectionInternal({
        cfg,
        agentId: "main",
        provider: "openai",
        model: "gpt-5.6-sol",
        sessionKey: "agent:main:main",
        entry: {
          sessionId: "runtime-projection",
          updatedAt: 1,
          agentHarnessId: transportOverride ? "codex" : "openclaw",
        },
      });
      expect(projection.agentRuntime).toEqual({
        id: transportOverride ? "openclaw" : "codex",
        source: "model",
      });
    },
  );

  it("projects the prepared ACP runtime for a bare key under its resolved owner", () => {
    const cfg: OpenClawConfig = {
      session: { scope: "global", store: "/tmp/shared.sqlite" },
      agents: {
        ownership: "explicit",
        defaults: { sessionStore: { agentId: "ops" } },
        entries: { ops: {}, research: {} },
      },
    };

    const projection = resolveGatewaySessionThinkingProjectionInternal({
      cfg,
      agentId: "ops",
      provider: "openai",
      model: "gpt-5.6-sol",
      sessionKey: "global",
      preparedAcpMeta: {
        backend: "acpx",
        agent: "ops",
        runtimeSessionName: "global",
        mode: "persistent",
        state: "idle",
        lastActivityAt: 1,
      },
    });

    expect(projection.agentRuntime).toEqual({ id: "acpx", source: "session-key" });
  });

  it("does not infer an ACP runtime from the session key without prepared metadata", () => {
    const cfg: OpenClawConfig = {
      agents: {
        entries: { ops: {} },
        defaults: { models: { "openai/gpt-5.6-sol": { agentRuntime: { id: "openclaw" } } } },
      },
    };
    const entry = { sessionId: "original", lifecycleRevision: "original-revision", updatedAt: 1 };
    const sessionKey = "agent:ops:acp:owned";

    const projection = resolveGatewaySessionThinkingProjectionInternal({
      cfg,
      agentId: "ops",
      provider: "openai",
      model: "gpt-5.6-sol",
      sessionKey,
      entry,
      preparedAcpMeta: null,
    });

    expect(projection.agentRuntime.id).toBe("openclaw");
  });
});
