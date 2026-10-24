import { describe, expect, it } from "vitest";
import type { ModelAliasIndex } from "../agents/model-selection-shared.js";
import { withPluginMetadataSnapshotScope } from "../plugins/current-plugin-metadata-snapshot.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { parseInlineSessionDirectives as parse } from "./reply/directive-handling.parse.js";
import { extractThinkDirective } from "./reply/directives.js";
import { extractExecDirective } from "./reply/exec/directive.js";
import { resolveModelDirectiveSelection } from "./reply/model-selection-directive.js";
import { extractQueueDirective } from "./reply/queue/directive.js";

describe("directive parsing", () => {
  it("preserves bytes without directives", () => {
    const body = "  ordinary\t text\r\n    if ready:\r\n        run('a  b')  \r\n";
    expect(parse(body).cleaned).toBe(body);
  });
  it.each(["/think high", "/status:"])("preserves code around %s", (directive) => {
    const code =
      "\r\n```python\r\n    if ready:\r\n        run('a  b')\r\n\t\tfinish()  \r\n```\r\n";
    const body = `  Keep\t spacing ${directive} here  too${code}`;
    expect(parse(body, { modelAliases: ["sample"] }).cleaned).toBe(
      `  Keep\t spacing here  too${code}`,
    );
  });
  it("preserves indentation after alias arguments", () => {
    const code = "    if ready:\r\n        run()  \r\n";
    expect(parse(`/sample\r\n${code}`, { modelAliases: ["sample"] }).cleaned).toBe(code);
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
    expect(parse(`${directive}${code}`)).toMatchObject({ ...fields, cleaned: code });
  });
  it.each([
    [
      "/think high /think low /verbose on\r\n    code  here",
      {
        thinkLevel: "high",
        verboseLevel: "on",
        cleaned: "/think low\r\n    code  here",
      },
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
  ] as const)("parses precedence, clears, and prose: %s", (body, expected) => {
    expect(parse(body)).toMatchObject(expected);
  });
  it.each([
    ["/fast ultrafast", "ultrafast", ""],
    ["/fast ultra", "ultra", ""],
    ["/fast ULTRA please hurry", "ULTRA", "please hurry"],
  ])("parses %s as the canonical ultrafast mode", (body, rawFastMode, cleaned) => {
    expect(parse(body)).toMatchObject({
      hasFastDirective: true,
      fastMode: "ultrafast",
      rawFastMode,
      cleaned,
    });
  });
  it("keeps an unknown fast mode unresolved", () => {
    expect(parse("/fast ultr")).toMatchObject({ hasFastDirective: true, fastMode: undefined });
  });
  it("preserves prose after a thinking directive", () => {
    const result = parse("/think about my deployment plan");
    expect(result.rawThinkLevel).toBeUndefined();
    expect(result.command).toBeUndefined();
    expect(result.cleaned).toBe("about my deployment plan");
  });
  it.each([
    ["/think:", extractThinkDirective, { thinkLevel: undefined, rawLevel: undefined, cleaned: "" }],
    ["thats not /think high/tmp/hello", extractThinkDirective, { cleaned: "thats not /tmp/hello" }],
    [
      "please /exec host=auto security=allowlist ask=on-miss node=mac-mini now",
      extractExecDirective,
      {
        execHost: "auto",
        execSecurity: "allowlist",
        execAsk: "on-miss",
        execNode: "mac-mini",
        cleaned: "please now",
      },
    ],
    [
      "please /queue collect debounce:2s cap:5 drop:summarize now",
      extractQueueDirective,
      {
        queueMode: "collect",
        debounceMs: 2000,
        cap: 5,
        dropPolicy: "summarize",
        cleaned: "please now",
      },
    ],
  ] as const)("extracts options without consuming prose: %s", (body, extract, expected) => {
    expect(extract(body)).toMatchObject({ hasDirective: true, ...expected });
  });
  it.each([
    ["host", "spaceship", "execHost", "rawExecHost", "invalidHost"],
    ["security", "wide-open", "execSecurity", "rawExecSecurity", "invalidSecurity"],
    ["ask", "sometimes", "execAsk", "rawExecAsk", "invalidAsk"],
  ] as const)("captures invalid exec %s", (option, value, field, rawField, invalidField) => {
    expect(extractExecDirective(`/exec ${option}=${value}`)).toMatchObject({
      hasDirective: true,
      [field]: undefined,
      [rawField]: value,
      [invalidField]: true,
    });
  });
  it.each([
    ["think", "think_hard", "thinkLevel", "low", ""],
    ["reasoning", "0", "reasoningLevel", "off", ""],
    ["verbose", "3d printing tips", "verboseLevel", undefined, "3d printing tips"],
  ] as const)(
    "accepts digit/underscore aliases: /%s %s",
    (name, args, levelKey, level, cleaned) => {
      const parsed = parse(`/${name} ${args}`, { command: { kind: "text", name } });
      expect(parsed).toMatchObject({ [levelKey]: level, cleaned });
    },
  );
});

describe("native command argument boundaries", () => {
  it("parses model runtime and session options", () => {
    const model = parse("/model openai/gpt-4.1-mini -s harness=codex", {
      command: { kind: "native", name: "model" },
    });
    expect(model).toMatchObject({
      cleaned: "",
      rawModelDirective: "openai/gpt-4.1-mini",
      rawModelRuntime: "codex",
      modelScope: "session",
    });
    expect(model.command).toEqual({ name: "model" });
  });
  it.each([
    ["trace", "rawTraceLevel", "banana", "please"],
    ["elevated", "rawElevatedLevel", "perhaps", "explain"],
  ] as const)("preserves invalid first arguments: /%s", (command, rawKey, invalid, trailing) => {
    const parsed = parse(`/${command} ${invalid} ${trailing}`, {
      command: { kind: "native", name: command },
    });
    expect(parsed).toMatchObject({ [rawKey]: invalid, cleaned: trailing });
    expect(parsed.command).toEqual({ name: command, unconsumedArguments: trailing });
  });
  it("does not interpret a second directive inside arguments", () => {
    expect(
      parse("/queue /think high", { command: { kind: "native", name: "queue" } }),
    ).toMatchObject({ hasQueueDirective: true, rawQueueMode: "/think", hasThinkDirective: false });
  });
});

const emptyAliasIndex: ModelAliasIndex = { byAlias: new Map(), byKey: new Map() };
const kimi = { provider: "fixture-moonshot", model: "kimi-k2-0905-preview" };
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

describe("directive behavior model fuzzy selection", () => {
  it("supports unambiguous fuzzy model matches across /model forms", () => {
    const allowedModelKeys = [
      "fixture-anthropic/claude-opus-4-6",
      "fixture-moonshot/kimi-k2-0905-preview",
    ];

    for (const raw of ["kimi", "kimi-k2-0905-preview", "fixture-moonshot/kimi"]) {
      expect(resolveModel(raw, allowedModelKeys)).toEqual({ ...kimi, isDefault: false });
    }
  });

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
      byKey: new Map([["fixture-moonshot/kimi-k2-0905-preview", ["Kimi"]]]),
    };

    expect(
      resolveModel(
        "ki",
        [
          "fixture-anthropic/claude-opus-4-6",
          "fixture-moonshot/kimi-k2-0905-preview",
          "fixture-local/kimi-k2-0905-preview",
        ],
        { aliasIndex },
      ),
    ).toEqual({ ...kimi, isDefault: false, alias: "Kimi" });
  });
});
