// Doctor config analysis tests cover schema analysis, model fallback values, and issue generation.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveConfiguredModelFallbacks } from "../agents/model-selection-resolve.js";
import { retainLegacyDefaultAgentId } from "../config/legacy.default-agent-owner.js";
import {
  createConfigResolutionFacts,
  setConfigResolutionFacts,
} from "../config/resolution-facts.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  noteDoctorHookConfigWarnings,
  noteImplicitFallbackClobberWarnings,
  noteMcpOriginWarning,
  noteMissingDefaultAgentOwner,
  noteOpencodeProviderOverrides,
  noteSandboxOriginProxyWarning,
  stripUnknownConfigKeys,
} from "./doctor-config-analysis.js";

const noteMock = vi.hoisted(() => vi.fn());

vi.mock("../../packages/terminal-core/src/note.js", () => ({ note: noteMock }));

function collectImplicitFallbackClobberWarnings(cfg: unknown): string[] {
  noteMock.mockClear();
  noteImplicitFallbackClobberWarnings(cfg);
  const body = noteMock.mock.calls.at(-1)?.[0];
  return typeof body === "string" ? body.split(/\n(?=- )/) : [];
}

describe("doctor config analysis helpers", () => {
  it.each(["missing", "pending"] as const)(
    "reports %s hook credentials with guidance without exposing or rewriting the token",
    (kind) => {
      noteMock.mockClear();
      const cfg: OpenClawConfig = {
        hooks: { enabled: true, token: "synthetic-private-hook-value" },
      };
      setConfigResolutionFacts(
        cfg,
        createConfigResolutionFacts(
          kind === "missing" ? [{ varName: "MISSING_HOOK_SECRET", configPath: "hooks.token" }] : [],
          kind === "pending" ? new Map([["hooks.token", "PENDING_HOOK_SECRET"]]) : new Map(),
        ),
      );
      noteDoctorHookConfigWarnings(cfg, "/virtual/.openclaw/openclaw.json");
      const message = String(noteMock.mock.calls[0]?.[0]);
      expect(message).toContain("hooks.token has an unresolved environment reference");
      expect(message).toContain("CLI and service environments may differ");
      expect(message).toContain("openclaw config set hooks.enabled false");
      expect(message).not.toContain("synthetic-private-hook-value");
      expect(cfg.hooks?.token).toBe("synthetic-private-hook-value");
    },
  );

  it.each([true, false])("does not warn about literal hook tokens (enabled=%s)", (enabled) => {
    noteMock.mockClear();
    noteDoctorHookConfigWarnings(
      { hooks: { enabled, token: "synthetic-literal-hook-value" } },
      "/virtual/.openclaw/openclaw.json",
    );
    expect(noteMock).not.toHaveBeenCalled();
  });

  it("warns when hooks transformsDir points outside the hook transforms root", () => {
    noteMock.mockClear();
    noteDoctorHookConfigWarnings(
      {
        hooks: {
          enabled: true,
          token: "hook-secret",
          transformsDir: "/virtual/.openclaw/workspace/skills/linear-webhook",
          mappings: [
            {
              match: { path: "linear" },
              action: "agent",
              messageTemplate: "Linear event",
              transform: { module: "./openclaw-linear-transform.js" },
            },
          ],
        },
      },
      "/virtual/.openclaw/openclaw.json",
    );

    expect(noteMock).toHaveBeenCalledExactlyOnceWith(expect.any(String), "Doctor warnings");
    const warning = String(noteMock.mock.calls[0]?.[0]);
    expect(warning).toContain("hooks.transformsDir:");
    expect(warning).toContain("/virtual/.openclaw/workspace/skills/linear-webhook");
    expect(warning).toContain("/virtual/.openclaw/hooks/transforms");
    expect(warning).toContain("move custom transforms there or remove hooks.transformsDir");
  });

  it("requires a durable default designation despite retained migration provenance", () => {
    noteMock.mockClear();
    const cfg = retainLegacyDefaultAgentId(
      {
        agents: { ownership: "explicit", entries: { ops: {}, research: {} } },
      } satisfies OpenClawConfig,
      "ops",
    );

    noteMissingDefaultAgentOwner(cfg);

    expect(noteMock).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("openclaw config set agents.defaults.systemAgent.agentId <id>"),
      "Agent ownership",
    );
  });

  it("classifies external OpenCode overrides only while their plugins are active", () => {
    noteMock.mockClear();

    const cfg: OpenClawConfig = {
      models: {
        providers: {
          opencode: {
            baseUrl: "https://opencode.ai/zen/v1",
            api: "openai-completions",
            models: [],
          },
          "opencode-go": {
            baseUrl: "https://opencode.ai/zen/go/v1",
            api: "openai-completions",
            models: [],
          },
        },
      },
    };

    noteOpencodeProviderOverrides(cfg);
    expect(noteMock).not.toHaveBeenCalled();

    noteOpencodeProviderOverrides(cfg, {
      opencodePluginActive: true,
      opencodeGoPluginActive: true,
    });
    expect(noteMock).toHaveBeenCalledWith(
      expect.stringMatching(
        /plugin-provided OpenCode Zen catalog[\s\S]*plugin-provided OpenCode Go catalog/u,
      ),
      "OpenCode",
    );
  });

  it("strips unknown array-entry fields and reports their indexed paths", () => {
    const result = stripUnknownConfigKeys({
      hooks: { mappings: [{ id: "example", unexpected: true }] },
    } as never);

    expect(result.removed).toEqual(["hooks.mappings[0].unexpected"]);
    expect(result.config).toEqual({ hooks: { mappings: [{ id: "example" }] } });
  });

  it("preserves include syntax at agent defaults while stripping unknown keys", () => {
    const agents = { defaults: { $include: "./agent-defaults.json5" } };
    const result = stripUnknownConfigKeys({ agents, unexpected: true } as never);

    expect(result.removed).toEqual(["unexpected"]);
    expect(result.config).toEqual({ agents });
  });

  describe("stripUnknownConfigKeys during update", () => {
    const originalEnv = process.env.OPENCLAW_UPDATE_IN_PROGRESS;

    beforeEach(() => {
      delete process.env.OPENCLAW_UPDATE_IN_PROGRESS;
    });

    afterEach(() => {
      if (originalEnv !== undefined) {
        process.env.OPENCLAW_UPDATE_IN_PROGRESS = originalEnv;
      } else {
        delete process.env.OPENCLAW_UPDATE_IN_PROGRESS;
      }
    });

    it("returns input unchanged when OPENCLAW_UPDATE_IN_PROGRESS=true", () => {
      process.env.OPENCLAW_UPDATE_IN_PROGRESS = "true";
      const input = { hooks: {}, unexpected: true } as never;
      const result = stripUnknownConfigKeys(input);
      expect(result.config).toBe(input);
      expect(result.removed).toEqual([]);
    });
  });
});

