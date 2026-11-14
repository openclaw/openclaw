import { describe, expect, it } from "vitest";
import { REDACTED_SENTINEL } from "../config/redact-sentinel.js";
import {
  createConfigResolutionFacts,
  setConfigResolutionFacts,
} from "../config/resolution-facts.js";
import type { ConfigFileSnapshot } from "../config/types.openclaw.js";
import { parseConcreteConfigPathTokens } from "../shared/dot-path.js";
import {
  buildConfigExplainResult,
  resolveExplainSecretRef,
  resolveIncludeProvenanceForPath,
} from "./config-cli-explain.js";

function baseSnapshot(
  overrides: Partial<ConfigFileSnapshot> & {
    sourceConfig?: ConfigFileSnapshot["sourceConfig"];
    config?: ConfigFileSnapshot["config"];
  } = {},
): ConfigFileSnapshot {
  const sourceConfig = overrides.sourceConfig ?? {};
  const config = overrides.config ?? sourceConfig;
  return {
    path: "/tmp/openclaw.json",
    exists: true,
    raw: "{}",
    parsed: sourceConfig,
    sourceConfig,
    resolved: sourceConfig,
    valid: true,
    runtimeConfig: config as ConfigFileSnapshot["runtimeConfig"],
    config: config as ConfigFileSnapshot["config"],
    issues: [],
    warnings: [],
    legacyIssues: [],
    ...overrides,
  };
}

describe("resolveIncludeProvenanceForPath", () => {
  it("reports a sole include owner", () => {
    const include = resolveIncludeProvenanceForPath({
      pathTokens: ["agents", "defaults", "maxConcurrent"],
      provenance: [
        {
          path: ["agents"],
          kind: "single",
          hasSiblingOverrides: false,
          targetPath: "/tmp/agents.json5",
        },
      ],
    });
    expect(include).toEqual({
      files: ["/tmp/agents.json5"],
      kind: "single",
      hasSiblingOverrides: false,
      boundaryPath: "agents",
      ambiguous: false,
    });
  });

  it("marks sibling overrides as ambiguous", () => {
    const include = resolveIncludeProvenanceForPath({
      pathTokens: ["gateway", "port"],
      provenance: [
        {
          path: ["gateway"],
          kind: "single",
          hasSiblingOverrides: true,
          targetPath: "/tmp/gateway.json5",
        },
      ],
    });
    expect(include?.ambiguous).toBe(true);
    expect(include?.files).toEqual(["/tmp/gateway.json5"]);
  });

  it("marks multiple include targets as ambiguous", () => {
    const include = resolveIncludeProvenanceForPath({
      pathTokens: ["channels"],
      provenance: [
        {
          path: ["channels"],
          kind: "multiple",
          hasSiblingOverrides: false,
          targetPaths: ["/tmp/a.json5", "/tmp/b.json5"],
        },
      ],
    });
    expect(include?.ambiguous).toBe(true);
    expect(include?.kind).toBe("multiple");
    expect(include?.files).toEqual(["/tmp/a.json5", "/tmp/b.json5"]);
  });

  it("marks enclosing sibling overrides as ambiguous (root override of nested include)", () => {
    // Root: {$include:"base.json5", gateway:{port:19001}}
    // base: {gateway:{$include:"gateway.json5"}}
    // gateway.json5: {port:18789}
    const include = resolveIncludeProvenanceForPath({
      pathTokens: ["gateway", "port"],
      provenance: [
        {
          path: [],
          kind: "single",
          hasSiblingOverrides: true,
          targetPath: "/tmp/base.json5",
        },
        {
          path: ["gateway"],
          kind: "single",
          hasSiblingOverrides: false,
          targetPath: "/tmp/gateway.json5",
        },
      ],
    });
    expect(include?.ambiguous).toBe(true);
    expect(include?.hasSiblingOverrides).toBe(true);
    expect(include?.files).toEqual(
      expect.arrayContaining(["/tmp/base.json5", "/tmp/gateway.json5"]),
    );
    expect(include?.boundaryPath).toBe("gateway");
  });
});

