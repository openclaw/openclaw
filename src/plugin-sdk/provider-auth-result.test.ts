import { expect, it } from "vitest";
import { MAX_DATE_TIMESTAMP_MS } from "../../packages/normalization-core/src/number-coercion.js";
import { buildOauthProviderAuthResult } from "./provider-auth-result.js";
import { buildCatalogModel } from "./provider-catalog.test-support.js";

const auth = {
  providerId: "google",
  defaultModel: "google/gemini-3-pro-preview",
  access: "access-token",
};
const normalizedRef = "google/gemini-3.1-pro-preview";

it("normalizes retired Gemini defaults before emitting config patches", () => {
  const result = buildOauthProviderAuthResult(auth);

  expect(result.defaultModel).toBe("google/gemini-3.1-pro-preview");
  expect(result.configPatch).toEqual({
    agents: { defaults: { models: { [normalizedRef]: {} } } },
  });
});

it("normalizes retired Gemini refs inside explicit config patches", () => {
  const patch = (ref: string) => ({
    agents: {
      defaults: {
        model: { primary: ref, fallbacks: [ref, "openai/gpt-5.5"] },
        models: { [ref]: { alias: "gemini" } },
      },
    },
    models: {
      providers: {
        google: {
          baseUrl: "https://generativelanguage.googleapis.com/v1beta",
          headers: { Authorization: undefined, "X-Route": "keep" },
          models: [
            buildCatalogModel(ref, {
              name: "Gemini 3 Pro",
              contextWindow: 1_048_576,
              maxTokens: 65_536,
              reasoning: true,
            }),
          ],
        },
      },
    },
  });
  const result = buildOauthProviderAuthResult({ ...auth, configPatch: patch(auth.defaultModel) });

  expect(result.defaultModel).toBe("google/gemini-3.1-pro-preview");
  expect(result.configPatch).toEqual(patch(normalizedRef));

  expect(
    buildOauthProviderAuthResult({
      ...auth,
      defaultModel: normalizedRef,
      configPatch: result.configPatch,
    }).configPatch,
  ).toBe(result.configPatch);
});

it("omits OAuth expiry values outside the Date timestamp range", () => {
  const result = buildOauthProviderAuthResult({
    ...auth,
    defaultModel: normalizedRef,
    expires: MAX_DATE_TIMESTAMP_MS + 1,
  });

  expect(result.profiles[0]?.credential).toEqual({
    type: "oauth",
    provider: "google",
    access: "access-token",
  });
});
