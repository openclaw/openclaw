import { expect, it } from "vitest";
import {
  type EnvSubstitutionWarning,
  MissingEnvVarError,
  containsEnvVarReference,
  resolveConfigEnvVars,
} from "./env-substitution.js";
import {
  createConfigResolutionFacts,
  getAuthoredConfigSecretRef,
  getResolvedConfigEnvSecretRef,
  setConfigResolutionFacts,
} from "./resolution-facts.js";

function secretRef(id: string) {
  return { source: "env", provider: "default", id };
}

const templates: Array<[string, Record<string, string>, string, boolean?]> = [
  ["${FOO}", { FOO: "bar" }, "bar"],
  ["${A}/${B}", { A: "x", B: "y" }, "x/y"],
  ["prefix-${FOO}-suffix", { FOO: "bar" }, "prefix-bar-suffix"],
  ["${FOO}:${FOO}", { FOO: "bar" }, "bar:bar"],
  ["$${VAR}", { VAR: "value" }, "${VAR}", false],
  ["${REAL}/$${LITERAL}", { REAL: "resolved" }, "resolved/${LITERAL}"],
  ["$${FOO} ${FOO}", { FOO: "bar" }, "${FOO} bar"],
  ["${FOO} $${FOO}", { FOO: "bar" }, "bar ${FOO}"],
  ["$${A}:$${B}", {}, "${A}:${B}", false],
  ["${FOO}", { FOO: "$${BAR}" }, "$${BAR}"],
  ["${_UNDERSCORE_START}", { _UNDERSCORE_START: "valid" }, "valid"],
  ["${VAR_WITH_NUMBERS_123}", { VAR_WITH_NUMBERS_123: "valid" }, "valid"],
  ["${NAUTOBOT_TIMEOUT:-60}", {}, "60"],
  ["${NAUTOBOT_TIMEOUT:-60}", { NAUTOBOT_TIMEOUT: "90" }, "90"],
  ["${NAUTOBOT_TIMEOUT:-60}", { NAUTOBOT_TIMEOUT: "" }, "60"],
  ["${OPTIONAL_SUFFIX:-}", {}, ""],
  ["${OPTIONAL_SUFFIX:-}", { OPTIONAL_SUFFIX: "" }, ""],
  ["https://${API_HOST:-api.example.com}/v1", {}, "https://api.example.com/v1"],
  ["${API_HOST:-localhost}:${API_PORT:-8080}", { API_HOST: "example.com" }, "example.com:8080"],
  ["${VAR:-a b  c}", {}, "a b  c"],
  ["${VAR:-:-}", {}, ":-"],
  ["${VAR:--5}", {}, "-5"],
  ["$${VAR:-x}", { VAR: "from-env" }, "${VAR:-x}", false],
  ["$${VAR:-x}", {}, "${VAR:-x}", false],
  ["${A:-${B}}", { A: "a-value", B: "b-value" }, "${A:-b-value}"],
  ["${A:-${B:-c}}", {}, "${A:-c}"],
  ...[
    "$VAR",
    "${lowercase}",
    "${MixedCase}",
    "${123INVALID}",
    "${VAR:=d}",
    "${VAR:?m}",
    "${VAR:+a}",
    "${VAR-d}",
    "${VAR#p}",
    "${VAR%s}",
    "${VAR/a/b}",
    "${VAR:json}",
    "${lowercase:-d}",
    "${MixedCase:-d}",
    "${123INVALID:-d}",
    "${:-d}",
    "${my-service} ${count+1} ${a=b}",
    '${A:-{"n":1}}',
    "${PRICE:-$5}",
  ].map((literal): [string, Record<string, string>, string, boolean] => [
    literal,
    { VAR: "value", lowercase: "value", MixedCase: "value" },
    literal,
    false,
  ]),
];
it("resolves string templates, escapes and defaults without warnings", () => {
  for (const [input, env, expected] of templates) {
    const warnings: EnvSubstitutionWarning[] = [];
    expect(
      resolveConfigEnvVars({ key: input }, env, {
        onMissing: (warning) => warnings.push(warning),
      }),
      input,
    ).toEqual({ key: expected });
    expect(warnings, input).toEqual([]);
  }
});

it("resolves nested containers and preserves non-string values", () => {
  const unchanged = { num: 42, bool: true, nil: null, arr: [1, 2] };
  const cases: Array<[unknown, unknown]> = [
    [{ outer: { inner: { key: "${A}" } } }, { outer: { inner: { key: "1" } } }],
    [{ items: ["${A}", "${B}"] }, { items: ["1", "2"] }],
    [{ rows: [{ key: "${A}" }, { key: "${B}" }] }, { rows: [{ key: "1" }, { key: "2" }] }],
    [{}, {}],
    [[], []],
    [unchanged, unchanged],
  ];
  for (const [config, expected] of cases) {
    expect(resolveConfigEnvVars(config, { A: "1", B: "2" })).toEqual(expected);
  }
  for (const value of ["hello", 42, true, null]) {
    expect(resolveConfigEnvVars(value, {})).toBe(value);
  }
});