describe("resolveExplainSecretRef", () => {
  it("always redacts SecretRef ids from resolution facts", () => {
    const config = { gateway: { auth: { token: "literal-should-not-leak" } } };
    const facts = createConfigResolutionFacts(
      [],
      new Map([["gateway.auth.token", "GATEWAY_TOKEN"]]),
      "default",
    );
    setConfigResolutionFacts(config, facts);
    const summary = resolveExplainSecretRef({
      path: "gateway.auth.token",
      factOwner: config,
      authoredValue: "literal-should-not-leak",
      runtimeValue: "literal-should-not-leak",
    });
    expect(summary).toEqual({
      source: "env",
      provider: "default",
      id: REDACTED_SENTINEL,
      state: "pending",
    });
    expect(JSON.stringify(summary)).not.toContain("GATEWAY_TOKEN");
  });

  it("redacts structured SecretRef ids without resolving", () => {
    const summary = resolveExplainSecretRef({
      path: "channels.discord.token",
      factOwner: {},
      authoredValue: { source: "env", provider: "default", id: "DISCORD_BOT_TOKEN" },
      runtimeValue: undefined,
    });
    expect(summary).toEqual({
      source: "env",
      provider: "default",
      id: REDACTED_SENTINEL,
      state: "structured",
    });
    expect(JSON.stringify(summary)).not.toContain("DISCORD_BOT_TOKEN");
  });

  it("does not reparse decoded $${LITERAL} strings when facts are known-empty", () => {
    const config = { agents: { defaults: { workspace: "${LITERAL}" } } };
    // Empty facts set = authoritative known-empty (passed through substitution, no refs).
    setConfigResolutionFacts(config, createConfigResolutionFacts([]));
    const summary = resolveExplainSecretRef({
      path: "agents.defaults.workspace",
      factOwner: config,
      authoredValue: "${LITERAL}",
      runtimeValue: "${LITERAL}",
    });
    expect(summary).toBeUndefined();
  });

  it("finds resolved facts under canonical path spelling", () => {
    const config = { gateway: { auth: { token: "resolved-value" } } };
    const facts = createConfigResolutionFacts(
      [],
      new Map(),
      "custom-alias",
      new Map([["gateway.auth.token", "GATEWAY_TOKEN"]]),
    );
    setConfigResolutionFacts(config, facts);
    const summary = resolveExplainSecretRef({
      path: "gateway.auth.token",
      factOwner: config,
      authoredValue: "${GATEWAY_TOKEN}",
      runtimeValue: "resolved-value",
    });
    expect(summary).toEqual({
      source: "env",
      provider: "custom-alias",
      id: REDACTED_SENTINEL,
      state: "resolved",
    });
  });
});

