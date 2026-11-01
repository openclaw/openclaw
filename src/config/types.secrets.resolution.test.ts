import { expect, it } from "vitest";
import {
  isUnresolvedSecretInputError,
  normalizeResolvedSecretInputString,
  parseLegacySecretRefEnvMarker,
  resolveSecretInputString,
  UnresolvedSecretInputError,
} from "./types.secrets.js";

const ref = { source: "env", provider: "default", id: "OPENAI_API_KEY" } as const;
const path = "models.providers.openai.apiKey";
const unavailable = { status: "configured_unavailable", value: undefined, ref };

it.each([
  ["${OPENAI_API_KEY}", "strict"],
  ["secretref-env:OPENAI_API_KEY", "inspect"],
] as const)("preserves literal secret input %s", (value, mode) => {
  expect(resolveSecretInputString({ value, path, mode })).toEqual({
    status: "available",
    value,
    ref: null,
  });
});

it.each([{ value: ref }, { value: "retained-plaintext", refValue: ref }])(
  "reports unresolved references in inspect mode: %j",
  (input) => {
    expect(resolveSecretInputString({ ...input, path, mode: "inspect" })).toEqual(unavailable);
  },
);

it("returns missing when no value or ref is configured", () => {
  expect(resolveSecretInputString({ value: "", path, mode: "inspect" })).toEqual({
    status: "missing",
    value: undefined,
    ref: null,
  });
});

it("throws a typed unresolved SecretRef error in strict mode for inline ref", () => {
  let thrown: unknown;
  try {
    resolveSecretInputString({ value: ref, path });
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(UnresolvedSecretInputError);
  expect(isUnresolvedSecretInputError(thrown)).toBe(true);
  expect(thrown).toMatchObject({ path, ref });
});

it("keeps explicit references authoritative over retained plaintext in normalization", () => {
  expect(() =>
    normalizeResolvedSecretInputString({ value: "retained-plaintext", refValue: ref, path }),
  ).toThrow(UnresolvedSecretInputError);
});

it("parses legacy env markers without accepting malformed identifiers", () => {
  expect(parseLegacySecretRefEnvMarker("secretref-env:OPENAI_API_KEY")).toEqual(ref);
  expect(parseLegacySecretRefEnvMarker("__env__:BAILIAN_API_KEY")).toEqual({
    ...ref,
    id: "BAILIAN_API_KEY",
  });
  expect(parseLegacySecretRefEnvMarker("secretref-env:not-valid")).toBeNull();
});
