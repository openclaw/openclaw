import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { collectSecretStoreRefKeysInSnapshot } from "./runtime-state.js";

describe("secret store references", () => {
  it("finds canonical store refs without interpreting providerless or other-source values", () => {
    const config = {
      secrets: { defaults: { store: "default" } },
      models: {
        providers: {
          one: {
            apiKey: { source: "store", provider: "default", id: "TEAM_API_KEY" },
            models: [],
          },
        },
      },
    } as unknown as OpenClawConfig;
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
});
