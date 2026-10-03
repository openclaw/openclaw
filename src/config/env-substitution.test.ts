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

it("resolves string templates, escapes and defaults without warnings", () => {
  const cases: Array<[string, Record<string, string>, string]> = [
    ["${FOO}", { FOO: "bar" }, "bar"],
    ["${A}/${B}", { A: "x", B: "y" }, "x/y"],
    ["prefix-${FOO}-suffix", { FOO: "bar" }, "prefix-bar-suffix"],
    ["${FOO}:${FOO}", { FOO: "bar" }, "bar:bar"],
    ["$${VAR}", { VAR: "value" }, "${VAR}"],
    ["${REAL}/$${LITERAL}", { REAL: "resolved" }, "resolved/${LITERAL}"],
    ["$${FOO} ${FOO}", { FOO: "bar" }, "${FOO} bar"],
    ["${FOO} $${FOO}", { FOO: "bar" }, "bar ${FOO}"],
    ["$${A}:$${B}", {}, "${A}:${B}"],
    ["${FOO}", { FOO: "$${BAR}" }, "$${BAR}"],
    ["${_UNDERSCORE_START}", { _UNDERSCORE_START: "valid" }, "valid"],
    ["${VAR_WITH_NUMBERS_123}", { VAR_WITH_NUMBERS_123: "valid" }, "valid"],
    ["${NAUTOBOT_TIMEOUT:-60}", {}, "60"],
    ["${NAUTOBOT_TIMEOUT:-60}", { NAUTOBOT_TIMEOUT: "90" }, "90"],
    ["${NAUTOBOT_TIMEOUT:-60}", { NAUTOBOT_TIMEOUT: "" }, "60"],
    ["${OPTIONAL_SUFFIX:-}", {}, ""],
    ["https://${API_HOST:-api.example.com}/v1", {}, "https://api.example.com/v1"],
    ["${API_HOST:-localhost}:${API_PORT:-8080}", { API_HOST: "example.com" }, "example.com:8080"],
    ["${VAR:-a b  c}", {}, "a b  c"],
    ["${VAR:-:-}", {}, ":-"],
    ["${VAR:--5}", {}, "-5"],
    ["$${VAR:-x}", { VAR: "from-env" }, "${VAR:-x}"],
    ["$${VAR:-x}", {}, "${VAR:-x}"],
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
    ].map((literal): [string, Record<string, string>, string] => [
      literal,
      { VAR: "value", lowercase: "value", MixedCase: "value" },
      literal,
    ]),
  ];
  for (const [input, env, expected] of cases) {
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
  const cases: Array<[unknown, unknown]> = [
    [{ outer: { inner: { key: "${A}" } } }, { outer: { inner: { key: "1" } } }],
    [{ items: ["${A}", "${B}"] }, { items: ["1", "2"] }],
    [
      { providers: [{ apiKey: "${A}" }, { apiKey: "${B}" }] },
      { providers: [{ apiKey: "1" }, { apiKey: "2" }] },
    ],
    [{}, {}],
    [[], []],
    [
      { num: 42, bool: true, nil: null, arr: [1, 2] },
      { num: 42, bool: true, nil: null, arr: [1, 2] },
    ],
  ];
  for (const [config, expected] of cases) {
    expect(resolveConfigEnvVars(config, { A: "1", B: "2" })).toEqual(expected);
  }
  for (const value of ["hello", 42, true, null]) {
    expect(resolveConfigEnvVars(value, {})).toBe(value);
  }
});

