import { expect, it } from "vitest";
import { AVATAR_MAX_DATA_URL_CHARS } from "../../../../src/shared/avatar-limits.js";
import {
  isRenderableControlUiAvatarUrl,
  resolveAgentAvatarUrl,
  resolveAssistantTextAvatar,
  resolveChatAvatarRenderUrl,
} from "../avatar.ts";
import {
  buildAgentContext,
  buildModelOptions,
  createPrimaryModelExclusion,
  formatBytes,
  listSelectableAgents,
  normalizeAgentTargetLabel,
  resolveAgentSkillsFilter,
  resolveEffectiveModelFallbacks,
} from "./display.ts";

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

it("lets an explicit empty agent alias disable the inherited alias", () => {
  const catalog = [{ id: "model-a", name: "Model A", provider: "custom", alias: "gateway" }];
  const config = aliases({ [lower]: "global" }, { [lower]: "" });

  expect(
    buildModelOptions(config, null, catalog, "worker").find(({ value }) => value === lower)?.label,
  ).toBe("Model A");
});

it("keeps case-distinct catalog identities, configured aliases, and current values", () => {
  const caseCatalog = [
    { id: "model-a", name: "Lowercase model", provider: "custom" },
    { id: "Model-A", name: "Uppercase model", provider: "custom" },
  ];
  const config = agentConfig({
    models: { [lower]: { alias: "lower" }, [upper]: { alias: "upper" } },
  });

  expect(
    buildModelOptions(config, null, caseCatalog).map(({ value, label }) => ({ value, label })),
  ).toEqual([
    { value: lower, label: "Lowercase model · lower" },
    { value: upper, label: "Uppercase model · upper" },
  ]);
  expect(buildModelOptions(null, upper, caseCatalog.slice(0, 1)).map(({ value }) => value)).toEqual(
    [upper, lower],
  );
});
const [lower, upper, other] = ["custom/model-a", "custom/Model-A", "other/model-a"];
it.each([
  ["disabled alias", "fast", aliases({ [lower]: "fast" }, { [lower]: "" }), ["fast"], [lower]],
  [
    "null metadata",
    "fast",
    aliases({ [lower]: null, [upper]: "fast" }, { [upper]: null }),
    [upper],
    [lower],
  ],
  [
    "provider precedence",
    lower,
    {
      ...aliases({ [other]: lower, [lower]: "original" }),
      models: { providers: { custom: { api: "openai-completions" } } },
    },
    ["original"],
    [lower, other],
  ],
  ["slash alias", lower, aliases({ [other]: lower }), [other, lower, upper], ["custom/unrelated"]],
  [
    "profile-qualified alias",
    "fast@work",
    aliases({ [lower]: "fast" }),
    [lower, `${lower}@work`],
    [`${lower}@other`, `${lower}@Work`],
  ],
] as const)("resolves %s", (_name, primary, config, excluded, allowed) => {
  const isExcluded = createPrimaryModelExclusion(config, primary, "worker");
  expect(excluded.filter(isExcluded)).toEqual(excluded);
  expect(allowed.filter(isExcluded)).toEqual([]);
});
it("uses resolved configured names but preserves ids for synthesized defaults", () => {
  expect(
    normalizeAgentTargetLabel({ id: "main" }, { name: "Pacino", nameSource: "workspace" }),
  ).toBe("Pacino");
  expect(
    normalizeAgentTargetLabel({ id: "research" }, { name: "Assistant", nameSource: "default" }),
  ).toBe("research");
});
it("excludes semantic system rows without depending on identity", () => {
  const agents = [
    { id: "main", kind: "agent" as const },
    { id: "ordinary-looking-id", kind: "system" as const },
    { id: "legacy-gateway-row" },
  ];

  expect(listSelectableAgents(agents)).toEqual([agents[0], agents[2]]);
  expect(agents).toHaveLength(3);
});
it("preserves the Control UI byte-size display contract", () => {
  expect(formatBytes(undefined)).toBe("-");
  expect(formatBytes(512)).toBe("512 B");
  expect(formatBytes(1536)).toBe("1.5 KB");
  expect(formatBytes(12 * 1024)).toBe("12 KB");
  expect(formatBytes(2 * 1024 * 1024)).toBe("2.0 MB");
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
it("rejects unsafe invisible controls in assistant text avatars", () => {
  expect(resolveAssistantTextAvatar("VC")).toBe("VC");
  expect(resolveAssistantTextAvatar("\u{1F43E}")).toBe("\u{1F43E}");
  expect(resolveAssistantTextAvatar("V\u202eC")).toBeNull();
  expect(resolveAssistantTextAvatar("V\u200bC")).toBeNull();
});
it("accepts image data URLs only through the shared encoded-size boundary", () => {
  const prefix = "data:image/svg+xml;base64,";
  const exact = `${prefix}${"A".repeat(AVATAR_MAX_DATA_URL_CHARS - prefix.length)}`;

  expect(isRenderableControlUiAvatarUrl(exact)).toBe(true);
  expect(isRenderableControlUiAvatarUrl(`${exact}A`)).toBe(false);
  expect(isRenderableControlUiAvatarUrl("data:text/plain,avatar")).toBe(false);
});

it("uses the resolved identity absence instead of a stale roster avatar URL", () => {
  expect(
    resolveAgentAvatarUrl(
      { identity: { avatar: "A", avatarUrl: "/avatar/main" } },
      { agentId: "main", avatar: "A", name: "Main" },
    ),
  ).toBeNull();
});

it.each(["https://example.com/avatar.png", "//evil.example/avatar.png"])(
  "rejects cross-origin roster avatar %s",
  (avatarUrl) => {
    expect(resolveAgentAvatarUrl({ identity: { avatarUrl } })).toBeNull();
  },
);
it.each([
  ["blob:http://localhost/uuid-123", "blob:http://localhost/uuid-123"],
  ["https://example.com/avatar.png", "/avatar/main"],
])("renders chat avatar %s as %s", (candidate, expected) => {
  expect(resolveChatAvatarRenderUrl(candidate, avatarAgent)).toBe(expected);
});
it("prefers an explicit empty agent filter over inherited defaults", () => {
  expect(
    resolveAgentSkillsFilter(agentConfig({ skills: ["github"] }, { skills: [] }), "main"),
  ).toEqual([]);
});
it("uses configured defaults when agent-specific overrides are absent", () => {
  const context = buildAgentContext(
    { id: "main" },
    agentConfig({
      skills: ["github", "weather"],
      workspace: "/tmp/default-workspace",
      model: {
        primary: "openai/gpt-5.5",
        fallbacks: ["openai/gpt-5.2-codex"],
      },
    }),
    null,
    "main",
    null,
  );

  expect(context).toMatchObject({
    workspace: "/tmp/default-workspace",
    model: "openai/gpt-5.5 (+1 fallback)",
    runtime: "-",
    skillsLabel: "2 selected",
  });
});

it("prefers per-agent configured identity over runtime global identity in agent panels", () => {
  const agent = { id: "worker", name: "Roster", identity: { name: "大颖", emoji: "⚙️" } };
  const identity = { agentId: "worker", name: "Runtime", avatar: "M", emoji: "🤖" };
  const context = buildAgentContext(agent, null, null, "main", identity);

  expect(context).toMatchObject({ identityName: "大颖", identityAvatar: "⚙️" });
});

const avatarAgent = { identity: { avatarUrl: "/avatar/main" } };
function agentConfig(defaults: Record<string, unknown>, main = {}) {
  return { agents: { defaults, entries: { main } } };
}

function aliases(defaults: Record<string, string | null>, worker = {}) {
  const metadata = (values: Record<string, string | null>) =>
    Object.fromEntries(
      Object.entries(values).map(([model, alias]) => [model, alias === null ? null : { alias }]),
    );
  return {
    agents: {
      defaults: { models: metadata(defaults) },
      entries: { worker: { models: metadata(worker) } },
    },
  };
}