describe("collectImplicitFallbackClobberWarnings", () => {
  it("warns when a canonical agent model suppresses default fallbacks", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: { model: { primary: "openai/gpt-5.5", fallbacks: ["openai/gpt-5.4"] } },
        entries: { ops: { model: { primary: "openai/gpt-5.3" } } },
      },
    };

    expect(resolveConfiguredModelFallbacks({ cfg, agentId: "ops" })).toEqual([]);
    const warnings = collectImplicitFallbackClobberWarnings(cfg);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("agents.entries.ops.model");
    expect(warnings[0]).toContain("leaving the agent with no fallbacks");
    expect(warnings[0]).toContain('add "fallbacks": [...]');
  });

  function buildConfig(overrides: { defaults?: unknown; list?: unknown[] }) {
    return {
      agents: {
        defaults: { model: overrides.defaults },
        list: overrides.list,
      },
    };
  }

  it("returns empty when defaults has no fallbacks", () => {
    const cfg = buildConfig({
      defaults: { primary: "openai/gpt-5.5" },
      list: [{ id: "ops", model: "openai/gpt-5.3" }],
    });
    expect(collectImplicitFallbackClobberWarnings(cfg)).toEqual([]);
  });

  it("returns empty when no per-agent model is configured", () => {
    const cfg = buildConfig({
      defaults: { primary: "openai/gpt-5.5", fallbacks: ["openai/gpt-5.4"] },
      list: [{ id: "ops" }, { id: "researcher" }],
    });
    expect(collectImplicitFallbackClobberWarnings(cfg)).toEqual([]);
  });

  it("returns empty when agents.list is malformed", () => {
    const cfg = {
      agents: {
        defaults: { model: { primary: "openai/gpt-5.5", fallbacks: ["openai/gpt-5.4"] } },
        list: { ops: { id: "ops", model: "openai/gpt-5.3" } },
      },
    };

    expect(collectImplicitFallbackClobberWarnings(cfg)).toEqual([]);
  });

  it("warns for each offending agent independently", () => {
    const cfg = buildConfig({
      defaults: { primary: "openai/gpt-5.5", fallbacks: ["openai/gpt-5.4"] },
      list: [
        { id: "ops", model: "openai/gpt-5.3" },
        { id: "researcher", model: { primary: "openai/gpt-5.4" } },
      ],
    });
    const warnings = collectImplicitFallbackClobberWarnings(cfg);
    expect(warnings).toStrictEqual([
      [
        '- agents.list[0].model (id=ops) is "openai/gpt-5.3", a bare string with no fallbacks. At runtime this clobbers agents.defaults.model.fallbacks (openai/gpt-5.4), leaving the agent with no fallbacks.',
        '  Fix: add "fallbacks": [...] to inherit or override, or "fallbacks": [] to explicitly disable.',
      ].join("\n"),
      [
        '- agents.list[1].model (id=researcher) is { primary: "openai/gpt-5.4" }, a object with no explicit "fallbacks" key. At runtime this clobbers agents.defaults.model.fallbacks (openai/gpt-5.4), leaving the agent with no fallbacks.',
        '  Fix: add "fallbacks": [...] to inherit or override, or "fallbacks": [] to explicitly disable.',
      ].join("\n"),
    ]);
  });
});

