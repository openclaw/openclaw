import { expect, it } from "vitest";
import type { ProviderSyntheticAuthResult } from "./provider-external-auth.types.js";
import type { ProviderPlugin } from "./provider-plugin.types.js";
import {
  prepareSyntheticAuthWithProvider,
  readPreparedSyntheticAuthFact,
  restorePreparedSyntheticAuthFacts,
} from "./provider-synthetic-auth.js";

it("resolves native dependencies from the loader-owned plugin root", async () => {
  let prepared: ProviderSyntheticAuthResult | undefined;
  const provider: ProviderPlugin = {
    id: "native",
    label: "Native",
    auth: [],
    pluginRoot: "/plugins/native-package",
    async prepareSyntheticAuth({ pluginRoot }) {
      prepared = pluginRoot
        ? { apiKey: "native-presence", mode: "api-key", source: pluginRoot }
        : undefined;
      return prepared;
    },
  };
  const result = await prepareSyntheticAuthWithProvider(provider, {
    config: {},
    provider: "native",
  });
  expect(result).toMatchObject({
    source: "/plugins/native-package",
  });
  expect(result).toBe(prepared);
});

it.each([false, true])(
  "retains restored process auth after env replacement (explicit=%s)",
  (explicit) => {
    const originalEnv = process.env;
    const context = { config: {}, provider: "native-auth" };
    const result: ProviderSyntheticAuthResult = {
      apiKey: "native-marker",
      source: "native auth",
      mode: "oauth",
    };
    try {
      process.env = { ...originalEnv };
      const env = process.env;
      const options = { workspaceDir: "/workspace", ...(explicit ? { env } : {}) };
      restorePreparedSyntheticAuthFacts(
        [{ providerRef: context.provider, result }],
        [{ config: context.config, ...options }],
      );
      process.env = { ...env };
      expect(readPreparedSyntheticAuthFact(context, options)?.result).toEqual(result);
      expect(readPreparedSyntheticAuthFact(context, { ...options, env })?.result).toEqual(result);
      expect(
        readPreparedSyntheticAuthFact(context, { ...options, env: process.env })?.result,
      ).toEqual(result);
      expect(() => readPreparedSyntheticAuthFact(context, { ...options, env: {} })).toThrow(
        "environment or workspace does not match",
      );
    } finally {
      process.env = originalEnv;
    }
  },
);
