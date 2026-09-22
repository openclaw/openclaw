import { describe, expect, it } from "vitest";
import {
  createConfigResolutionFacts,
  setConfigResolutionFacts,
} from "../config/resolution-facts.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { inspectPluginCredentialValue } from "./credential-inspection.js";

const path = ["plugins", "entries", "example", "config", "search", "key"];
const descriptor = { path, label: "Search key", envVars: ["EXAMPLE_KEY"] };
const config = (value: unknown): OpenClawConfig => ({
  plugins: { entries: { example: { config: { search: { key: value } } } } },
});

describe("plugin credential authoring boundary", () => {
  it("keeps ordinary inspection redacted and never reveals environment values", () => {
    expect(inspectPluginCredentialValue(config("literal-private"), descriptor, {})).toEqual({
      kind: "literal",
    });
    expect(
      inspectPluginCredentialValue(
        config(undefined),
        descriptor,
        { EXAMPLE_KEY: "env-private" },
        true,
      ),
    ).toEqual({ kind: "environment", envVar: "EXAMPLE_KEY" });
    expect(inspectPluginCredentialValue(config(undefined), descriptor, {}, true)).toEqual({
      kind: "missing",
    });
  });

  it.each([
    { source: "env", provider: "default", id: "EXAMPLE_KEY" },
    { source: "file", provider: "vault", id: "/search/key" },
    { source: "exec", provider: "vault", id: "team/search" },
    { source: "store", provider: "default", id: "SEARCH_KEY" },
  ])("returns the exact authored $source pointer without resolution", (ref) => {
    expect(inspectPluginCredentialValue(config(ref), descriptor, {}, true)).toEqual({
      kind: "reference",
      ref,
      unresolved: false,
    });
  });

  it("recovers an env shorthand pointer from loader facts instead of exposing its decoded value", () => {
    const loaded = config("resolved-private");
    setConfigResolutionFacts(
      loaded,
      createConfigResolutionFacts(
        [],
        new Map(),
        "default",
        new Map([[path.join("."), "EXAMPLE_KEY"]]),
      ),
    );
    expect(inspectPluginCredentialValue(loaded, descriptor, {}, true)).toEqual({
      kind: "reference",
      ref: { source: "env", provider: "default", id: "EXAMPLE_KEY" },
      unresolved: false,
    });
  });

  it("keeps an unresolved authored reference inspectable and rejects malformed values", () => {
    const loaded = config("${EXAMPLE_KEY}");
    setConfigResolutionFacts(
      loaded,
      createConfigResolutionFacts(
        [{ configPath: path.join("."), varName: "EXAMPLE_KEY" }],
        new Map([[path.join("."), "EXAMPLE_KEY"]]),
      ),
    );
    expect(inspectPluginCredentialValue(loaded, descriptor, {}, true)).toMatchObject({
      kind: "reference",
      unresolved: true,
    });
    expect(
      inspectPluginCredentialValue(
        config({ source: "file", provider: "vault", id: "../private" }),
        descriptor,
        {},
      ),
    ).toEqual({ kind: "invalid" });
  });
});
