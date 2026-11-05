import { expect, it } from "vitest";
import type { ModelAliasIndex } from "../agents/model-selection-shared.js";
import { withPluginMetadataSnapshotScope } from "../plugins/current-plugin-metadata-snapshot.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { parseInlineSessionDirectives as parse } from "./reply/directive-handling.parse.js";
import { resolveModelDirectiveSelection } from "./reply/model-selection-directive.js";

it("preserves bytes without directives", () => {
  const body = "  ordinary\t text\r\n    if ready:\r\n        run('a  b')  \r\n";
  expect(parse(body).cleaned).toBe(body);
});
it.each(["/think high", "/status:"])("preserves surrounding code for %s", (directive) => {
  const code = "\r\n```python\r\n    if ready:\r\n        run('a  b')\r\n\t\tfinish()  \r\n```\r\n";
  expect(parse("  Keep\t spacing " + directive + " here  too" + code).cleaned).toBe(
    "  Keep\t spacing here  too" + code,
  );
});
it("preserves indentation after alias arguments", () => {
  const code = "    if ready:\r\n        run()  \r\n";
  expect(parse("/sample\r\n" + code, { modelAliases: ["sample"] }).cleaned).toBe(code);
});
it.each([
  ["/exec\n host=auto\n security=deny\r\n", { execHost: "auto", execSecurity: "deny" }],
  ["/queue\n collect\n cap:5\r\n", { queueMode: "collect", cap: 5 }],
  ["/think\n high\r\n", { thinkLevel: "high" }],
  [
    "/model\n example/model\n -s\r\n",
    { rawModelDirective: "example/model", modelScope: "session" },
  ],
])("preserves code after cross-line arguments: %j", (directive, fields) => {
  const code = "    print('a  b')\r\n";
  expect(parse(directive + code)).toMatchObject({ ...fields, cleaned: code });
});

it.each([
  [
    "/think high /think low /verbose on\r\n    code  here",
    { thinkLevel: "high", verboseLevel: "on", cleaned: "/think low\r\n    code  here" },
  ],
  [
    "/think default",
    {
      hasThinkDirective: true,
      thinkLevel: undefined,
      rawThinkLevel: "default",
      clearThinkLevel: true,
    },
  ],
  [
    "/fast inherit",
    { hasFastDirective: true, fastMode: undefined, rawFastMode: "inherit", clearFastMode: true },
  ],
  ["/fast ultr", { hasFastDirective: true, fastMode: undefined }],
  [
    "/think:",
    { hasThinkDirective: true, thinkLevel: undefined, rawThinkLevel: undefined, cleaned: "" },
  ],
  ["thats not /think high/tmp/hello", { hasThinkDirective: true, cleaned: "thats not /tmp/hello" }],
  [
    "please /exec host=auto security=allowlist ask=on-miss node=mac-mini now",
    {
      hasExecDirective: true,
      execHost: "auto",
      execSecurity: "allowlist",
      execAsk: "on-miss",
      execNode: "mac-mini",
      cleaned: "please now",
    },
  ],
  [
    "please /queue collect debounce:2s cap:5 drop:summarize now",
    {
      hasQueueDirective: true,
      queueMode: "collect",
      debounceMs: 2000,
      cap: 5,
      dropPolicy: "summarize",
      cleaned: "please now",
    },
  ],
])("parses directive arguments and leaves prose intact: %s", (body, expected) => {
  expect(parse(body)).toMatchObject(expected);
});
it("preserves prose after a thinking directive", () => {
  const result = parse("/think about my deployment plan");
  expect(result.rawThinkLevel).toBeUndefined();
  expect(result.command).toBeUndefined();
  expect(result.cleaned).toBe("about my deployment plan");
});
it.each([
  ["/fast ultrafast", "ultrafast", ""],
  ["/fast ultra", "ultra", ""],
  ["/fast ULTRA please hurry", "ULTRA", "please hurry"],
])("normalizes fast mode: %s", (body, rawFastMode, cleaned) => {
  expect(parse(body)).toMatchObject({
    hasFastDirective: true,
    fastMode: "ultrafast",
    rawFastMode,
    cleaned,
  });
});
it.each([
  ["host", "spaceship", "execHost", "rawExecHost", "invalidExecHost"],
  ["security", "wide-open", "execSecurity", "rawExecSecurity", "invalidExecSecurity"],
  ["ask", "sometimes", "execAsk", "rawExecAsk", "invalidExecAsk"],
])("rejects invalid exec %s", (option, value, field, raw, invalid) => {
  expect(parse("/exec " + option + "=" + value)).toMatchObject({
    hasExecDirective: true,
    [field]: undefined,
    [raw]: value,
    [invalid]: true,
  });
});
it.each([
  ["think", "think_hard", "thinkLevel", "low", ""],
  ["reasoning", "0", "reasoningLevel", "off", ""],
  ["reasoning", "streaming", "reasoningLevel", "stream", ""],
  ["verbose", "3d printing tips", "verboseLevel", undefined, "3d printing tips"],
] as const)("accepts digit/underscore aliases: /%s %s", (name, args, key, value, cleaned) => {
  expect(parse("/" + name + " " + args, { command: { kind: "text", name } })).toMatchObject({
    [key]: value,
    cleaned,
  });
});
it("parses native model runtime and session options", () => {
  expect(
    parse("/model openai/gpt-4.1-mini -s harness=codex", {
      command: { kind: "native", name: "model" },
    }),
  ).toMatchObject({
    cleaned: "",
    rawModelDirective: "openai/gpt-4.1-mini",
    rawModelRuntime: "codex",
    modelScope: "session",
    command: { name: "model" },
  });
});
it.each([
  ["trace", "rawTraceLevel", "banana", "please"],
  ["elevated", "rawElevatedLevel", "perhaps", "explain"],
] as const)("preserves invalid native arguments: /%s", (name, raw, invalid, trailing) => {
  const parsed = parse("/" + name + " " + invalid + " " + trailing, {
    command: { kind: "native", name },
  });
  expect(parsed).toMatchObject({ [raw]: invalid, cleaned: trailing });
  expect(parsed.command).toEqual({ name, unconsumedArguments: trailing });
});
it("does not interpret a second directive inside native arguments", () => {
  expect(parse("/queue /think high", { command: { kind: "native", name: "queue" } })).toMatchObject(
    { hasQueueDirective: true, rawQueueMode: "/think", hasThinkDirective: false },
  );
});

