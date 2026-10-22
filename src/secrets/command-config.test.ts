import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveConfigForRead } from "../config/io.read-helpers.js";
import {
  cloneConfigWithResolutionFacts,
  copyConfigResolutionFactsExcept,
  setConfigResolutionFacts,
} from "../config/resolution-facts.js";
import {
  buildTalkTestProviderConfig,
  TALK_TEST_PROVIDER_API_KEY_PATH,
  TALK_TEST_PROVIDER_API_KEY_PATH_SEGMENTS,
} from "../test-utils/talk-test-provider.js";
import { analyzeCommandSecretAssignmentsFromSnapshot } from "./command-config.js";

const talkPath = {
  path: TALK_TEST_PROVIDER_API_KEY_PATH,
  pathSegments: [...TALK_TEST_PROVIDER_API_KEY_PATH_SEGMENTS],
};
function analyzeTalk(sourceConfig: OpenClawConfig, resolvedConfig: OpenClawConfig) {
  return analyzeCommandSecretAssignmentsFromSnapshot({
    sourceConfig,
    resolvedConfig,
    targetIds: new Set(["talk.providers.*.apiKey"]),
  });
}
function readSource(config: OpenClawConfig, env = {}) {
  const read = resolveConfigForRead(config, env);
  const sourceConfig = read.resolvedConfigRaw as OpenClawConfig;
  setConfigResolutionFacts(sourceConfig, read.resolutionFacts);
  return sourceConfig;
}

describe("analyzeCommandSecretAssignmentsFromSnapshot", () => {
  it("reports configured refs that are unresolved in the snapshot", () => {
    const sourceConfig = buildTalkTestProviderConfig({
      source: "env",
      provider: "default",
      id: "TALK_API_KEY",
    });
    const resolvedConfig = buildTalkTestProviderConfig(undefined);

    expect(analyzeTalk(sourceConfig, resolvedConfig).unresolved).toEqual([talkPath]);
  });

  it("reports unresolved refs under a bracket-quoted provider key", () => {
    const config = {
      talk: { providers: { "acme.speech": { apiKey: "${TALK_API_KEY}" } } },
    } as OpenClawConfig;
    const sourceConfig = readSource(config);
    const result = analyzeTalk(sourceConfig, sourceConfig);

    expect(result.unresolved).toEqual([
      {
        path: 'talk.providers["acme.speech"].apiKey',
        pathSegments: ["talk", "providers", "acme.speech", "apiKey"],
      },
    ]);
  });

  it.each([
    ["unresolved bare shorthand", "$MISSING", {}, true],
    ["unresolved braced shorthand", "${MISSING}", {}, true],
    ["substituted braced-looking literal", "${SOURCE}", { SOURCE: "${OTHER}" }, false],
    ["escaped template literal", "$${OTHER}", {}, false],
  ] as const)(
    "keeps command assignments source-authoritative: %s",
    (_name, authored, env, unresolved) => {
      const sourceConfig = readSource(buildTalkTestProviderConfig(authored), env);
      const resolvedConfig = cloneConfigWithResolutionFacts(sourceConfig);
      const result = analyzeTalk(sourceConfig, resolvedConfig);

      expect(result.assignments).toEqual([]);
      expect(result.unresolved).toEqual(unresolved ? [talkPath] : []);
    },
  );

  it("accepts a materialized shorthand whose literal still resembles a reference", () => {
    const sourceConfig = readSource(buildTalkTestProviderConfig("$SOURCE"));
    const resolvedConfig = buildTalkTestProviderConfig("${OTHER}");
    copyConfigResolutionFactsExcept(sourceConfig, resolvedConfig, [
      TALK_TEST_PROVIDER_API_KEY_PATH,
    ]);

    const result = analyzeTalk(sourceConfig, resolvedConfig);

    expect(result.unresolved).toEqual([]);
    expect(result.assignments).toEqual([
      expect.objectContaining({ path: TALK_TEST_PROVIDER_API_KEY_PATH, value: "${OTHER}" }),
    ]);
  });

  it("skips unresolved refs that are marked inactive by runtime warnings", () => {
    const apiKey = { source: "env", provider: "default", id: "DEFAULT_MEMORY_KEY" };
    const sourceConfig = {
      memory: { search: { remote: { apiKey } } },
      agents: { defaults: {} },
    } as unknown as OpenClawConfig;
    const resolvedConfig = structuredClone(sourceConfig);

    const result = analyzeCommandSecretAssignmentsFromSnapshot({
      sourceConfig,
      resolvedConfig,
      targetIds: new Set(["memory.search.remote.apiKey"]),
      inactiveRefPaths: new Set(["memory.search.remote.apiKey"]),
    });

    expect(result.assignments).toStrictEqual([]);
    expect(result.diagnostics).toEqual([
      "memory.search.remote.apiKey: secret ref is configured on an inactive surface; skipping command-time assignment.",
    ]);
  });
});
