// Control UI tests cover agents utils behavior.
import { describe, expect, it } from "vitest";
import { AVATAR_MAX_DATA_URL_CHARS } from "../../../../src/shared/avatar-limits.js";
import {
  assistantAvatarFallbackUrl,
  isRenderableControlUiAvatarUrl,
  resolveAgentAvatarUrl,
  resolveAssistantTextAvatar,
  resolveChatAvatarRenderUrl,
} from "../avatar.ts";
import {
  buildAgentContext,
  buildModelOptions,
  createPrimaryModelExclusion,
  formatAgentRuntimeLabel,
  formatBytes,
  listSelectableAgents,
  normalizeAgentLabel,
  normalizeAgentTargetLabel,
  resolveAgentSkillsFilter,
  resolveEffectiveModelFallbacks,
} from "./display.ts";

describe("buildModelOptions", () => {
  it("keeps known unavailable choices visible but disabled", () => {
    const config = { agents: { defaults: { models: { "fixture/blocked": {} } } } };
    const options = buildModelOptions(config, "fixture/blocked", [
      { provider: "fixture", id: "blocked", name: "Blocked model", available: false },
      { provider: "fixture", id: "ready", name: "Ready model", available: true },
      { provider: "fixture", id: "unknown", name: "Unknown model" },
    ]);

    expect(options).toContainEqual(
      expect.objectContaining({ value: "fixture/blocked", disabled: true }),
    );
    expect(options.find((option) => option.value === "fixture/ready")?.disabled).not.toBe(true);
    expect(options.find((option) => option.value === "fixture/unknown")?.disabled).not.toBe(true);
  });

  const model = "openai/gpt-5.6-luna";
  const catalog = [
    {
      id: "gpt-5.6-luna",
      name: "GPT 5.6 Luna",
      provider: "openai",
      alias: "gateway-alias",
      tags: ["default", "configured"],
    },
  ];

  it.each([
    {
      name: "inherits the default alias when agent metadata omits alias",
      agentMetadata: { agentRuntime: { id: "codex" } },
      label: "GPT 5.6 Luna · global-luna",
    },
    {
      name: "lets an explicit empty agent alias disable the inherited alias",
      agentMetadata: { alias: "" },
      label: "GPT 5.6 Luna",
    },
  ])("$name", ({ agentMetadata, label }) => {
    const config = {
      agents: {
        defaults: { models: { [model]: { alias: "global-luna" } } },
        entries: { worker: { models: { [model]: agentMetadata } } },
      },
    };

    expect(buildModelOptions(config, null, catalog, "worker")).toContainEqual({
      value: model,
      label,
      provider: "openai",
      tags: ["default", "configured"],
    });
  });

  it("keeps case-distinct catalog identities, configured aliases, and current values", () => {
    const lower = "custom/model-a";
    const upper = "custom/Model-A";
    const caseCatalog = [
      { id: "model-a", name: "Lowercase model", provider: "custom" },
      { id: "Model-A", name: "Uppercase model", provider: "custom" },
    ];
    const config = {
      agents: {
        defaults: { models: { [lower]: { alias: "lower" }, [upper]: { alias: "upper" } } },
      },
    };

    expect(
      buildModelOptions(config, null, caseCatalog).map(({ value, label }) => ({ value, label })),
    ).toEqual([
      { value: lower, label: "Lowercase model · lower" },
      { value: upper, label: "Uppercase model · upper" },
    ]);
    expect(
      buildModelOptions(null, upper, caseCatalog.slice(0, 1)).map(({ value }) => value),
    ).toEqual([upper, lower]);
  });
});

