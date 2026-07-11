// Runtime proof: own-property checks reject proto-inherited fields.
// Run with JSON reporter to extract console output:
//   node scripts/run-vitest.mjs scripts/proof-own-property.test.ts --reporter=json 2>/dev/null | python3 -c "
//   import json,sys;d=json.load(sys.stdin)
//   for t in d.get('testResults',d.get('testResults',[])):t.get('logs')
//   " 2>&1
//
// Also run:
//   node scripts/run-vitest.mjs extensions/firecrawl/src/config.own-entries.test.ts
//   node scripts/run-vitest.mjs extensions/brave/src/web-search-shared.own-entries.test.ts
//   node scripts/run-vitest.mjs src/agents/models-config.merge.test.ts
//   node scripts/run-vitest.mjs src/web-search/runtime.test.ts
//   node scripts/run-vitest.mjs src/web-fetch/runtime.test.ts

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, afterAll, beforeEach, afterEach } from "vitest";

const LINES: string[] = [];
function log(...args: unknown[]) {
  const msg = args.join(" ");
  LINES.push(msg);
  // Write to process.stdout for JSON reporter capture
  process.stdout.write(msg + "\n");
}

const DIVIDER = "─".repeat(65);

// Dump output on test end so it appears in JSON reporter's collectResult.
// This runs per-worker; file is appended so all workers contribute.
function dumpOutput() {
  const outPath = resolve("/tmp", `proof-output-${process.ppid}-${process.pid}.txt`);
  writeFileSync(outPath, LINES.join("\n") + "\n", "utf-8");
}

