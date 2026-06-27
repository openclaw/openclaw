import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import officialExternalPluginCatalog from "../../scripts/lib/official-external-plugin-catalog.json" with { type: "json" };
import {
  type OfficialExternalPluginCatalogEntry,
  getOfficialExternalPluginCatalogEntry,
  isOfficialExternalPluginCatalogFeed,
  listOfficialExternalPluginCatalogEntries,
  loadHostedOfficialExternalPluginCatalogEntries,
  parseOfficialExternalPluginCatalogEntries,
  resolveOfficialExternalProviderContractPluginIds,
  resolveOfficialExternalProviderPluginIds,
  resolveOfficialExternalProviderPluginIdsForEnv,
  resolveOfficialExternalWebProviderContractPluginIdsForEnv,
  resolveOfficialExternalPluginId,
  resolveOfficialExternalPluginInstall,
} from "./official-external-plugin-catalog.js";

function expectCatalogEntry(id: string): OfficialExternalPluginCatalogEntry {
  const entry = getOfficialExternalPluginCatalogEntry(id);
  if (entry === undefined) {
    throw new Error(`Expected external plugin catalog entry for ${id}`);
  }
  return entry;
}

describe("official external plugin catalog", () => {
  it("keeps hosted fetch guard loading lazy for bundled catalog import paths", () => {
    const source = readFileSync(
      new URL("./official-external-plugin-catalog.ts", import.meta.url),
      "utf8",
    );

    expect(source).not.toMatch(/from ["']\.\.\/infra\/net\/fetch-guard\.js["']/);
    expect(source).toContain('await import("../infra/net/fetch-guard.js")');
  });

  it("ships the official plugin catalog as a feed-shaped bundled fallback", () => {
    expect(isOfficialExternalPluginCatalogFeed(officialExternalPluginCatalog)).toBe(true);
    expect(officialExternalPluginCatalog).toMatchObject({
      schemaVersion: 1,
      id: "openclaw-official-external-plugins",
      sequence: 1,
    });
    expect(officialExternalPluginCatalog.entries.length).toBeGreaterThan(0);
  });

  it("does not allow malformed feed wrappers to count as feed documents", () => {
    expect(
      isOfficialExternalPluginCatalogFeed({
        schemaVersion: 1,
        id: " ",
        generatedAt: "2026-06-22T00:00:00.000Z",
        sequence: 1,
        entries: [],
      }),
    ).toBe(false);
    expect(
      isOfficialExternalPluginCatalogFeed({
        schemaVersion: 3,
        id: "openclaw-official-external-plugins",
        generatedAt: "2026-06-22T00:00:00.000Z",
        sequence: 1,
        entries: [],
      }),
    ).toBe(false);
  });

  it("accepts the live ClawHub feed schema version", () => {
    expect(
      isOfficialExternalPluginCatalogFeed({
        schemaVersion: 2,
        id: "clawhub-official",
        generatedAt: "2026-06-25T01:19:39.629Z",
        sequence: 11,
        entries: [],
      }),
    ).toBe(true);
  });

  it("keeps live ClawHub marketplace entries as metadata-only feed entries", () => {
    const [entry] = parseOfficialExternalPluginCatalogEntries({
      schemaVersion: 2,
      id: "clawhub-official",
      generatedAt: "2026-06-25T01:19:39.629Z",
      sequence: 11,
      entries: [
        {
          type: "plugin",
          id: "@expediagroup/expedia-openclaw",
          title: "Expedia Travel",
          version: "1.0.4",
          state: "available",
          publisher: {
            id: "expediagroup",
            trust: "official",
          },
          install: {
            candidates: [
              {
                sourceRef: "public-clawhub",
                package: "@expediagroup/expedia-openclaw",
                version: "1.0.4",
                integrity:
                  "sha256:b355dda04403becaab8bbab069fd1e7b0578262e7459e598cc5b19615b5bdab9",
              },
            ],
          },
        },
      ],
    });

    if (entry === undefined) {
      throw new Error("Expected hosted ClawHub feed entry to parse");
    }

    expect(entry).toMatchObject({
      id: "@expediagroup/expedia-openclaw",
      title: "Expedia Travel",
      version: "1.0.4",
    });
    expect(resolveOfficialExternalPluginId(entry)).toBeUndefined();
    expect(resolveOfficialExternalPluginInstall(entry)).toBeNull();
  });

  it("does not synthesize trusted installs for unavailable or untrusted hosted entries", () => {
    const entries = parseOfficialExternalPluginCatalogEntries({
      schemaVersion: 2,
      id: "clawhub-official",
      generatedAt: "2026-06-25T01:19:39.629Z",
      sequence: 11,
      entries: [
        {
          type: "plugin",
          id: "@example/unavailable",
          title: "Unavailable",
          version: "1.0.0",
          state: "disabled",
          publisher: { id: "example", trust: "official" },
          install: {
            candidates: [
              {
                sourceRef: "public-clawhub",
                package: "@example/unavailable",
                version: "1.0.0",
              },
            ],
          },
        },
        {
          type: "plugin",
          id: "@example/community",
          title: "Community",
          version: "1.0.0",
          state: "available",
          publisher: { id: "example", trust: "community" },
          install: {
            candidates: [
              {
                sourceRef: "public-clawhub",
                package: "@example/community",
                version: "1.0.0",
              },
            ],
          },
        },
        {
          type: "plugin",
          id: "@example/private-source",
          title: "Private Source",
          version: "1.0.0",
          state: "available",
          publisher: { id: "example", trust: "official" },
          install: {
            candidates: [
              {
                sourceRef: "private-feed",
                package: "@example/private-source",
                version: "1.0.0",
              },
            ],
          },
        },
      ],
    });

    expect(entries).toHaveLength(3);
    for (const entry of entries) {
      expect(resolveOfficialExternalPluginId(entry)).toBeUndefined();
      expect(resolveOfficialExternalPluginInstall(entry)).toBeNull();
    }
  });

  it("keeps unsupported versioned feed wrappers out of legacy catalog parsing", () => {
    expect(
      parseOfficialExternalPluginCatalogEntries({
        schemaVersion: 3,
        id: "future-feed",
        generatedAt: "2026-06-22T00:00:00.000Z",
        sequence: 1,
        entries: [{ name: "should-not-load" }],
      }),
    ).toEqual([]);
    expect(
      parseOfficialExternalPluginCatalogEntries({
        entries: [{ name: "legacy-catalog-entry" }],
      }),
    ).toEqual([{ name: "legacy-catalog-entry" }]);
  });

  it("loads a hosted feed with conditional headers and checksum metadata", async () => {
    const body = JSON.stringify({
      schemaVersion: 1,
      id: "openclaw-official-external-plugins",
      generatedAt: "2026-06-22T00:00:00.000Z",
      sequence: 2,
      entries: [
        {
          name: "@openclaw/hosted-proof",
          kind: "plugin",
          openclaw: {
            plugin: { id: "hosted-proof", label: "Hosted Proof" },
            install: { npmSpec: "@openclaw/hosted-proof", defaultChoice: "npm" },
          },
        },
      ],
    });
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("if-none-match")).toBe('"old"');
      expect(headers.get("if-modified-since")).toBe("Mon, 22 Jun 2026 00:00:00 GMT");
      return new Response(body, {
        status: 200,
        headers: {
          etag: '"next"',
          "last-modified": "Mon, 22 Jun 2026 01:00:00 GMT",
          "content-length": String(new TextEncoder().encode(body).byteLength),
        },
      });
    });

    const result = await loadHostedOfficialExternalPluginCatalogEntries({
      fetchImpl,
      ifNoneMatch: '"old"',
      ifModifiedSince: "Mon, 22 Jun 2026 00:00:00 GMT",
    });

    expect(result.source).toBe("hosted");
    expect(result.entries.map((entry) => entry.name)).toEqual(["@openclaw/hosted-proof"]);
    if (result.source === "hosted") {
      expect(result.feed.sequence).toBe(2);
      expect(result.metadata).toMatchObject({
        status: 200,
        etag: '"next"',
        lastModified: "Mon, 22 Jun 2026 01:00:00 GMT",
      });
      expect(result.metadata.checksum).toMatch(/^sha256:[0-9a-f]{64}$/);
    }
  });

  it("falls back to the bundled catalog when hosted feed validation fails", async () => {
    const result = await loadHostedOfficialExternalPluginCatalogEntries({
      fetchImpl: vi.fn(
        async () =>
          new Response(JSON.stringify({ schemaVersion: 1, id: " ", entries: [] }), {
            status: 200,
          }),
      ),
    });

    expect(result.source).toBe("bundled-fallback");
    expect(result.entries.length).toBe(listOfficialExternalPluginCatalogEntries().length);
    if (result.source === "bundled-fallback") {
      expect(result.error).toContain("supported schema version");
      expect(result.metadata?.checksum).toMatch(/^sha256:[0-9a-f]{64}$/);
    }
  });

  it("falls back to the bundled catalog on HTTP 304 until a snapshot cache exists", async () => {
    const result = await loadHostedOfficialExternalPluginCatalogEntries({
      fetchImpl: vi.fn(
        async () =>
          new Response(null, {
            status: 304,
            headers: { etag: '"same"', "last-modified": "Mon, 22 Jun 2026 01:00:00 GMT" },
          }),
      ),
    });

    expect(result.source).toBe("bundled-fallback");
    if (result.source === "bundled-fallback") {
      expect(result.error).toContain("without a cached snapshot");
      expect(result.metadata).toMatchObject({
        status: 304,
        etag: '"same"',
        lastModified: "Mon, 22 Jun 2026 01:00:00 GMT",
      });
    }
  });

  it("falls back to the bundled catalog on checksum mismatch and oversized bodies", async () => {
    const mismatch = await loadHostedOfficialExternalPluginCatalogEntries({
      expectedSha256: "sha256:not-current",
      fetchImpl: vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              schemaVersion: 1,
              id: "openclaw-official-external-plugins",
              generatedAt: "2026-06-22T00:00:00.000Z",
              sequence: 1,
              entries: [],
            }),
            { status: 200 },
          ),
      ),
    });
    expect(mismatch.source).toBe("bundled-fallback");
    if (mismatch.source === "bundled-fallback") {
      expect(mismatch.error).toContain("checksum mismatch");
      expect(mismatch.metadata?.checksum).toMatch(/^sha256:[0-9a-f]{64}$/);
    }

    const oversized = await loadHostedOfficialExternalPluginCatalogEntries({
      maxBytes: 4,
      fetchImpl: vi.fn(async () => new Response("12345", { status: 200 })),
    });
    expect(oversized.source).toBe("bundled-fallback");
    if (oversized.source === "bundled-fallback") {
      expect(oversized.error).toContain("exceeds 4 bytes");
    }
  });

  it("lists the externalized provider and capability plugins with install metadata", () => {
    const providers = [
      ["arcee", "@openclaw/arcee-provider"],
      ["cerebras", "@openclaw/cerebras-provider"],
      ["chutes", "@openclaw/chutes-provider"],
      ["cloudflare-ai-gateway", "@openclaw/cloudflare-ai-gateway-provider"],
      ["deepinfra", "@openclaw/deepinfra-provider"],
      ["deepseek", "@openclaw/deepseek-provider"],
      ["groq", "@openclaw/groq-provider"],
      ["kilocode", "@openclaw/kilocode-provider"],
      ["kimi", "@openclaw/kimi-provider"],
      ["qianfan", "@openclaw/qianfan-provider"],
      ["qwen", "@openclaw/qwen-provider"],
    ] as const;
    const plugins = [
      ["exa", "@openclaw/exa-plugin"],
      ["firecrawl", "@openclaw/firecrawl-plugin"],
      ["gradium", "@openclaw/gradium-speech"],
      ["inworld", "@openclaw/inworld-speech"],
      ["parallel", "@openclaw/parallel-plugin"],
      ["perplexity", "@openclaw/perplexity-plugin"],
    ] as const;
    const newlyExternalized = [
      ["clickclack", "@openclaw/clickclack"],
      ["fireworks", "@openclaw/fireworks-provider"],
      ["irc", "@openclaw/irc"],
      ["mattermost", "@openclaw/mattermost"],
      ["moonshot", "@openclaw/moonshot-provider"],
      ["searxng", "@openclaw/searxng-plugin"],
      ["signal", "@openclaw/signal"],
      ["sms", "@openclaw/sms"],
      ["tavily", "@openclaw/tavily-plugin"],
      ["tencent", "@openclaw/tencent-provider"],
      ["venice", "@openclaw/venice-provider"],
      ["vercel-ai-gateway", "@openclaw/vercel-ai-gateway-provider"],
      ["zai", "@openclaw/zai-provider"],
    ] as const;

    for (const [id, npmSpec] of [...providers, ...plugins]) {
      expect(resolveOfficialExternalPluginInstall(expectCatalogEntry(id))).toEqual({
        clawhubSpec: `clawhub:${npmSpec}`,
        npmSpec,
        defaultChoice: "npm",
        minHostVersion: ">=2026.6.8",
      });
    }
    for (const [id, npmSpec] of newlyExternalized) {
      expect(resolveOfficialExternalPluginInstall(expectCatalogEntry(id))).toMatchObject({
        clawhubSpec: `clawhub:${npmSpec}`,
        npmSpec,
        defaultChoice: "npm",
        minHostVersion: ">=2026.6.9",
      });
    }
  });

  it("advertises StepFun with its ClawHub package and plugin API floor", () => {
    expect(resolveOfficialExternalPluginInstall(expectCatalogEntry("stepfun"))).toEqual({
      clawhubSpec: "clawhub:@openclaw/stepfun-provider",
      npmSpec: "@openclaw/stepfun-provider",
      defaultChoice: "npm",
      minHostVersion: ">=2026.6.9",
    });
  });

  it("resolves third-party channel lookup aliases to published plugin ids", () => {
    const wecomByChannel = expectCatalogEntry("wecom");
    const wecomByPlugin = expectCatalogEntry("wecom-openclaw-plugin");
    const yuanbaoByChannel = expectCatalogEntry("yuanbao");

    expect(resolveOfficialExternalPluginId(wecomByChannel)).toBe("wecom-openclaw-plugin");
    expect(resolveOfficialExternalPluginId(wecomByPlugin)).toBe("wecom-openclaw-plugin");
    expect(resolveOfficialExternalPluginInstall(wecomByChannel)?.npmSpec).toBe(
      "@wecom/wecom-openclaw-plugin@2026.5.7",
    );
    expect(resolveOfficialExternalPluginId(yuanbaoByChannel)).toBe("openclaw-plugin-yuanbao");
    expect(resolveOfficialExternalPluginInstall(yuanbaoByChannel)?.npmSpec).toBe(
      "openclaw-plugin-yuanbao@2.15.0",
    );
  });

  it("keeps official launch package specs on the production package names", () => {
    expect(resolveOfficialExternalPluginInstall(expectCatalogEntry("acpx"))?.npmSpec).toBe(
      "@openclaw/acpx",
    );
    expect(resolveOfficialExternalPluginInstall(expectCatalogEntry("googlechat"))?.npmSpec).toBe(
      "@openclaw/googlechat",
    );
    expect(resolveOfficialExternalPluginInstall(expectCatalogEntry("line"))?.npmSpec).toBe(
      "@openclaw/line",
    );
    expect(resolveOfficialExternalPluginInstall(expectCatalogEntry("diffs-language-pack"))).toEqual(
      {
        npmSpec: "@openclaw/diffs-language-pack",
        clawhubSpec: "clawhub:@openclaw/diffs-language-pack",
        defaultChoice: "npm",
        minHostVersion: ">=2026.5.27",
      },
    );
    expect(resolveOfficialExternalPluginInstall(expectCatalogEntry("llama-cpp"))?.npmSpec).toBe(
      "@openclaw/llama-cpp-provider",
    );
  });

  it("lists GMI Cloud as an official external provider", () => {
    const gmi = expectCatalogEntry("gmi");

    expect(resolveOfficialExternalPluginId(gmi)).toBe("gmi");
    expect(getOfficialExternalPluginCatalogEntry("gmi-cloud")).toBe(gmi);
    expect(resolveOfficialExternalPluginInstall(gmi)).toEqual({
      clawhubSpec: "clawhub:@openclaw/gmi-provider",
      npmSpec: "@openclaw/gmi-provider",
      defaultChoice: "npm",
      minHostVersion: ">=2026.6.8",
    });
  });

  it("lists Cohere as an official external provider", () => {
    const cohere = expectCatalogEntry("cohere");

    expect(resolveOfficialExternalPluginId(cohere)).toBe("cohere");
    expect(resolveOfficialExternalPluginInstall(cohere)).toEqual({
      clawhubSpec: "clawhub:@openclaw/cohere-provider",
      npmSpec: "@openclaw/cohere-provider",
      defaultChoice: "npm",
      minHostVersion: ">=2026.6.8",
    });
  });

  it("resolves external provider aliases beyond the primary provider id", () => {
    const qwen = expectCatalogEntry("qwen");

    expect(getOfficialExternalPluginCatalogEntry("modelstudio")).toBe(qwen);
    expect(getOfficialExternalPluginCatalogEntry("qwen-oauth")).toBe(qwen);
    expect(getOfficialExternalPluginCatalogEntry("qwen-portal")).toBe(qwen);
  });

  it("maps external speech and web-fetch contracts to plugin owners", () => {
    expect(
      resolveOfficialExternalProviderContractPluginIds({
        contract: "speechProviders",
        providerIds: new Set(["gradium", "inworld"]),
      }),
    ).toEqual(["gradium", "inworld"]);
    expect(
      resolveOfficialExternalProviderContractPluginIds({
        contract: "webFetchProviders",
        providerIds: new Set(["firecrawl"]),
      }),
    ).toEqual(["firecrawl"]);
    expect(
      resolveOfficialExternalProviderContractPluginIds({
        contract: "mediaUnderstandingProviders",
        providerIds: new Set(["groq", "moonshot", "zai"]),
      }),
    ).toEqual(["groq", "moonshot", "zai"]);
  });

  it("maps env-only web-fetch credentials to external plugin owners", () => {
    expect(
      resolveOfficialExternalWebProviderContractPluginIdsForEnv({
        contract: "webFetchProviders",
        env: { FIRECRAWL_API_KEY: "firecrawl-key" },
      }),
    ).toEqual(["firecrawl"]);
    expect(
      resolveOfficialExternalWebProviderContractPluginIdsForEnv({
        contract: "webFetchProviders",
        env: { EXA_API_KEY: "exa-key" },
      }),
    ).toEqual([]);
  });

  it("maps configured provider ids and aliases even without an auth choice", () => {
    expect(
      resolveOfficialExternalProviderPluginIds({
        providerIds: new Set(["groq", "modelstudio"]),
      }),
    ).toEqual(["groq", "qwen"]);
  });

  it("maps env-only provider credentials to external installs", () => {
    expect(
      resolveOfficialExternalProviderPluginIdsForEnv({
        ARCEEAI_API_KEY: "arcee-key",
        CEREBRAS_API_KEY: "cerebras-key",
        CHUTES_OAUTH_TOKEN: "chutes-token",
        CLOUDFLARE_AI_GATEWAY_API_KEY: "cloudflare-key",
        DEEPINFRA_API_KEY: "deepinfra-key",
        DEEPSEEK_API_KEY: "deepseek-key",
        GROQ_API_KEY: "groq-key",
        KILOCODE_API_KEY: "kilocode-key",
        KIMICODE_API_KEY: "kimi-key",
        KIMI_API_KEY: "moonshot-kimi-key",
        MOONSHOT_API_KEY: "moonshot-key",
        QIANFAN_API_KEY: "qianfan-key",
        MODELSTUDIO_API_KEY: "qwen-key",
        STEPFUN_API_KEY: "stepfun-key",
        FIREWORKS_API_KEY: "fireworks-key",
        TOKENHUB_API_KEY: "tokenhub-key",
        VENICE_API_KEY: "venice-key",
        AI_GATEWAY_API_KEY: "gateway-key",
        ZAI_API_KEY: "zai-key",
      }),
    ).toEqual([
      "arcee",
      "cerebras",
      "chutes",
      "cloudflare-ai-gateway",
      "deepinfra",
      "deepseek",
      "fireworks",
      "groq",
      "kilocode",
      "kimi",
      "moonshot",
      "qianfan",
      "qwen",
      "stepfun",
      "tencent",
      "venice",
      "vercel-ai-gateway",
      "zai",
    ]);
    expect(resolveOfficialExternalProviderPluginIdsForEnv({ GROQ_API_KEY: " " })).toEqual([]);
  });

  it("keeps Groq available through the cold-install auth catalog", () => {
    const groq = expectCatalogEntry("groq");
    const authChoice = groq.openclaw?.providers?.find((provider) => provider.id === "groq")
      ?.authChoices?.[0];

    expect(authChoice).toMatchObject({
      choiceId: "groq-api-key",
      optionKey: "groqApiKey",
      cliFlag: "--groq-api-key",
      cliOption: "--groq-api-key <key>",
    });
  });

  it("allows invalid-config recovery for externalized stock plugins", () => {
    expect(resolveOfficialExternalPluginInstall(expectCatalogEntry("brave"))).toMatchObject({
      npmSpec: "@openclaw/brave-plugin",
      allowInvalidConfigRecovery: true,
    });
    expect(resolveOfficialExternalPluginInstall(expectCatalogEntry("slack"))).toMatchObject({
      npmSpec: "@openclaw/slack",
      allowInvalidConfigRecovery: true,
    });
    expect(resolveOfficialExternalPluginInstall(expectCatalogEntry("discord"))).toMatchObject({
      npmSpec: "@openclaw/discord",
      allowInvalidConfigRecovery: true,
    });
    expect(resolveOfficialExternalPluginInstall(expectCatalogEntry("mattermost"))).toMatchObject({
      npmSpec: "@openclaw/mattermost",
      allowInvalidConfigRecovery: true,
    });
    expect(resolveOfficialExternalPluginInstall(expectCatalogEntry("tavily"))).toMatchObject({
      npmSpec: "@openclaw/tavily-plugin",
      allowInvalidConfigRecovery: true,
    });
  });

  it("lists Matrix as an official external ClawHub channel after cutover", () => {
    const ids = new Set<string>();
    for (const entry of listOfficialExternalPluginCatalogEntries()) {
      const pluginId = resolveOfficialExternalPluginId(entry);
      if (pluginId) {
        ids.add(pluginId);
      }
    }

    expect(ids.has("matrix")).toBe(true);
    expect(ids.has("mattermost")).toBe(true);
    expect(resolveOfficialExternalPluginInstall(expectCatalogEntry("matrix"))).toEqual({
      clawhubSpec: "clawhub:@openclaw/matrix",
      npmSpec: "@openclaw/matrix",
      defaultChoice: "clawhub",
      minHostVersion: ">=2026.4.10",
      allowInvalidConfigRecovery: true,
    });
  });
});