describe("createPrimaryModelExclusion", () => {
  const lower = "custom/model-a";
  const upper = "custom/Model-A";
  const other = "other/model-a";
  type AliasCase = {
    name: string;
    primary: string;
    models: Record<string, { alias?: string } | null>;
    agentModels?: Record<string, { alias?: string } | null> | Array<{ alias?: string }>;
    providers?: Record<string, { api?: string; models?: unknown }>;
    excluded: string[];
    allowed: string[];
  };
  const cases: AliasCase[] = [
    {
      name: "resolves a bare primary alias without folding its target model id",
      primary: "FAST",
      models: { [upper]: { alias: "fast" } },
      excluded: [upper, "fast"],
      allowed: [lower],
    },
    {
      name: "prefers an explicit agent alias over a later default alias",
      primary: "fast",
      models: { [lower]: { alias: "fast" }, [other]: { alias: "fast" } },
      agentModels: { [lower]: { alias: "fast" } },
      excluded: [lower],
      allowed: [other],
    },
    {
      name: "preserves default alias priority when agent metadata omits alias",
      primary: "fast",
      models: { [lower]: { alias: "fast" }, [other]: { alias: "fast" } },
      agentModels: { [lower]: {} },
      excluded: [other],
      allowed: [lower],
    },
    {
      name: "respects an explicitly disabled inherited alias",
      primary: "fast",
      models: { [lower]: { alias: "fast" } },
      agentModels: { [lower]: { alias: "" } },
      excluded: ["fast"],
      allowed: [lower],
    },
    {
      name: "tolerates null editable metadata without replacing inherited aliases",
      primary: "fast",
      models: { [lower]: null, [upper]: { alias: "fast" } },
      agentModels: { [upper]: null },
      excluded: [upper],
      allowed: [lower],
    },
    {
      name: "keeps an explicit configured-provider ref ahead of a slash alias",
      primary: lower,
      models: { [other]: { alias: lower }, [lower]: { alias: "original" } },
      providers: { custom: { api: "openai-completions" } },
      excluded: ["original"],
      allowed: [lower, other],
    },
    {
      name: "resolves a slash alias when no explicit provider owns the input",
      primary: lower,
      models: { [other]: { alias: lower } },
      excluded: [other, lower, upper],
      allowed: ["custom/unrelated"],
    },
    {
      name: "does not replace a provider ref with an alias on a bare config key",
      primary: lower,
      models: { legacy: { alias: lower }, [lower]: { alias: "original" } },
      excluded: ["original"],
      allowed: [lower],
    },
    {
      name: "resolves profile-qualified aliases",
      primary: "fast@work",
      models: { [lower]: { alias: "fast" } },
      excluded: [lower, `${lower}@work`],
      allowed: [`${lower}@other`, `${lower}@Work`],
    },
    {
      name: "keeps primary literal-alias precedence separate from fallback profile parsing",
      primary: "fast@work",
      models: { [lower]: { alias: "fast" }, [upper]: { alias: "fast@work" } },
      excluded: [upper],
      allowed: [lower, "fast@work"],
    },
    {
      name: "preserves case-sensitive credential-profile qualifiers",
      primary: `${lower}@Work`,
      models: {},
      excluded: [lower, `${lower}@Work`],
      allowed: [`${lower}@work`],
    },
    {
      name: "preserves case-distinct explicit references",
      primary: "CUSTOM/Model-A",
      models: {},
      excluded: [upper],
      allowed: [lower],
    },
    {
      name: "does not guess a provider for an ambiguous bare model id",
      primary: "model-a",
      models: { [lower]: {}, [other]: {} },
      excluded: ["model-a"],
      allowed: [lower, other],
    },
    {
      name: "does not infer a provider for bare fallback identities from configured model keys",
      primary: "Model-A",
      models: { [lower]: {}, [upper]: {} },
      excluded: ["Model-A"],
      allowed: [lower, upper],
    },
    {
      name: "does not infer a provider for bare fallback identities from provider model rows",
      primary: "Model-A",
      models: {},
      providers: { custom: { api: "openai-completions", models: [{ id: "Model-A" }] } },
      excluded: ["Model-A"],
      allowed: [upper],
    },
    {
      name: "ignores unsaved provider model shapes while resolving configured aliases",
      primary: "fast",
      models: { [upper]: { alias: "fast" } },
      providers: { custom: { api: "openai-completions", models: {} } },
      excluded: [upper],
      allowed: [lower],
    },
    {
      name: "ignores invalid agent model arrays without shadowing inherited aliases",
      primary: "fast",
      models: { [upper]: { alias: "fast" } },
      agentModels: [{ alias: "fast" }],
      excluded: [upper],
      allowed: [lower],
    },
    {
      name: "preserves a bare id without a configured provider match",
      primary: "Model-A",
      models: {},
      excluded: ["Model-A"],
      allowed: [upper],
    },
    {
      name: "resolves provider-scoped fallback aliases without borrowing another provider's alias",
      primary: lower,
      models: { [lower]: { alias: "fast" }, [other]: { alias: "fast" } },
      excluded: [lower, "custom/fast"],
      allowed: ["fast"],
    },
    {
      name: "does not borrow fallback provider-scoped aliases for a configured primary",
      primary: "anthropic/claude-sonnet-4-6",
      models: {
        "anthropic/claude-sonnet-4-6": { alias: "original" },
        "anthropic/claude-haiku-4-5": { alias: "claude-sonnet-4-6" },
      },
      excluded: ["original"],
      allowed: ["anthropic/claude-haiku-4-5", "anthropic/claude-sonnet-4-6"],
    },
    {
      name: "prefers a global fallback alias before provider-scoped alias lookup",
      primary: lower,
      models: { [lower]: { alias: "fast" }, [other]: { alias: "custom/fast" } },
      excluded: [lower, "fast"],
      allowed: ["custom/fast"],
    },
  ];

  it.each(cases)("$name", ({ primary, models, agentModels, providers, excluded, allowed }) => {
    const config = {
      agents: {
        defaults: { models },
        entries: { worker: { models: agentModels } },
      },
      models: { providers },
    };

    const isExcluded = createPrimaryModelExclusion(config, primary, "worker");
    expect(excluded.filter(isExcluded)).toEqual(excluded);
    expect(allowed.filter(isExcluded)).toEqual([]);
  });
});

