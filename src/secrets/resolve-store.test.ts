import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SecretRef } from "../config/types.secrets.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { describeSecretResolutionError } from "./resolve-errors.js";
import { resolveSecretRefString } from "./resolve.js";
import { isRetryableSecretDegradationReason } from "./runtime-degraded-state.js";
import { writeSecretStoreEntry } from "./store/secret-store.js";

const roots: string[] = [];
const storedRef: SecretRef = { source: "store", provider: "default", id: "STORED_API_KEY" };
const providerConfig = (alias: string, source: "env" | "store") => ({
  secrets: { providers: { [alias]: { source } } },
});

async function createStateEnv(withSecret = false): Promise<NodeJS.ProcessEnv> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-resolve-store-"));
  roots.push(root);
  const env = { OPENCLAW_STATE_DIR: path.join(root, "state") };
  if (withSecret) {
    await writeSecretStoreEntry({
      scope: { kind: "team" },
      name: storedRef.id,
      value: "resolved-store-secret",
      kind: "secret",
      updatedBy: "test",
      database: { env },
    });
  }
  return env;
}

afterEach(async () => {
  await closeOpenClawStateDatabaseAsync();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("store SecretRef resolution", () => {
  it("resolves the store default when an env provider uses the same alias", async () => {
    const env = await createStateEnv(true);
    await expect(
      resolveSecretRefString(storedRef, { config: providerConfig("default", "env"), env }),
    ).resolves.toBe("resolved-store-secret");
  });

  it("resolves an explicitly configured store provider alias", async () => {
    const env = await createStateEnv(true);
    await expect(
      resolveSecretRefString(
        { ...storedRef, provider: "teamstore" },
        { config: providerConfig("teamstore", "store"), env },
      ),
    ).resolves.toBe("resolved-store-secret");
  });

  it("rejects a non-default store alias configured for another source", async () => {
    await expect(
      resolveSecretRefString(
        { ...storedRef, provider: "envmain" },
        { config: providerConfig("envmain", "env") },
      ),
    ).rejects.toMatchObject({
      code: "SECRET_PROVIDER_INVALID",
      source: "store",
      provider: "envmain",
    });
  });

  it("resolves the env default when a store provider uses the same alias", async () => {
    await expect(
      resolveSecretRefString(
        { source: "env", provider: "default", id: "OPENAI_API_KEY" },
        {
          config: providerConfig("default", "store"),
          env: { OPENAI_API_KEY: "resolved-env-secret" },
        },
      ),
    ).resolves.toBe("resolved-env-secret");
  });

  it("maps a missing name to a retryable not-found degradation", async () => {
    const env = await createStateEnv();
    const error = await resolveSecretRefString(
      { ...storedRef, id: "MISSING_API_KEY" },
      { config: {}, env },
    ).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: "SECRET_REF_NOT_FOUND", source: "store" });
    const reason = describeSecretResolutionError(error);
    expect(reason).toBe("secret reference was not found");
    expect(isRetryableSecretDegradationReason(reason ?? "")).toBe(true);
  });

  it("maps database access failures to provider unavailable", async () => {
    const env = await createStateEnv();
    await fs.mkdir(path.dirname(env.OPENCLAW_STATE_DIR as string), { recursive: true });
    await fs.writeFile(env.OPENCLAW_STATE_DIR as string, "not a directory", "utf8");
    const error = await resolveSecretRefString(storedRef, { config: {}, env }).catch(
      (caught: unknown) => caught,
    );

    expect(error).toMatchObject({ code: "SECRET_PROVIDER_UNAVAILABLE", source: "store" });
    expect(describeSecretResolutionError(error)).toBe("secret provider failed");
  });
});
