// Covers config environment-variable substitution behavior.
import { describe, expect, it } from "vitest";
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

type SubstitutionScenario = {
  name: string;
  config: unknown;
  env: Record<string, string>;
  expected: unknown;
};

type MissingEnvScenario = {
  name: string;
  config: unknown;
  env: Record<string, string>;
  varName: string;
  configPath: string;
};

function expectResolvedScenarios(scenarios: SubstitutionScenario[]) {
  for (const scenario of scenarios) {
    const result = resolveConfigEnvVars(scenario.config, scenario.env);
    expect(result, scenario.name).toEqual(scenario.expected);
  }
}

function expectMissingScenarios(scenarios: MissingEnvScenario[]) {
  for (const scenario of scenarios) {
    try {
      resolveConfigEnvVars(scenario.config, scenario.env);
      expect.fail(`${scenario.name}: expected MissingEnvVarError`);
    } catch (err) {
      expect(err, scenario.name).toBeInstanceOf(MissingEnvVarError);
      const error = err as MissingEnvVarError;
      expect(error.varName, scenario.name).toBe(scenario.varName);
      expect(error.configPath, scenario.name).toBe(scenario.configPath);
    }
  }
}

describe("resolveConfigEnvVars", () => {
  describe("basic substitution", () => {
    it("substitutes direct, inline, repeated, and multi-var patterns", () => {
      const scenarios: SubstitutionScenario[] = [
        {
          name: "single env var",
          config: { key: "${FOO}" },
          env: { FOO: "bar" },
          expected: { key: "bar" },
        },
        {
          name: "multiple env vars in same string",
          config: { key: "${A}/${B}" },
          env: { A: "x", B: "y" },
          expected: { key: "x/y" },
        },
        {
          name: "inline prefix/suffix",
          config: { key: "prefix-${FOO}-suffix" },
          env: { FOO: "bar" },
          expected: { key: "prefix-bar-suffix" },
        },
        {
          name: "same var repeated",
          config: { key: "${FOO}:${FOO}" },
          env: { FOO: "bar" },
          expected: { key: "bar:bar" },
        },
      ];

      expectResolvedScenarios(scenarios);
    });
  });

  describe("nested structures", () => {
    it("substitutes variables in nested objects and arrays", () => {
      const scenarios: SubstitutionScenario[] = [
        {
          name: "nested object",
          config: { outer: { inner: { key: "${API_KEY}" } } },
          env: { API_KEY: "secret123" },
          expected: { outer: { inner: { key: "secret123" } } },
        },
        {
          name: "flat array",
          config: { items: ["${A}", "${B}", "${C}"] },
          env: { A: "1", B: "2", C: "3" },
          expected: { items: ["1", "2", "3"] },
        },
        {
          name: "array of objects",
          config: {
            providers: [
              { name: "openai", apiKey: "${OPENAI_KEY}" },
              { name: "anthropic", apiKey: "${ANTHROPIC_KEY}" },
            ],
          },
          env: { OPENAI_KEY: "sk-xxx", ANTHROPIC_KEY: "sk-yyy" },
          expected: {
            providers: [
              { name: "openai", apiKey: "sk-xxx" },
              { name: "anthropic", apiKey: "sk-yyy" },
            ],
          },
        },
      ];

      expectResolvedScenarios(scenarios);
    });
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

  describe("missing env var handling", () => {
    it("throws MissingEnvVarError with var name and config path details", () => {
      const scenarios: MissingEnvScenario[] = [
        {
          name: "missing top-level var",
          config: { key: "${MISSING}" },
          env: {},
          varName: "MISSING",
          configPath: "key",
        },
        {
          name: "missing nested var",
          config: { outer: { inner: { key: "${MISSING_VAR}" } } },
          env: {},
          varName: "MISSING_VAR",
          configPath: "outer.inner.key",
        },
        {
          name: "missing var in array element",
          config: { items: ["ok", "${MISSING}"] },
          env: { OK: "val" },
          varName: "MISSING",
          configPath: "items[1]",
        },
        {
          name: "dotted plugin ID remains one record key",
          config: { plugins: { entries: { "foo.config.bar": { token: "${MISSING}" } } } },
          env: {},
          varName: "MISSING",
          configPath: 'plugins.entries["foo.config.bar"].token',
        },
        {
          name: "dotted header remains one record key",
          config: {
            plugins: { entries: { fixture: { config: { headers: { "X.Trace": "${MISSING}" } } } } },
          },
          env: {},
          varName: "MISSING",
          configPath: 'plugins.entries.fixture.config.headers["X.Trace"]',
        },
        {
          name: "nested header segments remain dotted",
          config: {
            plugins: {
              entries: { fixture: { config: { headers: { X: { Trace: "${MISSING}" } } } } },
            },
          },
          env: {},
          varName: "MISSING",
          configPath: "plugins.entries.fixture.config.headers.X.Trace",
        },
        {
          name: "numeric-looking record key is not an array index",
          config: {
            plugins: { entries: { fixture: { config: { headers: { "0": "${MISSING}" } } } } },
          },
          env: {},
          varName: "MISSING",
          configPath: 'plugins.entries.fixture.config.headers["0"]',
        },
        {
          name: "dotted non-plugin record key is one quoted segment",
          config: { "root.key": "${MISSING}" },
          env: {},
          varName: "MISSING",
          configPath: '["root.key"]',
        },
        {
          name: "plugin config array indices remain canonical",
          config: {
            plugins: { entries: { fixture: { config: { headers: ["${MISSING}"] } } } },
          },
          env: {},
          varName: "MISSING",
          configPath: "plugins.entries.fixture.config.headers[0]",
        },
        {
          name: "hyphenated record key keeps its existing dotted spelling",
          config: { providers: { "vercel-gateway": { apiKey: "${MISSING}" } } },
          env: {},
          varName: "MISSING",
          configPath: "providers.vercel-gateway.apiKey",
        },
        {
          name: "empty string env value treated as missing",
          config: { key: "${EMPTY}" },
          env: { EMPTY: "" },
          varName: "EMPTY",
          configPath: "key",
        },
      ];

      expectMissingScenarios(scenarios);
    });
  });

  describe("escape syntax", () => {
    it("handles escaped placeholders alongside regular substitutions", () => {
      const scenarios: SubstitutionScenario[] = [
        {
          name: "escaped placeholder stays literal",
          config: { key: "$${VAR}" },
          env: { VAR: "value" },
          expected: { key: "${VAR}" },
        },
        {
          name: "mix of escaped and unescaped vars",
          config: { key: "${REAL}/$${LITERAL}" },
          env: { REAL: "resolved" },
          expected: { key: "resolved/${LITERAL}" },
        },
        {
          name: "escaped first, unescaped second",
          config: { key: "$${FOO} ${FOO}" },
          env: { FOO: "bar" },
          expected: { key: "${FOO} bar" },
        },
        {
          name: "unescaped first, escaped second",
          config: { key: "${FOO} $${FOO}" },
          env: { FOO: "bar" },
          expected: { key: "bar ${FOO}" },
        },
        {
          name: "multiple escaped placeholders",
          config: { key: "$${A}:$${B}" },
          env: {},
          expected: { key: "${A}:${B}" },
        },
        {
          name: "env values are not unescaped",
          config: { key: "${FOO}" },
          env: { FOO: "$${BAR}" },
          expected: { key: "$${BAR}" },
        },
      ];

      expectResolvedScenarios(scenarios);
    });
  });

  describe("pattern matching rules", () => {
    it("leaves non-matching placeholders unchanged", () => {
      const scenarios: SubstitutionScenario[] = [
        {
          name: "$VAR (no braces)",
          config: { key: "$VAR" },
          env: { VAR: "value" },
          expected: { key: "$VAR" },
        },
        {
          name: "lowercase placeholder",
          config: { key: "${lowercase}" },
          env: { lowercase: "value" },
          expected: { key: "${lowercase}" },
        },
        {
          name: "mixed-case placeholder",
          config: { key: "${MixedCase}" },
          env: { MixedCase: "value" },
          expected: { key: "${MixedCase}" },
        },
        {
          name: "invalid numeric prefix",
          config: { key: "${123INVALID}" },
          env: {},
          expected: { key: "${123INVALID}" },
        },
      ];

      expectResolvedScenarios(scenarios);
    });

    it("substitutes valid uppercase/underscore placeholder names", () => {
      const scenarios: SubstitutionScenario[] = [
        {
          name: "underscore-prefixed name",
          config: { key: "${_UNDERSCORE_START}" },
          env: { _UNDERSCORE_START: "valid" },
          expected: { key: "valid" },
        },
        {
          name: "name with numbers",
          config: { key: "${VAR_WITH_NUMBERS_123}" },
          env: { VAR_WITH_NUMBERS_123: "valid" },
          expected: { key: "valid" },
        },
      ];

      expectResolvedScenarios(scenarios);
    });
  });

  describe("passthrough behavior", () => {
    it("passes through primitives unchanged", () => {
      for (const value of ["hello", 42, true, null]) {
        expect(resolveConfigEnvVars(value, {})).toBe(value);
      }
    });

    it("preserves empty and non-string containers", () => {
      const scenarios: Array<{ config: unknown; expected: unknown }> = [
        { config: {}, expected: {} },
        { config: [], expected: [] },
        {
          config: { num: 42, bool: true, nil: null, arr: [1, 2] },
          expected: { num: 42, bool: true, nil: null, arr: [1, 2] },
        },
      ];

      for (const scenario of scenarios) {
        expect(resolveConfigEnvVars(scenario.config, {})).toEqual(scenario.expected);
      }
    });
  });

  describe("graceful missing env var handling (onMissing)", () => {
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

    it("collects multiple warnings across nested paths", () => {
      const warnings: EnvSubstitutionWarning[] = [];
      const result = resolveConfigEnvVars(
        {
          providers: {
            tts: { apiKey: "${TTS_KEY}" },
            stt: { apiKey: "${STT_KEY}" },
          },
          gateway: { token: "${GW_TOKEN}" },
        },
        { GW_TOKEN: "secret" },
        { onMissing: (w) => warnings.push(w) },
      );
      expect(result).toEqual({
        providers: {
          tts: { apiKey: "${TTS_KEY}" },
          stt: { apiKey: "${STT_KEY}" },
        },
        gateway: { token: "secret" },
      });
      expect(warnings).toHaveLength(2);
      expect(warnings[0]).toEqual({ varName: "TTS_KEY", configPath: "providers.tts.apiKey" });
      expect(warnings[1]).toEqual({ varName: "STT_KEY", configPath: "providers.stt.apiKey" });
    });
  });

  describe("containsEnvVarReference", () => {
    it("detects unresolved env var placeholders", () => {
      expect(containsEnvVarReference("${FOO}")).toBe(true);
      expect(containsEnvVarReference("prefix-${VAR}-suffix")).toBe(true);
      expect(containsEnvVarReference("${A}/${B}")).toBe(true);
      expect(containsEnvVarReference("${_UNDERSCORE}")).toBe(true);
      expect(containsEnvVarReference("${VAR_WITH_123}")).toBe(true);
    });

    it("returns false for non-matching patterns", () => {
      expect(containsEnvVarReference("no-refs-here")).toBe(false);
      expect(containsEnvVarReference("$VAR")).toBe(false);
      expect(containsEnvVarReference("${lowercase}")).toBe(false);
      expect(containsEnvVarReference("${MixedCase}")).toBe(false);
      expect(containsEnvVarReference("${123INVALID}")).toBe(false);
      expect(containsEnvVarReference("")).toBe(false);
    });

    it("returns false for escaped placeholders", () => {
      expect(containsEnvVarReference("$${ESCAPED}")).toBe(false);
      expect(containsEnvVarReference("prefix-$${ESCAPED}-suffix")).toBe(false);
    });

    it("detects references mixed with escaped placeholders", () => {
      expect(containsEnvVarReference("$${ESCAPED} ${REAL}")).toBe(true);
      expect(containsEnvVarReference("${REAL} $${ESCAPED}")).toBe(true);
    });
  });

  describe("default value syntax", () => {
    it("resolves ${VAR:-default} from the fallback, the env value, or an empty fallback", () => {
      const scenarios: SubstitutionScenario[] = [
        {
          name: "filed case: unset var falls back to the default",
          config: { env: { NAUTOBOT_TIMEOUT: "${NAUTOBOT_TIMEOUT:-60}" } },
          env: {},
          expected: { env: { NAUTOBOT_TIMEOUT: "60" } },
        },
        {
          name: "set var wins over the default",
          config: { env: { NAUTOBOT_TIMEOUT: "${NAUTOBOT_TIMEOUT:-60}" } },
          env: { NAUTOBOT_TIMEOUT: "90" },
          expected: { env: { NAUTOBOT_TIMEOUT: "90" } },
        },
        {
          name: "empty var takes the default, matching existing missing-var semantics",
          config: { env: { NAUTOBOT_TIMEOUT: "${NAUTOBOT_TIMEOUT:-60}" } },
          env: { NAUTOBOT_TIMEOUT: "" },
          expected: { env: { NAUTOBOT_TIMEOUT: "60" } },
        },
        {
          name: "empty fallback resolves to an empty string",
          config: { key: "${OPTIONAL_SUFFIX:-}" },
          env: {},
          expected: { key: "" },
        },
        {
          name: "fallback is used inline",
          config: { key: "https://${API_HOST:-api.example.com}/v1" },
          env: {},
          expected: { key: "https://api.example.com/v1" },
        },
        {
          name: "multiple references in one string mix resolved and fallback",
          config: { key: "${API_HOST:-localhost}:${API_PORT:-8080}" },
          env: { API_HOST: "example.com" },
          expected: { key: "example.com:8080" },
        },
        {
          name: "fallback text is preserved verbatim",
          config: { key: "${VAR:-a b  c}" },
          env: {},
          expected: { key: "a b  c" },
        },
        {
          name: "fallback may itself contain the operator",
          config: { key: "${VAR:-:-}" },
          env: {},
          expected: { key: ":-" },
        },
        {
          name: "fallback may start with a dash",
          config: { key: "${VAR:--5}" },
          env: {},
          expected: { key: "-5" },
        },
      ];

      expectResolvedScenarios(scenarios);
    });

    it("treats a fallback as a resolution, so no warning is collected", () => {
      const warnings: EnvSubstitutionWarning[] = [];
      const resolved = resolveConfigEnvVars(
        {
          mcp: { servers: { nautobot: { env: { NAUTOBOT_TIMEOUT: "${NAUTOBOT_TIMEOUT:-60}" } } } },
        },
        {},
        { onMissing: (warning) => warnings.push(warning) },
      );

      expect(resolved).toEqual({
        mcp: { servers: { nautobot: { env: { NAUTOBOT_TIMEOUT: "60" } } } },
      });
      expect(warnings).toEqual([]);
    });

    it("does not throw MissingEnvVarError when a fallback is authored", () => {
      expect(resolveConfigEnvVars({ key: "${ABSENT_VAR:-fallback}" }, {})).toEqual({
        key: "fallback",
      });
      // A bare reference with no fallback keeps throwing.
      expect(() => resolveConfigEnvVars({ key: "${ABSENT_VAR}" }, {})).toThrow(MissingEnvVarError);
    });

    it("keeps the escape winning over the fallback form", () => {
      const scenarios: SubstitutionScenario[] = [
        {
          name: "escaped fallback form stays a literal even when the var is set",
          config: { key: "$${VAR:-x}" },
          env: { VAR: "from-env" },
          expected: { key: "${VAR:-x}" },
        },
        {
          name: "escaped fallback form stays a literal when the var is unset",
          config: { key: "$${VAR:-x}" },
          env: {},
          expected: { key: "${VAR:-x}" },
        },
      ];

      expectResolvedScenarios(scenarios);
    });

    it("leaves every operator other than :- untouched", () => {
      const scenarios: SubstitutionScenario[] = [
        { name: "assign", config: { key: "${VAR:=d}" }, env: {}, expected: { key: "${VAR:=d}" } },
        { name: "error", config: { key: "${VAR:?m}" }, env: {}, expected: { key: "${VAR:?m}" } },
        { name: "alt", config: { key: "${VAR:+a}" }, env: {}, expected: { key: "${VAR:+a}" } },
        {
          name: "unset-only dash is not supported; empty and unset are one state here",
          config: { key: "${VAR-d}" },
          env: {},
          expected: { key: "${VAR-d}" },
        },
        { name: "prefix", config: { key: "${VAR#p}" }, env: {}, expected: { key: "${VAR#p}" } },
        { name: "suffix", config: { key: "${VAR%s}" }, env: {}, expected: { key: "${VAR%s}" } },
        {
          name: "replace",
          config: { key: "${VAR/a/b}" },
          env: {},
          expected: { key: "${VAR/a/b}" },
        },
        {
          name: "json modifier proposed by PR #95603 does not collide with :-",
          config: { key: "${VAR:json}" },
          env: {},
          expected: { key: "${VAR:json}" },
        },
      ];

      expectResolvedScenarios(scenarios);
    });

    it("requires a valid uppercase name to the left of the operator", () => {
      const scenarios: SubstitutionScenario[] = [
        {
          name: "lowercase name",
          config: { key: "${lowercase:-d}" },
          env: { lowercase: "value" },
          expected: { key: "${lowercase:-d}" },
        },
        {
          name: "mixed-case name",
          config: { key: "${MixedCase:-d}" },
          env: {},
          expected: { key: "${MixedCase:-d}" },
        },
        {
          name: "numeric prefix",
          config: { key: "${123INVALID:-d}" },
          env: {},
          expected: { key: "${123INVALID:-d}" },
        },
        { name: "empty name", config: { key: "${:-d}" }, env: {}, expected: { key: "${:-d}" } },
        {
          name: "other template dialects stay untouched",
          config: { key: "${my-service} ${count+1} ${a=b}" },
          env: {},
          expected: { key: "${my-service} ${count+1} ${a=b}" },
        },
      ];

      expectResolvedScenarios(scenarios);
    });

    it("does not change how a fallback containing $ or { is handled", () => {
      // The fallback grammar deliberately excludes "$" and "{" so the scan for the closing
      // brace stays a plain indexOf("}"). These inputs therefore resolve exactly as they do
      // without default-value support: the outer expression stays literal and only a valid
      // inner reference substitutes.
      const scenarios: SubstitutionScenario[] = [
        {
          name: "nested reference: outer literal, inner substitutes",
          config: { key: "${A:-${B}}" },
          env: { A: "a-value", B: "b-value" },
          expected: { key: "${A:-b-value}" },
        },
        {
          name: "nested reference with both unset",
          config: { key: "${A:-${B:-c}}" },
          env: {},
          expected: { key: "${A:-c}" },
        },
        {
          name: "fallback containing a brace",
          config: { key: '${A:-{"n":1}}' },
          env: {},
          expected: { key: '${A:-{"n":1}}' },
        },
        {
          name: "fallback containing a bare dollar",
          config: { key: "${PRICE:-$5}" },
          env: {},
          expected: { key: "${PRICE:-$5}" },
        },
      ];

      expectResolvedScenarios(scenarios);
    });

    it("counts a fallback reference as an env var reference", () => {
      expect(containsEnvVarReference("${VAR:-x}")).toBe(true);
      expect(containsEnvVarReference("prefix-${VAR:-x}")).toBe(true);
      expect(containsEnvVarReference("${VAR:-}")).toBe(true);
      // Escaped and unsupported forms are still not references.
      expect(containsEnvVarReference("$${VAR:-x}")).toBe(false);
      expect(containsEnvVarReference("${VAR:=x}")).toBe(false);
      expect(containsEnvVarReference("${VAR-x}")).toBe(false);
      expect(containsEnvVarReference("${lowercase:-x}")).toBe(false);
    });
  });
});