describe("formatAgentRuntimeLabel", () => {
  it.each([undefined, {}, { id: "  " }])("does not invent a runtime for %j", (runtime) => {
    expect(formatAgentRuntimeLabel(runtime)).toBe("-");
  });

  it("retains a known runtime and its reported fallback", () => {
    expect(formatAgentRuntimeLabel({ id: "custom", fallback: "remote" })).toBe(
      "custom (fallback remote)",
    );
  });
});

describe("normalizeAgentTargetLabel", () => {
  it("uses resolved configured names but preserves ids for synthesized defaults", () => {
    expect(
      normalizeAgentTargetLabel({ id: "main" }, { name: "Pacino", nameSource: "workspace" }),
    ).toBe("Pacino");
    expect(
      normalizeAgentTargetLabel({ id: "research" }, { name: "Assistant", nameSource: "default" }),
    ).toBe("research");
  });

  it("prefers the authoritative resolved name over unresolved roster fields", () => {
    expect(
      normalizeAgentTargetLabel(
        { id: "main", name: "Roster name", identity: { name: "Roster identity" } },
        { name: "Configured assistant", nameSource: "config" },
      ),
    ).toBe("Configured assistant");
  });

  it("uses roster names when hydration only produced the synthesized default", () => {
    expect(
      normalizeAgentTargetLabel(
        { id: "research", name: "Research roster" },
        { name: "Assistant", nameSource: "default" },
      ),
    ).toBe("Research roster");
  });

  it("preserves the id when an older Gateway omits name provenance", () => {
    expect(normalizeAgentTargetLabel({ id: "legacy" }, { name: "Assistant" })).toBe("legacy");
  });

  it("keeps the shared hydrated-name fallback for existing callers", () => {
    expect(normalizeAgentLabel({ id: "legacy" }, { name: "Workspace Molty" })).toBe(
      "Workspace Molty",
    );
  });
});

describe("listSelectableAgents", () => {
  it("excludes semantic system rows without depending on identity", () => {
    const agents = [
      { id: "main", kind: "agent" as const },
      { id: "ordinary-looking-id", kind: "system" as const },
      { id: "legacy-gateway-row" },
    ];

    expect(listSelectableAgents(agents)).toEqual([agents[0], agents[2]]);
    expect(agents).toHaveLength(3);
  });
});

describe("formatBytes", () => {
  it("preserves the Control UI byte-size display contract", () => {
    expect(formatBytes(undefined)).toBe("-");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(12 * 1024)).toBe("12 KB");
    expect(formatBytes(2 * 1024 * 1024)).toBe("2.0 MB");
  });

  it("supports caller-owned fallback, unit cap, and precision", () => {
    const options = {
      fallback: "0 B",
      maxUnit: "kilo" as const,
      fractionDigits: (_value: number, unit: "byte" | "kilo" | "mega" | "giga" | "tera") =>
        unit === "byte" ? null : 1,
    };
    expect(formatBytes(Number.NaN, options)).toBe("0 B");
    expect(formatBytes(12 * 1024, options)).toBe("12.0 KB");
    expect(formatBytes(1024 * 1024, options)).toBe("1024.0 KB");
  });
});

