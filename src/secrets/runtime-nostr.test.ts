import { describe, expect, it } from "vitest";
import {
  assertSecretOwnerAvailable,
  SecretSurfaceUnavailableError,
} from "./runtime-degraded-state.js";
import { activateSecretsRuntimeSnapshotState } from "./runtime-state.js";
import { asConfig, setupSecretsRuntimeSnapshotTestHooks } from "./runtime.test-support.ts";

const { prepareSecretsRuntimeSnapshot } = setupSecretsRuntimeSnapshotTestHooks();
const NOSTR_TEST_PRIVATE_KEY = "1".repeat(64);

describe("Nostr SecretRef runtime ownership", () => {
  it("materializes a private key for the normalized account owner", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        channels: {
          nostr: {
            defaultAccount: "Team.A",
            privateKey: { source: "env", provider: "default", id: "NOSTR_ENV_KEY" },
          },
        },
      }),
      env: { NOSTR_ENV_KEY: NOSTR_TEST_PRIVATE_KEY },
      includeAuthStoreRefs: false,
      loadablePluginOrigins: new Map([["nostr", "bundled"]]),
    });

    expect(snapshot.config.channels?.nostr?.privateKey).toBe(NOSTR_TEST_PRIVATE_KEY);
    expect(snapshot.secretOwners).toEqual([
      expect.objectContaining({ ownerKind: "account", ownerId: "nostr:team-a" }),
    ]);
    expect(snapshot.degradedOwners).toEqual([]);
  });

  it("keeps a missing named account cold while its healthy channel sibling remains available", async () => {
    const missingRef = { source: "env", provider: "default", id: "MISSING_NOSTR_KEY" } as const;
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        channels: {
          nostr: { defaultAccount: "Team.A", privateKey: missingRef },
          telegram: {
            botToken: { source: "env", provider: "default", id: "HEALTHY_TELEGRAM_TOKEN" },
          },
        },
      }),
      env: {
        NOSTR_PRIVATE_KEY: NOSTR_TEST_PRIVATE_KEY,
        HEALTHY_TELEGRAM_TOKEN: "123:healthy-token",
      },
      includeAuthStoreRefs: false,
      allowUnavailableSecretOwners: true,
      loadablePluginOrigins: new Map([
        ["nostr", "bundled"],
        ["telegram", "bundled"],
      ]),
    });

    expect(snapshot.config.channels?.nostr?.privateKey).toEqual(missingRef);
    expect(snapshot.config.channels?.telegram?.botToken).toBe("123:healthy-token");
    expect(snapshot.degradedOwners).toEqual([
      expect.objectContaining({
        ownerKind: "account",
        ownerId: "nostr:team-a",
        state: "unavailable",
        degradationState: "cold",
        paths: ["channels.nostr.privateKey"],
      }),
    ]);

    activateSecretsRuntimeSnapshotState({
      snapshot,
      refreshContext: null,
      refreshHandler: null,
    });
    expect(() => assertSecretOwnerAvailable("account", "nostr:team-a")).toThrow(
      SecretSurfaceUnavailableError,
    );
    expect(() => assertSecretOwnerAvailable("account", "telegram:default")).not.toThrow();
  });

  it("leaves a disabled exec SecretRef inactive without invoking its provider", async () => {
    const privateKey = { source: "exec", provider: "vault", id: "nostr/key" } as const;
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        secrets: {
          providers: {
            vault: {
              source: "exec",
              command: "/definitely/missing/nostr-secret-provider",
              jsonOnly: true,
            },
          },
        },
        channels: { nostr: { enabled: false, privateKey } },
      }),
      env: {},
      includeAuthStoreRefs: false,
      loadablePluginOrigins: new Map([["nostr", "bundled"]]),
    });

    expect(snapshot.config.channels?.nostr?.privateKey).toEqual(privateKey);
    expect(snapshot.degradedOwners).toEqual([]);
    expect(snapshot.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "SECRETS_REF_IGNORED_INACTIVE_SURFACE",
          path: "channels.nostr.privateKey",
        }),
      ]),
    );
  });
});
