import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveConfiguredModelFallbacks } from "../agents/model-selection-resolve.js";
import { retainLegacyDefaultAgentId } from "../config/legacy.default-agent-owner.js";
import {
  createConfigResolutionFacts,
  setConfigResolutionFacts,
} from "../config/resolution-facts.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withEnv } from "../test-utils/env.js";
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
beforeEach(() => noteMock.mockClear());

function expectContains(message: unknown, fragments: string[]) {
  for (const fragment of fragments) {
    expect(message).toContain(fragment);
  }
}

function collectWarnings(run: () => void): string[] {
  run();
  return noteMock.mock.calls.map(([message]) => String(message));
}

function collectImplicitFallbackClobberWarnings(cfg: unknown): string[] {
  return collectWarnings(() => noteImplicitFallbackClobberWarnings(cfg)).flatMap((body) =>
    body.split(/\n(?=- )/),
  );
}

describe("doctor config analysis helpers", () => {
  it.each(["missing", "pending"] as const)(
    "reports %s hook credentials with guidance without exposing or rewriting the token",
    (kind) => {
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
      expectContains(message, [
        "hooks.token has an unresolved environment reference",
        "CLI and service environments may differ",
        "openclaw config set hooks.enabled false",
      ]);
      expect(message).not.toContain("synthetic-private-hook-value");
      expect(cfg.hooks?.token).toBe("synthetic-private-hook-value");
    },
  );

  it.each([true, false])("does not warn about literal hook tokens (enabled=%s)", (enabled) => {
    noteDoctorHookConfigWarnings(
      { hooks: { enabled, token: "synthetic-literal-hook-value" } },
      "/virtual/.openclaw/openclaw.json",
    );
    expect(noteMock).not.toHaveBeenCalled();
  });

  it("warns when hooks transformsDir points outside the hook transforms root", () => {
    const transformsDir = "/virtual/.openclaw/workspace/skills/linear-webhook";
    noteDoctorHookConfigWarnings(
      { hooks: { enabled: true, token: "hook-secret", transformsDir } },
      "/virtual/.openclaw/openclaw.json",
    );

    expect(noteMock).toHaveBeenCalledExactlyOnceWith(expect.any(String), "Doctor warnings");
    expectContains(noteMock.mock.calls[0]?.[0], [
      "hooks.transformsDir:",
      transformsDir,
      "/virtual/.openclaw/hooks/transforms",
      "move custom transforms there or remove hooks.transformsDir",
    ]);
  });

  it("requires a durable default designation despite retained migration provenance", () => {
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
    const provider = {
      baseUrl: "https://opencode.ai/zen/v1",
      api: "openai-completions" as const,
      models: [],
    };
    const cfg: OpenClawConfig = {
      models: { providers: { opencode: provider, "opencode-go": provider } },
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

  it.each([
    [
      { hooks: { mappings: [{ id: "example", unexpected: true }] } },
      { hooks: { mappings: [{ id: "example" }] } },
      "hooks.mappings[0].unexpected",
    ],
    [
      { agents: { defaults: { $include: "./agent-defaults.json5" } }, unexpected: true },
      { agents: { defaults: { $include: "./agent-defaults.json5" } } },
      "unexpected",
    ],
  ])("strips unknown keys but preserves include syntax in %j", (input, config, removed) => {
    expect(stripUnknownConfigKeys(input as never)).toEqual({ config, removed: [removed] });
  });

  it.each([undefined, "1"])(
    "cleans unowned keys during updates (post-core=%s), preserving deferred inputs",
    (postCore) => {
      withEnv(
        {
          OPENCLAW_UPDATE_IN_PROGRESS: "true",
          OPENCLAW_UPDATE_POST_CORE_CONVERGENCE: postCore,
        },
        () => {
          const input = { hooks: {}, deferred: { setting: true }, unexpected: true };
          const result = stripUnknownConfigKeys(input, [["deferred", "setting"]]);
          expect(result.config).toEqual({ hooks: {}, deferred: { setting: true } });
          expect(result.removed).toEqual(["unexpected"]);
          expect(input.unexpected).toBe(true);
        },
      );
    },
  );
});

describe("collectImplicitFallbackClobberWarnings", () => {
  const defaults = { primary: "openai/gpt-5.5", fallbacks: ["openai/gpt-5.4"] };
  const listConfig = (list: unknown, model: unknown = defaults) => ({
    agents: { defaults: { model }, list },
  });
  it("warns when a canonical agent model suppresses default fallbacks", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: { model: defaults },
        entries: { ops: { model: { primary: "openai/gpt-5.3" } } },
      },
    };

    expect(resolveConfiguredModelFallbacks({ cfg, agentId: "ops" })).toEqual([]);
    const warnings = collectImplicitFallbackClobberWarnings(cfg);
    expect(warnings).toHaveLength(1);
    expectContains(warnings[0], [
      "agents.entries.ops.model",
      "leaving the agent with no fallbacks",
      'add "fallbacks": [...]',
    ]);
  });

  it.each([
    [
      "defaults has no fallbacks",
      { primary: "openai/gpt-5.5" },
      [{ id: "ops", model: "openai/gpt-5.3" }],
    ],
    ["no per-agent model is configured", defaults, [{ id: "ops" }, { id: "researcher" }]],
    ["agents.list is malformed", defaults, { ops: { id: "ops", model: "openai/gpt-5.3" } }],
  ])("returns empty when %s", (_name, model, list) => {
    expect(collectImplicitFallbackClobberWarnings(listConfig(list, model))).toEqual([]);
  });

  it("warns for each offending agent independently", () => {
    const warnings = collectImplicitFallbackClobberWarnings(
      listConfig([
        { id: "ops", model: "openai/gpt-5.3" },
        { id: "researcher", model: { primary: "openai/gpt-5.4" } },
      ]),
    );
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

describe("origin warnings", () => {
  const server = (identity?: "shared" | "per-requester") => ({
    url: "https://mcp.example.com",
    auth: "oauth" as const,
    ...(identity ? { oauth: { identity } } : {}),
  });
  const mcp = { servers: { docs: server("per-requester") } };
  it.each<[(cfg: OpenClawConfig) => void, OpenClawConfig, string[]]>([
    [
      noteSandboxOriginProxyWarning,
      { gateway: { auth: { mode: "trusted-proxy" } } },
      ["mcp.apps.sandboxOrigin is not set", "sandbox listener"],
    ],
    [
      noteSandboxOriginProxyWarning,
      {
        gateway: { auth: { mode: "trusted-proxy" } },
        mcp: { apps: { sandboxOrigin: "https://widgets.example.com" } },
      },
      [],
    ],
    [
      noteMcpOriginWarning,
      { mcp },
      ["gateway.publicOrigin is not set", "senders can complete MCP sign-in"],
    ],
    [noteMcpOriginWarning, { mcp, gateway: { publicOrigin: "https://gateway.example.com" } }, []],
    [
      noteMcpOriginWarning,
      { mcp: { servers: { shared: server("shared"), implicit: server() } } },
      [],
    ],
    [noteMcpOriginWarning, {}, []],
  ])("%s for %j", (warn, cfg, fragments) => {
    const warnings = collectWarnings(() => warn(cfg));
    expect(warnings).toHaveLength(fragments.length ? 1 : 0);
    expectContains(warnings[0], fragments);
  });
});