describe("resolveEffectiveModelFallbacks", () => {
  it("inherits defaults when no entry fallbacks are configured", () => {
    const entryModel = undefined;
    const defaultModel = {
      primary: "openai/gpt-5-nano",
      fallbacks: ["google/gemini-2.0-flash"],
    };

    expect(resolveEffectiveModelFallbacks(entryModel, defaultModel)).toEqual([
      "google/gemini-2.0-flash",
    ]);
  });

  it("prefers entry fallbacks over defaults", () => {
    const entryModel = {
      primary: "openai/gpt-5-mini",
      fallbacks: ["openai/gpt-5-nano"],
    };
    const defaultModel = {
      primary: "openai/gpt-5",
      fallbacks: ["google/gemini-2.0-flash"],
    };

    expect(resolveEffectiveModelFallbacks(entryModel, defaultModel)).toEqual(["openai/gpt-5-nano"]);
  });

  it.each([
    { name: "a string primary", model: "openai/gpt-5.4" },
    { name: "an object primary", model: { primary: "openai/gpt-5.4" } },
  ])("does not inherit global fallbacks for $name", ({ model }) => {
    expect(
      resolveEffectiveModelFallbacks(model, {
        primary: "openai/gpt-5.4",
        fallbacks: ["anthropic/claude-sonnet-4-6"],
      }),
    ).toStrictEqual([]);
  });

  it("keeps explicit empty entry fallback lists", () => {
    const entryModel = {
      primary: "openai/gpt-5-mini",
      fallbacks: [],
    };
    const defaultModel = {
      primary: "openai/gpt-5",
      fallbacks: ["google/gemini-2.0-flash"],
    };

    expect(resolveEffectiveModelFallbacks(entryModel, defaultModel)).toStrictEqual([]);
  });
});

describe("assistantAvatarFallbackUrl", () => {
  it("uses the bundled Molty png for assistant profile fallbacks", () => {
    expect(assistantAvatarFallbackUrl("/ui")).toBe("/ui/apple-touch-icon.png");
    expect(assistantAvatarFallbackUrl("")).toBe("/apple-touch-icon.png");
  });
});

describe("resolveAssistantTextAvatar", () => {
  it("rejects unsafe invisible controls in assistant text avatars", () => {
    expect(resolveAssistantTextAvatar("VC")).toBe("VC");
    expect(resolveAssistantTextAvatar("\u{1F43E}")).toBe("\u{1F43E}");
    expect(resolveAssistantTextAvatar("V\u202eC")).toBeNull();
    expect(resolveAssistantTextAvatar("V\u200bC")).toBeNull();
  });
});

describe("resolveAgentAvatarUrl", () => {
  it("accepts image data URLs only through the shared encoded-size boundary", () => {
    const prefix = "data:image/svg+xml;base64,";
    const exact = `${prefix}${"A".repeat(AVATAR_MAX_DATA_URL_CHARS - prefix.length)}`;

    expect(isRenderableControlUiAvatarUrl(exact)).toBe(true);
    expect(isRenderableControlUiAvatarUrl(`${exact}A`)).toBe(false);
    expect(isRenderableControlUiAvatarUrl("data:text/plain,avatar")).toBe(false);
  });

  it("prefers a runtime avatar URL over non-URL identity avatars", () => {
    expect(
      resolveAgentAvatarUrl(
        { identity: { avatar: "A", avatarUrl: "/avatar/main" } },
        {
          agentId: "main",
          avatar: "A",
          name: "Main",
        },
      ),
    ).toBe("/avatar/main");
  });

  it("ignores remote http avatars so the control UI falls back to a local badge", () => {
    expect(
      resolveAgentAvatarUrl({
        identity: { avatarUrl: "https://example.com/avatar.png" },
      }),
    ).toBeNull();
  });

  it("ignores protocol-relative avatars so the control UI cannot be tricked into a cross-origin fetch", () => {
    expect(
      resolveAgentAvatarUrl({
        identity: { avatarUrl: "//evil.example/avatar.png" },
      }),
    ).toBeNull();
  });

  it("returns null for initials or emoji avatar values without a URL", () => {
    expect(resolveAgentAvatarUrl({ identity: { avatar: "A" } })).toBeNull();
    expect(resolveAgentAvatarUrl({ identity: { avatar: "🦞" } })).toBeNull();
  });
});

