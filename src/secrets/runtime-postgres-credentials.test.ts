import { afterEach, expect, it, vi } from "vitest";
import {
  sanitizeEnvVars,
  sanitizeExplicitSandboxEnvVars,
} from "../agents/sandbox/sanitize-env-vars.js";
import {
  createConfigResolutionFacts,
  setConfigResolutionFacts,
} from "../config/resolution-facts.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { omitGatewayCredentialEnv, sanitizeHostExecEnv } from "../infra/host-env-security.js";
import {
  activateSecretsRuntimeSnapshotState,
  getActiveSecretsRuntimeSnapshotRevisionState,
} from "./runtime-state.js";
import {
  activateSecretsRuntimeSnapshot,
  activateSecretsRuntimeSnapshotIfCurrent,
  clearSecretsRuntimeSnapshot,
  prepareSecretsRuntimeSnapshotRestore,
} from "./runtime.js";
import { setupSecretsRuntimeSnapshotTestHooks } from "./runtime.test-support.js";

const { prepareSecretsRuntimeSnapshot } = setupSecretsRuntimeSnapshotTestHooks();
const env = {
  WORKBOARD_PRIMARY: "postgresql:///first",
  WORKBOARD_NEXT: "postgresql:///next",
  SAFE: "kept",
};
afterEach(() => vi.unstubAllEnvs());

async function prepare(id: string, engine: "postgres" | "sqlite" = "postgres") {
  return await prepareSecretsRuntimeSnapshot({
    config: {
      database: { engine, postgres: { connection: { source: "env", provider: "default", id } } },
    },
    env,
    includeAuthStoreRefs: false,
    loadablePluginOrigins: new Map(),
  });
}

it("isolates only active PostgreSQL credentials through prepare, activation, replacement, rollback, and clear", async () => {
  for (const [name, value] of Object.entries(env)) {
    vi.stubEnv(name, value);
  }
  const first = await prepare("WORKBOARD_PRIMARY");
  const beforeActivation = sanitizeHostExecEnv({ baseEnv: env });
  expect(beforeActivation.WORKBOARD_PRIMARY).toBe(env.WORKBOARD_PRIMARY);
  activateSecretsRuntimeSnapshot(first);
  expect(sanitizeHostExecEnv({ baseEnv: env }).WORKBOARD_PRIMARY).toBeUndefined();
  expect(sanitizeEnvVars(env).allowed).toEqual({
    WORKBOARD_NEXT: env.WORKBOARD_NEXT,
    SAFE: "kept",
  });
  expect(omitGatewayCredentialEnv(beforeActivation).WORKBOARD_PRIMARY).toBeUndefined();
  expect(sanitizeExplicitSandboxEnvVars({ WORKBOARD_PRIMARY: "user-owned" }).allowed).toEqual({
    WORKBOARD_PRIMARY: "user-owned",
  });
  expect(omitGatewayCredentialEnv({ WORKBOARD_PRIMARY: "user-owned" }).WORKBOARD_PRIMARY).toBe(
    "user-owned",
  );

  const next = await prepare("WORKBOARD_NEXT");
  expect(sanitizeHostExecEnv({ baseEnv: env }).WORKBOARD_NEXT).toBe(env.WORKBOARD_NEXT);
  const staleRevision = getActiveSecretsRuntimeSnapshotRevisionState() - 1;
  expect(activateSecretsRuntimeSnapshotIfCurrent(next, staleRevision)).toBe(false);
  expect(sanitizeHostExecEnv({ baseEnv: env }).WORKBOARD_PRIMARY).toBeUndefined();
  activateSecretsRuntimeSnapshot(next);
  expect(sanitizeEnvVars(env).allowed).toEqual({
    WORKBOARD_PRIMARY: env.WORKBOARD_PRIMARY,
    SAFE: "kept",
  });
  const restoration = prepareSecretsRuntimeSnapshotRestore(
    first,
    getActiveSecretsRuntimeSnapshotRevisionState(),
    next,
  );
  expect(restoration).not.toBeNull();
  if (!restoration) {
    throw new Error("Expected an owned rollback");
  }
  activateSecretsRuntimeSnapshotState(restoration);
  expect(sanitizeHostExecEnv({ baseEnv: env }).WORKBOARD_PRIMARY).toBeUndefined();
  expect(sanitizeHostExecEnv({ baseEnv: env }).WORKBOARD_NEXT).toBe(env.WORKBOARD_NEXT);

  activateSecretsRuntimeSnapshot(await prepare("WORKBOARD_PRIMARY", "sqlite"));
  expect(sanitizeEnvVars(env).allowed).toEqual(env);
  activateSecretsRuntimeSnapshot(first);
  clearSecretsRuntimeSnapshot();
  expect(sanitizeEnvVars(env).allowed).toEqual(env);
});

it("does not publish rejected resolution or mistake literal DSNs for environment references", async () => {
  activateSecretsRuntimeSnapshot(await prepare("WORKBOARD_PRIMARY"));
  await expect(prepare("WORKBOARD_MISSING")).rejects.toThrow(/missing or empty/);
  expect(sanitizeHostExecEnv({ baseEnv: env }).WORKBOARD_PRIMARY).toBeUndefined();
  const config: OpenClawConfig = {
    database: { engine: "postgres", postgres: { connection: env.WORKBOARD_PRIMARY } },
  };
  activateSecretsRuntimeSnapshot(
    await prepareSecretsRuntimeSnapshot({
      config,
      env,
      includeAuthStoreRefs: false,
      loadablePluginOrigins: new Map(),
    }),
  );
  expect(sanitizeEnvVars(env).allowed).toEqual(env);
});

it("preserves the source of an already materialized environment reference", async () => {
  const config: OpenClawConfig = {
    database: { engine: "postgres", postgres: { connection: env.WORKBOARD_PRIMARY } },
  };
  setConfigResolutionFacts(
    config,
    createConfigResolutionFacts(
      [],
      new Map(),
      "default",
      new Map([["database.postgres.connection", "WORKBOARD_PRIMARY"]]),
    ),
  );
  activateSecretsRuntimeSnapshot(
    await prepareSecretsRuntimeSnapshot({
      config,
      env,
      includeAuthStoreRefs: false,
      loadablePluginOrigins: new Map(),
    }),
  );
  expect(sanitizeHostExecEnv({ baseEnv: env }).WORKBOARD_PRIMARY).toBeUndefined();
  expect(sanitizeEnvVars({ workboard_primary: "synthetic", SAFE: "kept" }).allowed).toEqual({
    SAFE: "kept",
  });
});
