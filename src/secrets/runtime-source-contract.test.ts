import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  collectSecretStoreRefKeysInSnapshot,
  hasSameSecretReloadContract,
} from "./runtime-source-contract.js";

describe("secrets runtime source contract", () => {
  it("finds canonical store refs without interpreting providerless or other-source values", () => {
    const config: OpenClawConfig = {
      secrets: { defaults: { store: "default" } },
      models: {
        providers: {
          one: {
            baseUrl: "https://example.invalid/v1",
            apiKey: { source: "store", provider: "default", id: "TEAM_API_KEY" },
            models: [],
          },
        },
      },
    };
    expect(
      collectSecretStoreRefKeysInSnapshot({ sourceConfig: config, authStores: [] }, "TEAM_API_KEY"),
    ).toEqual(new Set(["store:default:TEAM_API_KEY"]));
    expect(
      collectSecretStoreRefKeysInSnapshot(
        {
          sourceConfig: {
            plugins: {
              entries: { sample: { config: { apiKey: { source: "store", id: "TEAM_API_KEY" } } } },
            },
          },
          authStores: [],
        },
        "TEAM_API_KEY",
      ),
    ).toEqual(new Set());
    expect(
      collectSecretStoreRefKeysInSnapshot(
        {
          sourceConfig: {
            gateway: {
              auth: { token: { source: "env", provider: "default", id: "TEAM_API_KEY" } },
            },
          },
          authStores: [],
        },
        "TEAM_API_KEY",
      ),
    ).toEqual(new Set());
  });

  it("includes env shorthand SecretRefs in the reload contract", () => {
    const configWithRef = (apiKey: string): OpenClawConfig => ({
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            apiKey,
            models: [],
          },
        },
      },
    });

    expect(
      hasSameSecretReloadContract(
        configWithRef("$OPENAI_API_KEY"),
        configWithRef("$OPENAI_API_KEY"),
      ),
    ).toBe(true);
    expect(
      hasSameSecretReloadContract(
        configWithRef("$OPENAI_API_KEY"),
        configWithRef("$OPENAI_API_KEY_NEXT"),
      ),
    ).toBe(false);
  });
});
