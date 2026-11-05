import { expect, it } from "vitest";
import "./runtime-matrix.test-support.ts";
import { getPath, setPathCreateStrict } from "./path-utils.js";
import {
  asConfig,
  loadAuthStoreWithProfiles,
  setupSecretsRuntimeSnapshotTestHooks,
} from "./runtime.test-support.ts";

const { prepareSecretsRuntimeSnapshot } = setupSecretsRuntimeSnapshotTestHooks();
const envRef = (id: string) => ({ source: "env", provider: "default", id });

it.each([
  ["accounts.ops.password", "MATRIX_OPS_PASSWORD", {}, { MATRIX_OPS_ACCESS_TOKEN: "ops-token" }],
  [
    "password",
    "MATRIX_PASSWORD",
    { accounts: { default: { accessToken: envRef("MATRIX_DEFAULT_ACCESS_TOKEN_REF") } } },
    { MATRIX_DEFAULT_ACCESS_TOKEN_REF: "default-token" },
  ],
  ["password", "MATRIX_PASSWORD", { accounts: { default: { password: "fixture" } } }, {}],
  ["password", "MATRIX_PASSWORD", {}, { MATRIX_DEFAULT_ACCESS_TOKEN: "default-token" }],
  [
    "accessToken",
    "MISSING_MATRIX_ROOT_ACCESS_TOKEN",
    { accounts: { default: { accessToken: "fixture" } } },
    {},
  ],
  [
    "accounts.default.password",
    "MATRIX_DEFAULT_PASSWORD",
    { accessToken: envRef("MATRIX_ACCESS_TOKEN_REF") },
    { MATRIX_ACCESS_TOKEN_REF: "default-token" },
  ],
  [
    "accounts.default.password",
    "MATRIX_DEFAULT_PASSWORD",
    {},
    { MATRIX_ACCESS_TOKEN: "default-token" },
  ],
] as const)("ignores Matrix %s (%s) shadowed by %j / %j", async (field, id, overrides, env) => {
  const ref = envRef(id);
  const matrix = structuredClone(overrides);
  setPathCreateStrict(matrix, field.split("."), ref);
  const snapshot = await prepareSecretsRuntimeSnapshot({
    config: asConfig({ channels: { matrix } }),
    env,
    allowUnavailableSecretOwners: field === "accessToken",
    agentDirs: ["/tmp/openclaw-agent-main"],
    loadAuthStore: () => loadAuthStoreWithProfiles({}),
  });
  const path = `channels.matrix.${field}`;
  expect(getPath(snapshot.config, path.split("."))).toEqual(ref);
  expect(snapshot.warnings).toContainEqual(
    expect.objectContaining({ code: "SECRETS_REF_IGNORED_INACTIVE_SURFACE", path }),
  );
  if (field === "accessToken") {
    expect(snapshot.degradedOwners).toStrictEqual([]);
  }
});
