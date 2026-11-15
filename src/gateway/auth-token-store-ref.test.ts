import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { REDACTED_SENTINEL } from "../config/redact-sentinel.js";
import { readSecretStoreValue, writeSecretStoreEntry } from "../secrets/store/secret-store.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db-cache.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { setTestEnvValue } from "../test-utils/env.js";
import { provisionGatewayTokenStoreRef } from "./auth-token-store-ref.js";

const STORE_NAME = "OPENCLAW_GATEWAY_TOKEN";
const storedEntry = {
  scope: { kind: "team" } as const,
  name: STORE_NAME,
  kind: "secret" as const,
  updatedBy: "test",
};

async function readStored(): Promise<string | undefined> {
  const result = await readSecretStoreValue(storedEntry);
  return result.ok ? result.value : undefined;
}

let stateDir: string;

beforeEach(() => {
  stateDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gateway-token-store-")));
  setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
});

afterEach(async () => {
  await closeOpenClawStateDatabaseAsync();
  fs.rmSync(stateDir, { recursive: true, force: true });
});

it.each([
  ["mints a token", undefined, undefined, undefined],
  ["reuses a paired token", "already-paired-token", undefined, undefined],
  ["migrates plaintext", "stale-token", "operator-token", undefined],
  ["honors the store alias", undefined, undefined, "vault"],
] as const)("%s", async (_name, stored, token, provider) => {
  if (stored) {
    await writeSecretStoreEntry({ ...storedEntry, value: stored });
  }
  const result = await provisionGatewayTokenStoreRef({
    config: provider ? { secrets: { defaults: { store: provider } } } : {},
    token,
  });
  expect(result.ref).toEqual({ source: "store", provider: provider ?? "default", id: STORE_NAME });
  expect(result.token.length).toBeGreaterThan(8);
  if (token ?? stored) {
    expect(result.token).toBe(token ?? stored);
  }
  expect(await readStored()).toBe(result.token);
});

it("rejects a redacted stored token without replacing it", async () => {
  await writeSecretStoreEntry({ ...storedEntry, value: "already-paired-token" });
  // Model an older writer's persisted corruption, bypassing the new write guard.
  openOpenClawStateDatabase({
    path: resolveOpenClawStateSqlitePath({ OPENCLAW_STATE_DIR: stateDir }),
  })
    .db.prepare("UPDATE secret_store_entries SET value = ? WHERE name = ?")
    .run(REDACTED_SENTINEL, STORE_NAME);
  await expect(provisionGatewayTokenStoreRef({ config: {} })).rejects.toThrow(
    expect.objectContaining({
      code: "SECRET_STORE_VALUE_REDACTED",
      message: expect.stringContaining(STORE_NAME),
    }),
  );
  expect(await readStored()).toBe(REDACTED_SENTINEL);
});
