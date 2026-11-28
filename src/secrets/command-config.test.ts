import { expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveConfigForRead } from "../config/io.read-helpers.js";
import {
  cloneConfigWithResolutionFacts,
  copyConfigResolutionFactsExcept,
  setConfigResolutionFacts,
} from "../config/resolution-facts.js";
import {
  buildTalkTestProviderConfig,
  TALK_TEST_PROVIDER_API_KEY_PATH as keyPath,
  TALK_TEST_PROVIDER_API_KEY_PATH_SEGMENTS as keySegments,
} from "../test-utils/talk-test-provider.js";
import { analyzeCommandSecretAssignmentsFromSnapshot } from "./command-config.js";

const talkPath = { path: keyPath, pathSegments: [...keySegments] };
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

it("quotes dotted provider keys in unresolved paths", () => {
  const sourceConfig = readSource({
    talk: { providers: { "acme.speech": { apiKey: "${TALK_API_KEY}" } } },
  } as OpenClawConfig);
  const result = analyzeTalk(sourceConfig, sourceConfig);

  expect(result.unresolved).toEqual([
    {
      path: 'talk.providers["acme.speech"].apiKey',
      pathSegments: ["talk", "providers", "acme.speech", "apiKey"],
    },
  ]);
});

it.each([
  ["explicit ref", { source: "env", provider: "default", id: "TALK_API_KEY" }, {}, true],
  ["unresolved bare shorthand", "$MISSING", {}, true],
  ["unresolved braced shorthand", "${MISSING}", {}, true],
  ["substituted braced-looking literal", "${SOURCE}", { SOURCE: "${OTHER}" }, false],
  ["escaped template literal", "$${OTHER}", {}, false],
] as const)(
  "keeps command assignments source-authoritative: %s",
  (_name, authored, env, unresolved) => {
    const sourceConfig = readSource(buildTalkTestProviderConfig(authored), env);
    const resolvedConfig =
      typeof authored === "object"
        ? buildTalkTestProviderConfig(undefined)
        : cloneConfigWithResolutionFacts(sourceConfig);
    const result = analyzeTalk(sourceConfig, resolvedConfig);

    expect([result.assignments, result.unresolved]).toEqual([[], unresolved ? [talkPath] : []]);
  },
);

it("accepts materialized reference-looking literals", () => {
  const sourceConfig = readSource(buildTalkTestProviderConfig("$SOURCE"));
  const resolvedConfig = buildTalkTestProviderConfig("${OTHER}");
  copyConfigResolutionFactsExcept(sourceConfig, resolvedConfig, [keyPath]);

  const result = analyzeTalk(sourceConfig, resolvedConfig);

  expect([result.unresolved, result.assignments]).toEqual([
    [],
    [expect.objectContaining({ path: keyPath, value: "${OTHER}" })],
  ]);
});

it("skips inactive unresolved refs with a diagnostic", () => {
  const sourceConfig = buildTalkTestProviderConfig({
    source: "env",
    provider: "default",
    id: "KEY",
  });
  const result = analyzeCommandSecretAssignmentsFromSnapshot({
    sourceConfig,
    resolvedConfig: structuredClone(sourceConfig),
    targetIds: new Set(["talk.providers.*.apiKey"]),
    inactiveRefPaths: new Set([keyPath]),
  });

  expect(result.assignments).toStrictEqual([]);
  expect(result.diagnostics).toEqual([
    `${keyPath}: secret ref is configured on an inactive surface; skipping command-time assignment.`,
  ]);
});