it("reports missing and empty variables at canonical config paths", () => {
  const cases: Array<[unknown, string, Record<string, string>?]> = [
    [{ key: "${MISSING}" }, "key"],
    [{ key: "${MISSING}" }, "key", { MISSING: "" }],
    [{ outer: { inner: { key: "${MISSING}" } } }, "outer.inner.key"],
    [{ items: ["ok", "${MISSING}"] }, "items[1]"],
    [
      { plugins: { entries: { "foo.config.bar": { token: "${MISSING}" } } } },
      'plugins.entries["foo.config.bar"].token',
    ],
    [
      { plugins: { entries: { fixture: { config: { headers: { "X.Trace": "${MISSING}" } } } } } },
      'plugins.entries.fixture.config.headers["X.Trace"]',
    ],
    [
      {
        plugins: { entries: { fixture: { config: { headers: { X: { Trace: "${MISSING}" } } } } } },
      },
      "plugins.entries.fixture.config.headers.X.Trace",
    ],
    [
      { plugins: { entries: { fixture: { config: { headers: { "0": "${MISSING}" } } } } } },
      'plugins.entries.fixture.config.headers["0"]',
    ],
    [{ "root.key": "${MISSING}" }, '["root.key"]'],
    [
      { plugins: { entries: { fixture: { config: { headers: ["${MISSING}"] } } } } },
      "plugins.entries.fixture.config.headers[0]",
    ],
    [
      { providers: { "vercel-gateway": { apiKey: "${MISSING}" } } },
      "providers.vercel-gateway.apiKey",
    ],
  ];
  for (const [config, configPath, env = {}] of cases) {
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
  const env = { LATER: "before-callback" };
  const warnings: EnvSubstitutionWarning[] = [];
  const result = resolveConfigEnvVars({ items, tail: "${LAST}", "${KEY}": "literal-key" }, env, {
    onMissing: (warning) => {
      warnings.push(warning);
      env.LATER = "after-callback";
    },
  });
  const expectedItems: unknown[] = [];
  expectedItems.length = 3;
  expectedItems[1] = {
    missing: "${FIRST}",
    resolved: "after-callback",
    escaped: "${LATER}",
  };
  expect(result).toStrictEqual({
    items: expectedItems,
    tail: "${LAST}",
    "${KEY}": "literal-key",
  });
  expect(warnings).toEqual([
    { varName: "FIRST", configPath: "items[1].missing" },
    { varName: "LAST", configPath: "tail" },
  ]);
});

it("keeps pending and resolved SecretRef provenance distinct across config paths", () => {
  const pendingEnvSecretRefs = new Map<string, string>();
  const resolvedEnvSecretRefs = new Map<string, string>();
  const config = resolveConfigEnvVars(
    {
      plugins: {
        entries: {
          "foo.config.bar": { config: { token: "$ATTACKER" } },
          foo: {
            config: {
              bar: { config: { token: "$VICTIM" } },
              headers: {
                "X.Trace": "$DOTTED_HEADER",
                X: { Trace: "$NESTED_HEADER" },
              },
            },
          },
        },
      },
      models: {
        providers: {
          "alpha:beta": {
            apiKey: "$CORE_PROVIDER",
            headers: { "X.Trace": "$CORE_HEADER" },
          },
        },
      },
      resolved: "${RESOLVED_SECRET}",
    },
    { RESOLVED_SECRET: "resolved-value" },
    {
      onPendingEnvSecretRef: (id, configPath) => pendingEnvSecretRefs.set(configPath, id),
      onResolvedEnvSecretRef: (id, configPath) => resolvedEnvSecretRefs.set(configPath, id),
    },
  );
  setConfigResolutionFacts(
    config,
    createConfigResolutionFacts([], pendingEnvSecretRefs, undefined, resolvedEnvSecretRefs),
  );

  expect([...pendingEnvSecretRefs]).toEqual([
    ['plugins.entries["foo.config.bar"].config.token', "ATTACKER"],
    ["plugins.entries.foo.config.bar.config.token", "VICTIM"],
    ['plugins.entries.foo.config.headers["X.Trace"]', "DOTTED_HEADER"],
    ["plugins.entries.foo.config.headers.X.Trace", "NESTED_HEADER"],
    ["models.providers.alpha:beta.apiKey", "CORE_PROVIDER"],
    ['models.providers.alpha:beta.headers["X.Trace"]', "CORE_HEADER"],
  ]);
  expect([...resolvedEnvSecretRefs]).toEqual([["resolved", "RESOLVED_SECRET"]]);
  for (const [configPath, id] of pendingEnvSecretRefs) {
    expect(getAuthoredConfigSecretRef(config, configPath), configPath).toEqual({
      source: "env",
      provider: "default",
      id,
    });
  }
  expect(getAuthoredConfigSecretRef(config, "resolved")).toBeNull();
  expect(getResolvedConfigEnvSecretRef(config, "resolved")).toEqual({
    source: "env",
    provider: "default",
    id: "RESOLVED_SECRET",
  });
});

it("detects only unescaped supported env references", () => {
  const cases: Array<[boolean, string[]]> = [
    [
      true,
      [
        "${FOO}",
        "prefix-${VAR}-suffix",
        "${A}/${B}",
        "${_UNDERSCORE}",
        "${VAR_WITH_123}",
        "$${ESCAPED} ${REAL}",
        "${REAL} $${ESCAPED}",
        "${VAR:-x}",
        "prefix-${VAR:-x}",
        "${VAR:-}",
      ],
    ],
    [
      false,
      [
        "no-refs-here",
        "$VAR",
        "${lowercase}",
        "${MixedCase}",
        "${123INVALID}",
        "",
        "$${ESCAPED}",
        "prefix-$${ESCAPED}-suffix",
        "$${VAR:-x}",
        "${VAR:=x}",
        "${VAR-x}",
        "${lowercase:-x}",
      ],
    ],
  ];
  for (const [expected, inputs] of cases) {
    for (const input of inputs) {
      expect(containsEnvVarReference(input), input).toBe(expected);
    }
  }
});