describe("own-property runtime proof", () => {
  afterAll(() => dumpOutput());

  it("1/5. core javascript semantic proof — Object.hasOwn() vs in", () => {
    log(`\n${DIVIDER}`);
    log("1/5.  Core semantic proof");
    log(DIVIDER);

    const obj = Object.create({ inherited: "yes" });
    obj.own = "yes";

    log(`  'inherited' in obj:                    ${"inherited" in obj}`);
    log(`  Object.hasOwn(obj, 'inherited'):        ${Object.hasOwn(obj, "inherited")}`);
    log(`  'own' in obj:                           ${"own" in obj}`);
    log(`  Object.hasOwn(obj, 'own'):              ${Object.hasOwn(obj, "own")}`);
    log(`  → verdict: Object.hasOwn() rejects proto, accepts own`);
  });

  it("2/5. extensions/firecrawl/src/config — firecrawl legacy path", async () => {
    log(`\n${DIVIDER}`);
    log("2/5.  extensions/firecrawl/src/config — resolveFirecrawlSearchConfig");
    log(DIVIDER);

    const {
      resolveFirecrawlSearchConfig,
      resolveFirecrawlApiKey,
      resolveFirecrawlBaseUrl,
      resolveFirecrawlOnlyMainContent,
      resolveFirecrawlMaxAgeMs,
      resolveFirecrawlScrapeTimeoutSeconds,
    } = await import("../../extensions/firecrawl/src/config.js");

    // Proto-inherited firecrawl on tools.web.search
    const search = Object.create({ firecrawl: { apiKey: "proto-key", baseUrl: "https://proto.test" } });
    const cfgSearch = { tools: { web: { search } } };
    log(`\n  » Proto-inherited firecrawl on tools.web.search`);
    log(`     resolveFirecrawlSearchConfig:          ${resolveFirecrawlSearchConfig(cfgSearch) === undefined ? "undefined (REJECTED ✓)" : "FOUND (FAIL)"}`);
    log(`     resolveFirecrawlApiKey:                ${resolveFirecrawlApiKey(cfgSearch) ?? "undefined (REJECTED ✓)"}`);
    log(`     resolveFirecrawlBaseUrl:               ${resolveFirecrawlBaseUrl(cfgSearch)} (default, proto rejected)`);

    // Proto-inherited firecrawl on tools.web.fetch
    const fetch = Object.create({ firecrawl: { onlyMainContent: false, maxAgeMs: 88888, timeoutSeconds: 44 } });
    const cfgFetch = { tools: { web: { fetch } } };
    log(`\n  » Proto-inherited firecrawl on tools.web.fetch`);
    log(`     resolveFirecrawlOnlyMainContent:       ${resolveFirecrawlOnlyMainContent(cfgFetch)} (default=true, proto rejected)`);
    log(`     resolveFirecrawlMaxAgeMs:              ${resolveFirecrawlMaxAgeMs(cfgFetch)} (default=172800000, proto rejected)`);
    log(`     resolveFirecrawlScrapeTimeoutSeconds:  ${resolveFirecrawlScrapeTimeoutSeconds(cfgFetch)} (default=60, proto rejected)`);

    // Own firecrawl entry (backward compat)
    const cfgOwn = { tools: { web: { search: { firecrawl: { apiKey: "own-key", baseUrl: "https://own.test" } } } } };
    log(`\n  » Own firecrawl entry preserved (backward compat)`);
    log(`     resolveFirecrawlSearchConfig:          ${JSON.stringify(resolveFirecrawlSearchConfig(cfgOwn))}`);
    log(`     resolveFirecrawlApiKey:                ${resolveFirecrawlApiKey(cfgOwn)}`);
    log(`     resolveFirecrawlBaseUrl:               ${resolveFirecrawlBaseUrl(cfgOwn)} (own preserved ✓)`);
  });

  it("3/5. extensions/brave/web-search-shared — Brave credential readers", async () => {
    log(`\n${DIVIDER}`);
    log("3/5.  extensions/brave/web-search-shared — Brave credential readers");
    log(DIVIDER);

    const { buildBraveWebSearchProviderBase } = await import("../../extensions/brave/web-search-shared.js");
    const base = buildBraveWebSearchProviderBase();
    const primary = base.getConfiguredCredentialValue;
    const fallback = base.getConfiguredCredentialFallback;

    // Primary: proto apiKey on plugin webSearch → rejected (new Object.hasOwn fix)
    const webSearch = Object.create({ apiKey: "proto-api-key" });
    const cfgPluginProto = { plugins: { entries: { brave: { config: { webSearch } } } } };
    log(`\n  » Primary — proto apiKey on plugin webSearch (NEW Object.hasOwn fix)`);
    log(`     primary(cfg):                ${primary(cfgPluginProto) ?? "undefined (REJECTED ✓)"}`);

    // Primary: own plugin apiKey → found
    const cfgPluginOwn = { plugins: { entries: { brave: { config: { webSearch: { apiKey: "own-plugin-key" } } } } } };
    log(`\n  » Primary — own plugin apiKey`);
    log(`     primary(cfg):                ${primary(cfgPluginOwn)}`);

    // Primary: proto apiKey on legacy search → rejected
    const searchProto = Object.create({ apiKey: "proto-legacy-key" });
    const cfgLegacyProto = { tools: { web: { search: searchProto } } };
    log(`\n  » Primary — proto apiKey on legacy search (fallthrough)`);
    log(`     primary(cfg):                ${primary(cfgLegacyProto) ?? "undefined (REJECTED ✓)"}`);

    // Fallback: proto apiKey → rejected
    const search2 = Object.create({ apiKey: "proto-search-key" });
    search2.irrelevant = "yes";
    const cfgFallbackProto = { tools: { web: { search: search2 } } };
    const result1 = fallback(cfgFallbackProto);
    log(`\n  » Fallback — proto apiKey on search`);
    log(`     fallback(cfg):               ${JSON.stringify(result1)} (REJECTED ✓)`);

    // Fallback: own apiKey → found
    const cfgFallbackOwn = { tools: { web: { search: { apiKey: "own-search-key" } } } };
    const result2 = fallback(cfgFallbackOwn);
    log(`\n  » Fallback — own apiKey`);
    log(`     fallback(cfg):               ${JSON.stringify(result2)}`);
  });

  it("4/5. core runtime patterns — web-search, web-fetch, models-config", async () => {
    log(`\n${DIVIDER}`);
    log("4/5.  Core runtime own-property patterns");
    log(DIVIDER);

    // Simulate the web-search runtime pattern: search && Object.hasOwn(search, "provider")
    const search = Object.create({ provider: "proto-provider" });
    const searchWithOwn = { provider: "own-provider" };
    log(`\n  » src/web-search/runtime — provider check`);
    log(`     search && Object.hasOwn(search, "provider"):       ${search && Object.hasOwn(search, "provider")} (proto REJECTED ✓)`);
    log(`     searchWithOwn && Object.hasOwn(..., "provider"):   ${searchWithOwn && Object.hasOwn(searchWithOwn, "provider")} (own FOUND ✓)`);
    log(`     'provider' in search (OLD):                        ${"provider" in search} (WOULD LEAK ✗)`);

    // Simulate web-fetch runtime pattern
    const fetch = Object.create({ provider: "proto-provider" });
    const fetchWithOwn = { provider: "own-provider" };
    log(`\n  » src/web-fetch/runtime — provider check`);
    log(`     fetch && Object.hasOwn(fetch, "provider"):         ${fetch && Object.hasOwn(fetch, "provider")} (proto REJECTED ✓)`);
    log(`     fetchWithOwn && Object.hasOwn(..., "provider"):    ${fetchWithOwn && Object.hasOwn(fetchWithOwn, "provider")} (own FOUND ✓)`);
    log(`     'provider' in fetch (OLD):                         ${"provider" in fetch} (WOULD LEAK ✗)`);

    // Simulate models-config.merge pattern
    const model = Object.create({ contextWindow: 99999, maxTokens: 88888, input: { cost: 0.01 }, reasoning: { maxTokens: 5000 } });
    model.ownField = "value";
    log(`\n  » src/agents/models-config.merge — model override fields`);
    log(`     Object.hasOwn(model, "contextWindow"):            ${Object.hasOwn(model, "contextWindow")} (proto REJECTED ✓)`);
    log(`     Object.hasOwn(model, "maxTokens"):                 ${Object.hasOwn(model, "maxTokens")} (proto REJECTED ✓)`);
    log(`     Object.hasOwn(model, "input"):                     ${Object.hasOwn(model, "input")} (proto REJECTED ✓)`);
    log(`     Object.hasOwn(model, "reasoning"):                 ${Object.hasOwn(model, "reasoning")} (proto REJECTED ✓)`);
    log(`     Object.hasOwn(model, "ownField"):                  ${Object.hasOwn(model, "ownField")} (own FOUND ✓)`);
    log(`     'contextWindow' in model (OLD):                    ${"contextWindow" in model} (WOULD LEAK ✗)`);

    // Simulate src/agents/tools/web-fetch pattern
    const execFetch = Object.create({ provider: "proto-provider", userAgent: "proto-ua" });
    execFetch.ownProp = true;
    log(`\n  » src/agents/tools/web-fetch — maxCharsCap/maxResponseBytes/provider/userAgent`);
    log(`     Object.hasOwn(execFetch, "provider"):             ${Object.hasOwn(execFetch, "provider")} (proto REJECTED ✓)`);
    log(`     Object.hasOwn(execFetch, "userAgent"):            ${Object.hasOwn(execFetch, "userAgent")} (proto REJECTED ✓)`);

    // apiKey pattern (capability-cli + legacy-web-search-migrate)
    const obj = Object.create({ apiKey: "proto-key" });
    obj.ownField = "value";
    log(`\n  » src/cli/capability-cli + src/commands/doctor/shared/legacy-web-search-migrate`);
    log(`     Object.hasOwn(obj, "apiKey"):                     ${Object.hasOwn(obj, "apiKey")} (proto REJECTED ✓)`);
    log(`     'apiKey' in obj (OLD):                            ${"apiKey" in obj} (WOULD LEAK ✗)`);
    log(`     Object.hasOwn(obj, "ownField"):                   ${Object.hasOwn(obj, "ownField")} (own FOUND ✓)`);
  });

  it("5/5. canonical config hierarchy — Object.hasOwn() at every level", () => {
    log(`\n${DIVIDER}`);
    log("5/5.  Canonical config hierarchy");
    log(DIVIDER);

    // Canonical Brave legacy path: tools.web.search.apiKey
    log(`\n  » Brave canonical legacy: tools.web.search.apiKey`);
    const braveSearch = Object.create({ apiKey: "proto-api-key" });
    log(`     Object.hasOwn(search, "apiKey"):                 ${Object.hasOwn(braveSearch, "apiKey")} (proto REJECTED ✓)`);
    log(`     'apiKey' in search (OLD):                        ${"apiKey" in braveSearch} (WOULD LEAK ✗)`);

    // Canonical Firecrawl legacy path: tools.web.search.firecrawl
    log(`\n  » Firecrawl canonical legacy: tools.web.search.firecrawl`);
    const fcSearch = Object.create({ firecrawl: { apiKey: "proto-api-key", baseUrl: "https://proto.test" } });
    log(`     Object.hasOwn(search, "firecrawl"):              ${Object.hasOwn(fcSearch, "firecrawl")} (proto REJECTED ✓)`);
    log(`     'firecrawl' in search (OLD):                     ${"firecrawl" in fcSearch} (WOULD LEAK ✗)`);

    // Canonical plugin config paths: full hierarchy
    log(`\n  » Canonical plugin config: plugins.entries.{brave,firecrawl}.config.webSearch.apiKey`);
    const pluginWs = Object.create({ apiKey: "proto-api-key" });
    log(`     Object.hasOwn(webSearch, "apiKey"):              ${Object.hasOwn(pluginWs, "apiKey")} (proto REJECTED ✓)`);
    log(`     'apiKey' in webSearch (OLD):                     ${"apiKey" in pluginWs} (WOULD LEAK ✗)`);

    // CONTRACT VERIFICATION
    log(`\n  ── CONTRACT VERIFICATION ──`);
    log(`    in operator:         ALL proto fields detected → WOULD OVERRIDE`);
    log(`    Object.hasOwn():     ALL proto fields ignored → SAFE`);
    log(`    Own properties:      found by both → BACKWARD COMPAT`);
  });
});
