import { describe, expect, it } from "vitest";
import "./runtime-matrix.test-support.ts";
import {
  asConfig,
  loadAuthStoreWithProfiles,
  setupSecretsRuntimeSnapshotTestHooks,
} from "./runtime.test-support.ts";

const { prepareSecretsRuntimeSnapshot } = setupSecretsRuntimeSnapshotTestHooks();

function envRef(id: string) {
  return { source: "env", provider: "default", id } as const;
}

function prepareMatrix(
  matrix: Record<string, unknown>,
  env: NodeJS.ProcessEnv = {},
  allowUnavailableSecretOwners = false,
) {
  return prepareSecretsRuntimeSnapshot({
    config: asConfig({ channels: { matrix } }),
    env,
    allowUnavailableSecretOwners,
    agentDirs: ["/tmp/openclaw-agent-main"],
    loadAuthStore: () => loadAuthStoreWithProfiles({}),
  });
}

function expectInactiveSurfaceWarning(
  snapshot: Awaited<ReturnType<typeof prepareSecretsRuntimeSnapshot>>,
  path: string,
): void {
  expect(snapshot.warnings).toContainEqual(
    expect.objectContaining({ code: "SECRETS_REF_IGNORED_INACTIVE_SURFACE", path }),
  );
}

describe("secrets runtime snapshot matrix shadowing", () => {
  it("ignores Matrix password refs that are shadowed by scoped env access tokens", async () => {
    const snapshot = await prepareMatrix(
      { accounts: { ops: { password: envRef("MATRIX_OPS_PASSWORD") } } },
      { MATRIX_OPS_ACCESS_TOKEN: "ops-token" },
    );

    expect(
      (snapshot.config.channels?.matrix?.accounts?.ops as { password?: unknown } | undefined)
        ?.password,
    ).toEqual(envRef("MATRIX_OPS_PASSWORD"));
    expectInactiveSurfaceWarning(snapshot, "channels.matrix.accounts.ops.password");
  });

  it.each([
    {
      name: "channels.matrix.accounts.default.accessToken SecretRef config",
      config: {
        password: envRef("MATRIX_PASSWORD"),
        accounts: { default: { accessToken: envRef("MATRIX_DEFAULT_ACCESS_TOKEN_REF") } },
      },
      env: {
        MATRIX_DEFAULT_ACCESS_TOKEN_REF: "default-token",
      },
    },
    {
      name: "channels.matrix.accounts.default.password config",
      config: {
        password: envRef("MATRIX_PASSWORD"),
        accounts: { default: { password: "fixture" } },
      },
      env: {},
    },
    {
      name: "MATRIX_DEFAULT_ACCESS_TOKEN env auth",
      config: { password: envRef("MATRIX_PASSWORD") },
      env: {
        MATRIX_DEFAULT_ACCESS_TOKEN: "default-token",
      },
    },
  ])("ignores top-level Matrix password refs shadowed by $name", async ({ config, env }) => {
    const snapshot = await prepareMatrix(config, env);

    expect(snapshot.config.channels?.matrix?.password).toEqual(envRef("MATRIX_PASSWORD"));
    expectInactiveSurfaceWarning(snapshot, "channels.matrix.password");
  });

  it("ignores a top-level accessToken ref shadowed by the default account", async () => {
    const snapshot = await prepareMatrix(
      {
        accessToken: envRef("MISSING_MATRIX_ROOT_ACCESS_TOKEN"),
        accounts: { default: { accessToken: "fixture" } },
      },
      {},
      true,
    );

    expect(snapshot.config.channels?.matrix?.accessToken).toEqual(
      envRef("MISSING_MATRIX_ROOT_ACCESS_TOKEN"),
    );
    expect(snapshot.degradedOwners).toStrictEqual([]);
    expectInactiveSurfaceWarning(snapshot, "channels.matrix.accessToken");
  });

  it.each([
    {
      name: "top-level Matrix accessToken SecretRef config",
      config: {
        accessToken: envRef("MATRIX_ACCESS_TOKEN_REF"),
        accounts: { default: { password: envRef("MATRIX_DEFAULT_PASSWORD") } },
      },
      env: {
        MATRIX_ACCESS_TOKEN_REF: "default-token",
      },
    },
    {
      name: "MATRIX_ACCESS_TOKEN env auth",
      config: { accounts: { default: { password: envRef("MATRIX_DEFAULT_PASSWORD") } } },
      env: {
        MATRIX_ACCESS_TOKEN: "default-token",
      },
    },
  ])("ignores default-account Matrix password refs shadowed by $name", async ({ config, env }) => {
    const snapshot = await prepareMatrix(config, env);

    expect(
      (snapshot.config.channels?.matrix?.accounts?.default as { password?: unknown } | undefined)
        ?.password,
    ).toEqual(envRef("MATRIX_DEFAULT_PASSWORD"));
    expectInactiveSurfaceWarning(snapshot, "channels.matrix.accounts.default.password");
  });
});