describe("noteSandboxOriginProxyWarning", () => {
  function warningsFor(cfg: OpenClawConfig): string[] {
    noteMock.mockClear();
    noteSandboxOriginProxyWarning(cfg);
    return noteMock.mock.calls.map((call) => String(call[0]));
  }

  it("warns for trusted-proxy gateways without a sandbox origin", () => {
    const warnings = warningsFor({
      gateway: { auth: { mode: "trusted-proxy" } },
    } as OpenClawConfig);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("mcp.apps.sandboxOrigin is not set");
    expect(warnings[0]).toContain("sandbox listener");
  });

  it("stays silent when a sandbox origin is configured", () => {
    const warnings = warningsFor({
      gateway: { auth: { mode: "trusted-proxy" } },
      mcp: { apps: { sandboxOrigin: "https://widgets.example.com" } },
    } as OpenClawConfig);
    expect(warnings).toHaveLength(0);
  });
});

describe("noteMcpOriginWarning", () => {
  function warningsFor(cfg: OpenClawConfig): string[] {
    noteMock.mockClear();
    noteMcpOriginWarning(cfg);
    return noteMock.mock.calls.map((call) => String(call[0]));
  }

  it("warns for per-requester MCP OAuth without a public Gateway origin", () => {
    const warnings = warningsFor({
      mcp: {
        servers: {
          docs: {
            url: "https://mcp.example.com",
            auth: "oauth",
            oauth: { identity: "per-requester" },
          },
        },
      },
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("gateway.publicOrigin is not set");
    expect(warnings[0]).toContain("senders can complete MCP sign-in");
  });

  it("stays silent when the public origin is configured", () => {
    expect(
      warningsFor({
        gateway: { publicOrigin: "https://gateway.example.com" },
        mcp: {
          servers: {
            docs: {
              url: "https://mcp.example.com",
              auth: "oauth",
              oauth: { identity: "per-requester" },
            },
          },
        },
      }),
    ).toHaveLength(0);
  });

  it("stays silent for shared or absent MCP OAuth identity", () => {
    expect(
      warningsFor({
        mcp: {
          servers: {
            shared: {
              url: "https://shared.example.com",
              auth: "oauth",
              oauth: { identity: "shared" },
            },
            implicit: { url: "https://implicit.example.com", auth: "oauth" },
          },
        },
      }),
    ).toHaveLength(0);
    expect(warningsFor({})).toHaveLength(0);
  });
});
