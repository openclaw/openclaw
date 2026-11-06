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
  ["prefix-${A}/${B}-suffix", { A: "x", B: "y" }, "prefix-x/y-suffix"],
  ["${FOO}", { FOO: "bar" }, "bar"],
  ["$${VAR}", { VAR: "value" }, "${VAR}", false],
  ["${REAL}/$${LITERAL}", { REAL: "resolved" }, "resolved/${LITERAL}"],
  ["${FOO}", { FOO: "$${BAR}" }, "$${BAR}"],
  ["${_VAR_123}", { _VAR_123: "valid" }, "valid"],
  ["${NAUTOBOT_TIMEOUT:-60}", {}, "60"],
  ["${NAUTOBOT_TIMEOUT:-60}", { NAUTOBOT_TIMEOUT: "90" }, "90"],
  ["${NAUTOBOT_TIMEOUT:-60}", { NAUTOBOT_TIMEOUT: "" }, "60"],
  ["${OPTIONAL_SUFFIX:-}", {}, ""],
  ["${VAR:-a b  :- -5}", {}, "a b  :- -5"],
  ["$${VAR:-x}", { VAR: "from-env" }, "${VAR:-x}", false],
  ["${A:-${B}}", { A: "a-value", B: "b-value" }, "${A:-b-value}"],
  ["${A:-${B:-c}}", {}, "${A:-c}"],
  ...[
    "$VAR",
    "${lowercase}",
    "${:-d}",
    '${A:-{"n":1}}',
    "${PRICE:-$5}",
    "${VAR:?m}",
    "${VAR:=d}",
    "${VAR:+a}",
    "${VAR-d}",
    "no-refs-here",
    "",
  ].map((literal): [string, Record<string, string>, string, boolean] => [
    literal,
    { VAR: "value", lowercase: "value" },
    literal,
    false,
  ]),
];
it("resolves string templates, escapes and defaults without warnings", () => {
  for (const [input, env, expected, hasReference = true] of templates) {
    const warnings: EnvSubstitutionWarning[] = [];
    const actual = resolveConfigEnvVars({ key: input }, env, {
      onMissing: (warning) => warnings.push(warning),
    });
    expect(actual, input).toEqual({ key: expected });
    expect(warnings, input).toEqual([]);
    expect(containsEnvVarReference(input), input).toBe(hasReference);
  }
});

it("preserves non-string values and empty containers", () => {
  const config = { empty: {}, array: [], num: 42, bool: true, nil: null, numbers: [1, 2] };
  expect(resolveConfigEnvVars(config, {})).toEqual(config);
  for (const value of ["hello", 42, true, null]) {
    expect(resolveConfigEnvVars(value, {})).toBe(value);
  }
});

it("reports missing and empty variables at canonical config paths", () => {
  const missing = "${MISSING}";
  const cases: Array<[unknown, string, Record<string, string>?]> = [
    [{ key: missing }, "key"],
    [{ key: missing }, "key", { MISSING: "" }],
    [{ items: ["ok", missing] }, "items[1]"],
    [{ headers: { "0": missing } }, 'headers["0"]'],
    [{ "root.key": missing }, '["root.key"]'],
    [{ providers: { "vercel-gateway": { apiKey: missing } } }, "providers.vercel-gateway.apiKey"],
  ];
  for (const [config, configPath, env = {}] of cases) {
    expect(() => resolveConfigEnvVars(config, env)).toThrow(
      expect.objectContaining({ constructor: MissingEnvVarError, varName: "MISSING", configPath }),
    );
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