const emptyAliasIndex: ModelAliasIndex = { byAlias: new Map(), byKey: new Map() };
const kimi = { provider: "fixture-moonshot", model: "kimi-k2-0905-preview" };
const kimiKey = "fixture-moonshot/kimi-k2-0905-preview";
const defaultKey = "fixture-anthropic/claude-opus-4-6";
const minimax = "fixture-minimax";
// Keep ranking fixtures independent of bundled provider policy loading.
const metadataSnapshot = createPluginMetadataSnapshotFixture();

function resolveModel(
  raw: string,
  allowedModelKeys: string[],
  overrides: {
    aliasIndex?: ModelAliasIndex;
    defaultProvider?: string;
    defaultModel?: string;
  } = {},
) {
  return withPluginMetadataSnapshotScope(metadataSnapshot, () =>
    resolveModelDirectiveSelection({
      raw,
      defaultProvider: "fixture-anthropic",
      defaultModel: "claude-opus-4-6",
      aliasIndex: emptyAliasIndex,
      ...overrides,
      allowedModelKeys: new Set(allowedModelKeys),
      cfg: { agents: { defaults: { modelPolicy: { allow: allowedModelKeys } } } },
    }),
  ).selection;
}

it("picks the best fuzzy match for global and provider-scoped fixture-minimax queries", () => {
  const defaults = { defaultProvider: minimax, defaultModel: "Fixture-Minimax-M2.7" };
  const allowedModelKeys = [
    "fixture-minimax/Fixture-Minimax-M2.7",
    "fixture-minimax/Fixture-Minimax-M2.7-highspeed",
  ];
  expect(
    resolveModel(
      "fixture-minimax",
      [...allowedModelKeys, "fixture-local/fixture-minimax-m2.5-gs32"],
      defaults,
    ),
  ).toEqual({ provider: minimax, model: "Fixture-Minimax-M2.7", isDefault: true });

  expect(resolveModel("fixture-minimax/highspeed", allowedModelKeys, defaults)).toEqual({
    provider: minimax,
    model: "Fixture-Minimax-M2.7-highspeed",
    isDefault: false,
  });
});

it("prefers alias matches when fuzzy selection is ambiguous", () => {
  const aliasIndex: ModelAliasIndex = {
    byAlias: new Map([["kimi", { alias: "Kimi", ref: kimi }]]),
    byKey: new Map([[kimiKey, ["Kimi"]]]),
  };

  expect(
    resolveModel("ki", [defaultKey, kimiKey, "fixture-local/kimi-k2-0905-preview"], {
      aliasIndex,
    }),
  ).toEqual({ ...kimi, isDefault: false, alias: "Kimi" });
});
