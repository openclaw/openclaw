import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import officialExternalPluginCatalog from "../../scripts/lib/official-external-plugin-catalog.json" with { type: "json" };
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { createSqliteHostedOfficialExternalPluginCatalogSnapshotStore } from "./official-external-plugin-catalog-snapshot-store.js";
import {
  type OfficialExternalPluginCatalogEntry,
  getOfficialExternalPluginCatalogEntry,
  getOfficialExternalPluginCatalogManifest,
  isOfficialExternalPluginCatalogFeed,
  listOfficialExternalPluginCatalogEntries,
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

  it("curates featured external plugins with ClawHub install alternatives", () => {
    const featured = [
      ["diffs", "@openclaw/diffs", 40],
      ["lobster", "@openclaw/lobster", 50],
      ["tokenjuice", "@openclaw/tokenjuice", 60],
      ["memory-lancedb", "@openclaw/memory-lancedb", 70],
    ] as const;

    for (const [id, npmSpec, order] of featured) {
      const entry = expectCatalogEntry(id);
      expect(getOfficialExternalPluginCatalogManifest(entry)?.catalog).toEqual({
        featured: true,
        order,
      });
      expect(resolveOfficialExternalPluginInstall(entry)).toMatchObject({
        clawhubSpec: `clawhub:${npmSpec}`,
        npmSpec,
        defaultChoice: "npm",
      });
    }
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
        schemaVersion: 2,
        id: "openclaw-official-external-plugins",
        generatedAt: "2026-06-22T00:00:00.000Z",
        sequence: 1,
        entries: [],
      }),
    ).toBe(true);
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

  it("reads and updates hosted catalog snapshots in the SQLite store", async () => {
    const stateDir = mkdtempSync(path.join(os.tmpdir(), "openclaw-hosted-store-"));
    try {
      const store = createSqliteHostedOfficialExternalPluginCatalogSnapshotStore({ stateDir });
      const url = "https://clawhub.ai/v1/feeds/plugins";

      const firstBody = JSON.stringify({ entries: [] });
      const secondBody = JSON.stringify({ entries: [{}] });

      await expect(store.read(url)).resolves.toBeNull();
      await store.write({
        body: firstBody,
        metadata: {
          url,
          status: 200,
          etag: '"first"',
          checksum: "sha256:first",
        },
        savedAt: "2026-06-22T02:03:04.000Z",
      });
      await store.write({
        body: secondBody,
        metadata: {
          url,
          status: 200,
          lastModified: "Mon, 22 Jun 2026 03:00:00 GMT",
          checksum: "sha256:second",
        },
        savedAt: "2026-06-22T03:04:05.000Z",
        trust: {
          mode: "signed",
          signedBy: "acme-root",
          signatureCount: 1,
          threshold: 1,
          verifiedAt: "2026-06-22T03:04:05.000Z",
        },
      });

      await expect(store.read(url)).resolves.toMatchObject({
        body: secondBody,
        metadata: {
          url,
          status: 200,
          lastModified: "Mon, 22 Jun 2026 03:00:00 GMT",
          checksum: "sha256:second",
        },
        savedAt: "2026-06-22T03:04:05.000Z",
        trust: {
          mode: "signed",
          signedBy: "acme-root",
          signatureCount: 1,
          threshold: 1,
          verifiedAt: "2026-06-22T03:04:05.000Z",
        },
      });
    } finally {
      closeOpenClawStateDatabaseForTest();
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("prefers feed install candidates before legacy install metadata", () => {
    expect(
      resolveOfficialExternalPluginInstall({
        name: "@legacy/plain-package",
        kind: "plugin",
        state: "available",
        publisher: { id: "openclaw", trust: "official" },
        install: {
          candidates: [
            {
              sourceRef: "public-clawhub",
              package: "@openclaw/candidate-package",
              version: "1.2.3",
              integrity: "sha256:b355dda04403becaab8bbab069fd1e7b0578262e7459e598cc5b19615b5bdab9",
            },
          ],
        },
        openclaw: {
          plugin: { id: "candidate-package" },
          install: {
            npmSpec: "@legacy/plain-package",
            minHostVersion: ">=2026.6.1",
            expectedIntegrity: "sha256:manifest",
            allowInvalidConfigRecovery: true,
          },
        },
      }),
    ).toEqual({
      clawhubSpec: "clawhub:@openclaw/candidate-package@1.2.3",
      defaultChoice: "clawhub",
      expectedIntegrity: "sha256-s1XdoEQDvsqri7qwaf0eewV4Ji50WeWYzFsZYVtb2rk=",
      minHostVersion: ">=2026.6.1",
      allowInvalidConfigRecovery: true,
    });

    expect(
      resolveOfficialExternalPluginInstall(
        {
          name: "@acme/private-package",
          kind: "plugin",
          state: "available",
          publisher: { id: "acme", trust: "official" },
          install: {
            candidates: [
              { sourceRef: "acme-npm", package: "@acme/private-package", version: "4.5.6" },
            ],
          },
        },
        { catalogConfig: { sources: { "acme-npm": { type: "npm" } } } },
      ),
    ).toEqual({
      npmSpec: "@acme/private-package@4.5.6",
      defaultChoice: "npm",
    });

    expect(
      resolveOfficialExternalPluginInstall(
        {
          name: "@acme/private-sha-package",
          kind: "plugin",
          state: "available",
          publisher: { id: "acme", trust: "official" },
          install: {
            candidates: [
              {
                sourceRef: "acme-npm",
                package: "@acme/private-sha-package",
                version: "4.5.6",
                integrity:
                  "sha256:b355dda04403becaab8bbab069fd1e7b0578262e7459e598cc5b19615b5bdab9",
              },
            ],
          },
        },
        { catalogConfig: { sources: { "acme-npm": { type: "npm" } } } },
      ),
    ).toEqual({ npmSpec: "@acme/private-sha-package@4.5.6", defaultChoice: "npm" });

    expect(
      resolveOfficialExternalPluginInstall(
        {
          name: "@acme/private-sri-package",
          kind: "plugin",
          state: "available",
          publisher: { id: "acme", trust: "official" },
          install: {
            candidates: [
              {
                sourceRef: "acme-npm",
                package: "@acme/private-sri-package",
                version: "4.5.6",
                integrity: "sha512-abc=",
              },
            ],
          },
        },
        { catalogConfig: { sources: { "acme-npm": { type: "npm" } } } },
      ),
    ).toEqual({
      npmSpec: "@acme/private-sri-package@4.5.6",
      defaultChoice: "npm",
      expectedIntegrity: "sha512-abc=",
    });

    expect(
      resolveOfficialExternalPluginInstall(
        {
          name: "git-only-package",
          kind: "plugin",
          install: {
            candidates: [{ sourceRef: "acme-git", package: "git@example.com:acme/plugin.git" }],
          },
        },
        { catalogConfig: { sources: { "acme-git": { type: "git" } } } },
      ),
    ).toBeNull();

    expect(
      resolveOfficialExternalPluginInstall({ id: "metadata-only", title: "Metadata only" }),
    ).toBeNull();
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
      ["longcat", "@openclaw/longcat-provider"],
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
    const currentExternalized = [["featherless", "@openclaw/featherless-provider"]] as const;

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
    for (const [id, npmSpec] of currentExternalized) {
      expect(resolveOfficialExternalPluginInstall(expectCatalogEntry(id))).toEqual({
        clawhubSpec: `clawhub:${npmSpec}`,
        npmSpec,
        defaultChoice: "npm",
        minHostVersion: ">=2026.6.11",
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

  it("lists LongCat as an official external provider", () => {
    const longcat = expectCatalogEntry("longcat");

    expect(resolveOfficialExternalPluginId(longcat)).toBe("longcat");
    expect(getOfficialExternalPluginCatalogEntry("meituan-longcat")).toBe(longcat);
    expect(resolveOfficialExternalPluginInstall(longcat)).toEqual({
      clawhubSpec: "clawhub:@openclaw/longcat-provider",
      npmSpec: "@openclaw/longcat-provider",
      defaultChoice: "npm",
      minHostVersion: ">=2026.6.8",
    });
  });

  it("resolves external provider aliases beyond the primary provider id", () => {
    const qwen = expectCatalogEntry("qwen");

    expect(getOfficialExternalPluginCatalogEntry("modelstudio")).toBe(qwen);
    expect(getOfficialExternalPluginCatalogEntry("qwen-oauth")).toBe(qwen);
    expect(getOfficialExternalPluginCatalogEntry("qwen-portal")).toBe(qwen);
    expect(getOfficialExternalPluginCatalogEntry("qwen-token-plan")).toBe(qwen);
    expect(getOfficialExternalPluginCatalogEntry("bailian-token-plan")).toBe(qwen);
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
        FEATHERLESS_API_KEY: "featherless-key",
        GROQ_API_KEY: "groq-key",
        LONGCAT_API_KEY: "longcat-key",
        KILOCODE_API_KEY: "kilocode-key",
        KIMICODE_API_KEY: "kimi-key",
        KIMI_API_KEY: "moonshot-kimi-key",
        MOONSHOT_API_KEY: "moonshot-key",
        QIANFAN_API_KEY: "qianfan-key",
        MODELSTUDIO_API_KEY: "qwen-key",
        STEPFUN_API_KEY: "stepfun-key",
        FIREWORKS_API_KEY: "fireworks-key",
        TOKENHUB_API_KEY: "tokenhub-key",
        TOKENPLAN_API_KEY: "tokenplan-key",
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
      "featherless",
      "fireworks",
      "groq",
      "kilocode",
      "kimi",
      "longcat",
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
    expect(resolveOfficialExternalProviderPluginIdsForEnv({ LONGCAT_API_KEY: " " })).toEqual([]);
  });

  it("keeps Tencent auth choices available through the cold-install auth catalog", () => {
    const tencent = expectCatalogEntry("tencent");
    const tokenHub = tencent.openclaw?.providers?.find(
      (provider) => provider.id === "tencent-tokenhub",
    );
    const tokenPlan = tencent.openclaw?.providers?.find(
      (provider) => provider.id === "tencent-tokenplan",
    );

    expect(tokenHub?.envVars).toEqual(["TOKENHUB_API_KEY"]);
    expect(tokenHub?.authChoices).toEqual([
      expect.objectContaining({
        choiceId: "tokenhub-api-key",
        optionKey: "tokenhubApiKey",
        cliFlag: "--tokenhub-api-key",
      }),
    ]);
    expect(tokenPlan?.envVars).toEqual(["TOKENPLAN_API_KEY"]);
    expect(tokenPlan?.authChoices?.[0]).toMatchObject({
      choiceId: "tokenplan-api-key",
      optionKey: "tokenplanApiKey",
      cliFlag: "--tokenplan-api-key",
    });
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
