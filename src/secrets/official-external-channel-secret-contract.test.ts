import { describe, expect, it } from "vitest";
import { loadOfficialExternalChannelSecretContractApi } from "./official-external-channel-secret-contract.js";
import { createResolverContext } from "./runtime-shared.js";

function secretRef(id: string) {
  return { source: "env" as const, provider: "default", id };
}

describe("official external channel secret contracts", () => {
  it("binds active QQBot SecretRefs to their exact account owners", () => {
    const config = {
      channels: {
        qqbot: {
          appId: "root-app",
          clientSecret: secretRef("QQBOT_ROOT_SECRET"),
          accounts: {
            "Named.Team": {
              appId: "named-app",
              clientSecret: secretRef("QQBOT_NAMED_SECRET"),
            },
          },
        },
      },
    };
    const context = createResolverContext({ sourceConfig: config, env: {} });
    const api = loadOfficialExternalChannelSecretContractApi("qqbot");

    api?.collectRuntimeConfigAssignments({ config, defaults: undefined, context });

    expect(context.assignments).toEqual([
      expect.objectContaining({
        path: "channels.qqbot.clientSecret",
        ownerKind: "account",
        ownerId: "qqbot:default",
        requiredForGateway: false,
        disposition: "isolate",
        ownerContractDigest: expect.any(String),
      }),
      expect.objectContaining({
        path: 'channels.qqbot.accounts["Named.Team"].clientSecret',
        ownerKind: "account",
        ownerId: "qqbot:named-team",
        requiredForGateway: false,
        disposition: "isolate",
        ownerContractDigest: expect.any(String),
      }),
    ]);
    context.assignments[0]?.apply("resolved-root-secret");
    context.assignments[1]?.apply("resolved-named-secret");
    expect(config.channels.qqbot.clientSecret).toBe("resolved-root-secret");
    expect(config.channels.qqbot.accounts["Named.Team"].clientSecret).toBe("resolved-named-secret");
  });

  it("uses QQBOT_APP_ID only for the default account and skips inactive credentials", () => {
    const config = {
      channels: {
        qqbot: {
          clientSecret: secretRef("QQBOT_ROOT_SECRET"),
          accounts: {
            disabled: {
              enabled: false,
              appId: "disabled-app",
              clientSecret: secretRef("QQBOT_DISABLED_SECRET"),
            },
            missingAppId: {
              clientSecret: secretRef("QQBOT_MISSING_APP_SECRET"),
            },
          },
        },
      },
    };
    const context = createResolverContext({
      sourceConfig: config,
      env: { QQBOT_APP_ID: "env-app" },
    });
    const api = loadOfficialExternalChannelSecretContractApi("qqbot");

    api?.collectRuntimeConfigAssignments({ config, defaults: undefined, context });

    expect(context.assignments.map((assignment) => assignment.path)).toEqual([
      "channels.qqbot.clientSecret",
    ]);
    expect(config.channels.qqbot).toHaveProperty("appId", "env-app");
    expect(context.warnings.map((warning) => warning.path)).toEqual([
      "channels.qqbot.accounts.disabled.clientSecret",
      "channels.qqbot.accounts.missingAppId.clientSecret",
    ]);
  });
});
