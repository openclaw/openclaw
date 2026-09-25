import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { REDACTED_SENTINEL } from "../config/redact-sentinel.js";
import { readSecretStoreValue, writeSecretStoreEntry } from "../secrets/store/secret-store.js";
import { closeOpenClawStateDatabaseByPath } from "../state/openclaw-state-db-cache.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { setTestEnvValue } from "../test-utils/env.js";
import { provisionGatewayTokenStoreRef } from "./auth-token-store-ref.js";

const STORE_SCOPE = { kind: "team" } as const;
const STORE_NAME = "OPENCLAW_GATEWAY_TOKEN";

function readStored(): string | undefined {
  const result = readSecretStoreValue({ scope: STORE_SCOPE, name: STORE_NAME });
  return result.ok ? result.value : undefined;
}

describe("provisionGatewayTokenStoreRef", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gateway-token-store-")));
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
  });

  afterEach(() => {
    closeOpenClawStateDatabaseByPath(
      resolveOpenClawStateSqlitePath({ OPENCLAW_STATE_DIR: stateDir }),
    );
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it("mints a token into the store and returns a default-provider store ref", () => {
    const result = provisionGatewayTokenStoreRef({ config: {} });

    expect(result.ref).toEqual({
      source: "store",
      provider: "default",
      id: STORE_NAME,
    });
    expect(result.token.length).toBeGreaterThan(8);
    expect(readStored()).toBe(result.token);
  });

  it.each(["already-paired-token", REDACTED_SENTINEL])(
    "reuses valid stored tokens and visibly rejects a redacted stored token: %s",
    (token) => {
      writeSecretStoreEntry({
        scope: STORE_SCOPE,
        name: STORE_NAME,
        value: "already-paired-token",
        kind: "secret",
        updatedBy: "test",
      });

      if (token === REDACTED_SENTINEL) {
        // Model an older writer's persisted corruption, bypassing the new write guard.
        openOpenClawStateDatabase({
          path: resolveOpenClawStateSqlitePath({ OPENCLAW_STATE_DIR: stateDir }),
        })
          .db.prepare("UPDATE secret_store_entries SET value = ? WHERE name = ?")
          .run(token, STORE_NAME);
        expect(() => provisionGatewayTokenStoreRef({ config: {} })).toThrow(
          expect.objectContaining({
            code: "SECRET_STORE_VALUE_REDACTED",
            message: expect.stringContaining(STORE_NAME),
          }),
        );
      } else {
        expect(provisionGatewayTokenStoreRef({ config: {} }).token).toBe(token);
      }

      expect(readStored()).toBe(token);
    },
  );

  it("lets an explicit token win so a persisted plaintext token migrates unchanged", () => {
    writeSecretStoreEntry({
      scope: STORE_SCOPE,
      name: STORE_NAME,
      value: "stale-token",
      kind: "secret",
      updatedBy: "test",
    });

    const result = provisionGatewayTokenStoreRef({ config: {}, token: "operator-token" });

    expect(result.token).toBe("operator-token");
    expect(readStored()).toBe("operator-token");
  });

  it("honors a configured store provider alias", () => {
    const result = provisionGatewayTokenStoreRef({
      config: { secrets: { defaults: { store: "vault" } } },
    });

    expect(result.ref.provider).toBe("vault");
  });
});