it("reports missing and empty variables at canonical config paths", () => {
  const headers = ["plugins", "entries", "fixture", "config", "headers"];
  const cases: Array<[Array<string | number>, string, Record<string, string>?]> = [
    [["key"], "key"],
    [["key"], "key", { MISSING: "" }],
    [["outer", "inner", "key"], "outer.inner.key"],
    [["items", 1], "items[1]"],
    [["plugins", "entries", "foo.config.bar", "token"], 'plugins.entries["foo.config.bar"].token'],
    [[...headers, "X.Trace"], 'plugins.entries.fixture.config.headers["X.Trace"]'],
    [[...headers, "X", "Trace"], "plugins.entries.fixture.config.headers.X.Trace"],
    [[...headers, "0"], 'plugins.entries.fixture.config.headers["0"]'],
    [["root.key"], '["root.key"]'],
    [[...headers, 0], "plugins.entries.fixture.config.headers[0]"],
    [["providers", "vercel-gateway", "apiKey"], "providers.vercel-gateway.apiKey"],
  ];
  for (const [segments, configPath, env = {}] of cases) {
    const config = segments.reduceRight<unknown>((value, key) => {
      if (typeof key === "string") {
        return { [key]: value };
      }
      const items: unknown[] = Array.from({ length: key + 1 }, () => "ok");
      items[key] = value;
      return items;
    }, "${MISSING}");
    try {
      resolveConfigEnvVars(config, env);
      expect.fail("expected MissingEnvVarError");
    } catch (error) {
      expect(error).toBeInstanceOf(MissingEnvVarError);
      expect(error).toMatchObject({ varName: "MISSING", configPath });
    }
  }
});

it("retains sparse arrays, literal keys, escaping and depth-first callback order", () => {
  const items: unknown[] = [];
  items.length = 3;
  items[1] = { missing: "${FIRST}", resolved: "${LATER}", escaped: "$${LATER}" };
  const env = { LATER: "before" };
  const warnings: EnvSubstitutionWarning[] = [];
  const result = resolveConfigEnvVars({ items, tail: "${LAST}", "${KEY}": "literal-key" }, env, {
    onMissing: (warning) => {
      warnings.push(warning);
      env.LATER = "after";
    },
  });
  const expectedItems: unknown[] = [];
  expectedItems.length = 3;
  expectedItems[1] = { missing: "${FIRST}", resolved: "after", escaped: "${LATER}" };
  expect(result).toStrictEqual({ items: expectedItems, tail: "${LAST}", "${KEY}": "literal-key" });
  expect(warnings).toEqual([
    { varName: "FIRST", configPath: "items[1].missing" },
    { varName: "LAST", configPath: "tail" },
  ]);
});

it("keeps pending and resolved SecretRef provenance distinct across config paths", () => {
  const pendingRefs = new Map<string, string>();
  const resolvedRefs = new Map<string, string>();
  const headers = { "X.Trace": "$DOTTED_HEADER", X: { Trace: "$NESTED_HEADER" } };
  const entries = {
    "foo.config.bar": { config: { token: "$ATTACKER" } },
    foo: { config: { bar: { config: { token: "$VICTIM" } }, headers } },
  };
  const providers = {
    "alpha:beta": { apiKey: "$CORE_PROVIDER", headers: { "X.Trace": "$CORE_HEADER" } },
  };
  const config = resolveConfigEnvVars(
    {
      plugins: { entries },
      models: { providers },
      resolved: "${RESOLVED_SECRET}",
    },
    { RESOLVED_SECRET: "resolved-value" },
    {
      onPendingEnvSecretRef: (id, configPath) => pendingRefs.set(configPath, id),
      onResolvedEnvSecretRef: (id, configPath) => resolvedRefs.set(configPath, id),
    },
  );
  setConfigResolutionFacts(
    config,
    createConfigResolutionFacts([], pendingRefs, undefined, resolvedRefs),
  );

  expect([...pendingRefs]).toEqual([
    ['plugins.entries["foo.config.bar"].config.token', "ATTACKER"],
    ["plugins.entries.foo.config.bar.config.token", "VICTIM"],
    ['plugins.entries.foo.config.headers["X.Trace"]', "DOTTED_HEADER"],
    ["plugins.entries.foo.config.headers.X.Trace", "NESTED_HEADER"],
    ["models.providers.alpha:beta.apiKey", "CORE_PROVIDER"],
    ['models.providers.alpha:beta.headers["X.Trace"]', "CORE_HEADER"],
  ]);
  expect([...resolvedRefs]).toEqual([["resolved", "RESOLVED_SECRET"]]);
  for (const [configPath, id] of pendingRefs) {
    expect(getAuthoredConfigSecretRef(config, configPath), configPath).toEqual(secretRef(id));
  }
  expect(getAuthoredConfigSecretRef(config, "resolved")).toBeNull();
  expect(getResolvedConfigEnvSecretRef(config, "resolved")).toEqual(secretRef("RESOLVED_SECRET"));
});

it("detects only unescaped supported env references", () => {
  for (const row of templates) {
    expect(containsEnvVarReference(row[0]), row[0]).toBe(row[3] ?? true);
  }
  for (const input of ["no-refs-here", "", "prefix-$${ESCAPED}-suffix"]) {
    expect(containsEnvVarReference(input), input).toBe(false);
  }
});
