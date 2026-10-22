import { describe, expect, it } from "vitest";
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

describe("resolveSecretInputString", () => {
  it("returns available for non-empty string value ${OPENAI_API_KEY}", () => {
    expect(resolveSecretInputString({ value: "${OPENAI_API_KEY}", path })).toEqual({
      status: "available",
      value: "${OPENAI_API_KEY}",
      ref: null,
    });
  });

  it("returns configured_unavailable for unresolved refs in inspect mode", () => {
    expect(resolveSecretInputString({ value: { ...ref }, path, mode: "inspect" })).toEqual(
      unavailable,
    );
  });

  it("prioritizes explicit refValue over retained plaintext in inspect mode", () => {
    expect(
      resolveSecretInputString({
        value: "retained-plaintext",
        refValue: { ...ref },
        path: "profiles.default.key",
        mode: "inspect",
      }),
    ).toEqual(unavailable);
  });

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
      resolveSecretInputString({ value: { ...ref }, path });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(UnresolvedSecretInputError);
    expect(isUnresolvedSecretInputError(thrown)).toBe(true);
    expect(thrown).toMatchObject({ path, ref });
  });
  it("keeps explicit references authoritative over retained plaintext in normalization", () => {
    expect(() =>
      normalizeResolvedSecretInputString({
        value: "retained-plaintext",
        refValue: { ...ref },
        path,
      }),
    ).toThrow(UnresolvedSecretInputError);
  });
  it("parses legacy env marker strings without making them valid SecretInput strings", () => {
    expect(parseLegacySecretRefEnvMarker("secretref-env:OPENAI_API_KEY")).toEqual(ref);
    expect(parseLegacySecretRefEnvMarker("__env__:BAILIAN_API_KEY")).toEqual({
      ...ref,
      id: "BAILIAN_API_KEY",
    });
    expect(parseLegacySecretRefEnvMarker("secretref-env:not-valid")).toBeNull();
    expect(
      resolveSecretInputString({
        value: "secretref-env:OPENAI_API_KEY",
        path,
        mode: "inspect",
      }),
    ).toEqual({
      status: "available",
      value: "secretref-env:OPENAI_API_KEY",
      ref: null,
    });
  });
});