describe("buildConfigExplainResult", () => {
  it("reports source=default when only the runtime snapshot has the value", () => {
    const result = buildConfigExplainResult({
      path: "agents.defaults.maxConcurrent",
      pathTokens: ["agents", "defaults", "maxConcurrent"],
      snapshot: baseSnapshot({
        authoredConfig: {},
        sourceConfig: {},
        config: { agents: { defaults: { maxConcurrent: 4 } } } as never,
      }),
      runtimeLookup: { found: true, value: 4 },
    });
    expect(result).toMatchObject({
      path: "agents.defaults.maxConcurrent",
      authoredPresent: false,
      source: "default",
      runtimeValue: 4,
    });
  });

  it("prefers authoredConfig over sourceConfig for authored presence", () => {
    const result = buildConfigExplainResult({
      path: "gateway.port",
      pathTokens: ["gateway", "port"],
      snapshot: baseSnapshot({
        authoredConfig: { gateway: { port: 19001 } },
        // Contrasting sourceConfig: materialization alone must not win over authored.
        sourceConfig: { gateway: { port: 18789 } },
        config: { gateway: { port: 19001 } } as never,
      }),
      runtimeLookup: { found: true, value: 19001 },
    });
    expect(result.source).toBe("authored");
    expect(result.authoredPresent).toBe(true);
    // Do not assert raw authoredValue: ConfigExplainResult never exposes it.
  });

  it("reports sole include ownership as source=include when leaf is authored", () => {
    const result = buildConfigExplainResult({
      path: "agents.defaults.maxConcurrent",
      pathTokens: ["agents", "defaults", "maxConcurrent"],
      snapshot: baseSnapshot({
        authoredConfig: { agents: { defaults: { maxConcurrent: 8 } } },
        sourceConfig: { agents: { defaults: { maxConcurrent: 8 } } },
        config: { agents: { defaults: { maxConcurrent: 8 } } } as never,
        includeProvenance: [
          {
            path: ["agents"],
            kind: "single",
            hasSiblingOverrides: false,
            targetPath: "/tmp/agents.json5",
          },
        ],
      }),
      runtimeLookup: { found: true, value: 8 },
    });
    expect(result.source).toBe("include");
    expect(result.include?.files).toEqual(["/tmp/agents.json5"]);
    expect(result.include?.ambiguous).toBe(false);
  });

  it("classifies absent authored leaves under an include boundary as default, not include", () => {
    // openclaw.json: {agents:{$include:"agents.json5"}} ; agents.json5: {defaults:{}}
    // maxConcurrent is absent from authored but materializes as runtime default 32.
    const result = buildConfigExplainResult({
      path: "agents.defaults.maxConcurrent",
      pathTokens: ["agents", "defaults", "maxConcurrent"],
      snapshot: baseSnapshot({
        authoredConfig: { agents: { defaults: {} } },
        sourceConfig: { agents: { defaults: {} } },
        config: { agents: { defaults: { maxConcurrent: 32 } } } as never,
        includeProvenance: [
          {
            path: ["agents"],
            kind: "single",
            hasSiblingOverrides: false,
            targetPath: "/tmp/agents.json5",
          },
        ],
      }),
      runtimeLookup: { found: true, value: 32 },
    });
    expect(result.authoredPresent).toBe(false);
    expect(result.source).toBe("default");
    expect(result.include).toBeUndefined();
    expect(result.runtimeValue).toBe(32);
  });

  it("reports unset (not include) for schema-valid absent leaf with no runtime value", () => {
    const result = buildConfigExplainResult({
      path: "agents.defaults.workspace",
      pathTokens: ["agents", "defaults", "workspace"],
      snapshot: baseSnapshot({
        authoredConfig: { agents: { defaults: {} } },
        sourceConfig: { agents: { defaults: {} } },
        config: { agents: { defaults: {} } } as never,
        includeProvenance: [
          {
            path: ["agents"],
            kind: "single",
            hasSiblingOverrides: false,
            targetPath: "/tmp/agents.json5",
          },
        ],
      }),
      runtimeLookup: { found: false },
    });
    expect(result.authoredPresent).toBe(false);
    expect(result.source).toBe("unset");
    expect(result.include).toBeUndefined();
  });

  it("marks enclosing root override of nested include as ambiguous", () => {
    const result = buildConfigExplainResult({
      path: "gateway.port",
      pathTokens: ["gateway", "port"],
      snapshot: baseSnapshot({
        authoredConfig: { gateway: { port: 19001 } },
        sourceConfig: { gateway: { port: 19001 } },
        config: { gateway: { port: 19001 } } as never,
        includeProvenance: [
          {
            path: [],
            kind: "single",
            hasSiblingOverrides: true,
            targetPath: "/tmp/base.json5",
          },
          {
            path: ["gateway"],
            kind: "single",
            hasSiblingOverrides: false,
            targetPath: "/tmp/gateway.json5",
          },
        ],
      }),
      runtimeLookup: { found: true, value: 19001 },
    });
    expect(result.source).toBe("ambiguous");
    expect(result.include?.ambiguous).toBe(true);
    expect(result.include?.files).toEqual(
      expect.arrayContaining(["/tmp/base.json5", "/tmp/gateway.json5"]),
    );
  });

  it("looks up SecretRef facts by canonical path while keeping entered spelling", () => {
    const config = { gateway: { auth: { token: "resolved-value" } } };
    const facts = createConfigResolutionFacts(
      [],
      new Map(),
      "custom-alias",
      new Map([["gateway.auth.token", "GATEWAY_TOKEN"]]),
    );
    setConfigResolutionFacts(config, facts);
    const entered = 'gateway["auth"]["token"]';
    const pathTokens = parseConcreteConfigPathTokens(entered);
    const result = buildConfigExplainResult({
      path: entered,
      pathTokens,
      snapshot: baseSnapshot({
        authoredConfig: { gateway: { auth: { token: "${GATEWAY_TOKEN}" } } },
        sourceConfig: config,
        config: config as never,
      }),
      runtimeLookup: { found: true, value: "resolved-value" },
    });
    expect(result.path).toBe(entered);
    expect(result.secretRef).toEqual({
      source: "env",
      provider: "custom-alias",
      id: REDACTED_SENTINEL,
      state: "resolved",
    });
  });

  it.each(["agents.defaults.model.fallbacks.0", "agents.defaults.model.fallbacks[0]"])(
    "canonicalizes array index spelling for SecretRef facts (%s)",
    (entered) => {
      const config = {
        agents: { defaults: { model: { fallbacks: ["anthropic/claude-sonnet-4-5"] } } },
      };
      const facts = createConfigResolutionFacts(
        [],
        new Map(),
        "default",
        new Map([["agents.defaults.model.fallbacks[0]", "FALLBACK_MODEL"]]),
      );
      setConfigResolutionFacts(config, facts);
      const pathTokens = parseConcreteConfigPathTokens(entered);
      const result = buildConfigExplainResult({
        path: entered,
        pathTokens,
        snapshot: baseSnapshot({
          authoredConfig: {
            agents: { defaults: { model: { fallbacks: ["${FALLBACK_MODEL}"] } } },
          },
          sourceConfig: config,
          config: config as never,
        }),
        runtimeLookup: { found: true, value: "anthropic/claude-sonnet-4-5" },
      });
      expect(result.path).toBe(entered);
      expect(result.secretRef).toEqual({
        source: "env",
        provider: "default",
        id: REDACTED_SENTINEL,
        state: "resolved",
      });
    },
  );
});