describe("resolveChatAvatarRenderUrl", () => {
  it("accepts a blob: URL produced by an authenticated avatar fetch", () => {
    expect(
      resolveChatAvatarRenderUrl("blob:http://localhost/uuid-123", {
        identity: { avatarUrl: "/avatar/main" },
      }),
    ).toBe("blob:http://localhost/uuid-123");
  });

  it("falls back to the config-sanitized avatar when no blob candidate is present", () => {
    expect(
      resolveChatAvatarRenderUrl(null, {
        identity: { avatarUrl: "/avatar/main" },
      }),
    ).toBe("/avatar/main");
  });

  it("rejects remote URLs passed as the render candidate", () => {
    expect(
      resolveChatAvatarRenderUrl("https://example.com/avatar.png", {
        identity: { avatarUrl: "/avatar/main" },
      }),
    ).toBe("/avatar/main");
  });
});

describe("resolveAgentSkillsFilter", () => {
  it("inherits the default filter when the agent has no override", () => {
    expect(
      resolveAgentSkillsFilter(
        {
          agents: {
            defaults: { skills: [" github ", "weather"] },
            entries: { main: { default: true } },
          },
        },
        "main",
      ),
    ).toEqual(["github", "weather"]);
  });

  it("prefers an explicit empty agent filter over inherited defaults", () => {
    expect(
      resolveAgentSkillsFilter(
        {
          agents: {
            defaults: { skills: ["github"] },
            entries: { main: { skills: [] } },
          },
        },
        "main",
      ),
    ).toEqual([]);
  });
});

describe("buildAgentContext", () => {
  it("falls back to agent payload workspace/model when config form is unavailable", () => {
    const context = buildAgentContext(
      {
        id: "main",
        workspace: "/tmp/agent-workspace",
        model: {
          primary: "openai/gpt-5.5",
          fallbacks: ["openai/gpt-5.2-codex"],
        },
        agentRuntime: { id: "claude-cli", fallback: "none", source: "agent" },
      },
      null,
      null,
      "main",
      null,
    );

    expect(context.workspace).toBe("/tmp/agent-workspace");
    expect(context.model).toBe("openai/gpt-5.5 (+1 fallback)");
    expect(context.runtime).toBe("claude-cli (fallback none)");
    expect(context.isDefault).toBe(true);
  });

  it("uses configured defaults when agent-specific overrides are absent", () => {
    const context = buildAgentContext(
      { id: "main" },
      {
        agents: {
          defaults: {
            workspace: "/tmp/default-workspace",
            model: {
              primary: "openai/gpt-5.5",
              fallbacks: ["openai/gpt-5.2-codex"],
            },
          },
          entries: { main: { default: true } },
        },
      },
      null,
      "main",
      null,
    );

    expect(context.workspace).toBe("/tmp/default-workspace");
    expect(context.model).toBe("openai/gpt-5.5 (+1 fallback)");
    expect(context.runtime).toBe("-");
  });

  it("shows inherited skill filters in the agent context", () => {
    const context = buildAgentContext(
      { id: "main" },
      {
        agents: {
          defaults: { skills: ["github", "weather"] },
          entries: { main: { default: true } },
        },
      },
      null,
      "main",
      null,
    );

    expect(context.skillsLabel).toBe("2 selected");
  });

  it("prefers per-agent configured identity over runtime global identity in agent panels", () => {
    const context = buildAgentContext(
      {
        id: "fs-daying",
        name: "File-system agent",
        identity: { name: "大颖", emoji: "⚙️" },
      },
      null,
      null,
      "main",
      {
        agentId: "fs-daying",
        name: "AI大管家",
        avatar: "M",
        emoji: "🤖",
      },
    );

    expect(context.identityName).toBe("大颖");
    expect(context.identityAvatar).toBe("⚙️");
  });
});
