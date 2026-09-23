import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readConfigFileSnapshotForWrite } from "../../config/config.js";
import { registerManagedRuntimeConfigWriteOwner } from "../../config/runtime-snapshot.js";
import * as admissions from "../../infra/sqlite-worker-operation-admission.js";
import { resolveSecretRefString } from "../../secrets/resolve.js";
import {
  readSecretStoreValueAsync,
  withSecretStoreStagedWrite,
} from "../../secrets/store/secret-store-worker.js";
import * as reads from "../../state/openclaw-state-db-readonly.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { observeMainThreadSql } from "../../test-utils/main-thread-sql-spies.js";
import { commitGatewayConfigWrite } from "./config-write-flow.js";

let root: string;
let database: { env: NodeJS.ProcessEnv };
beforeAll(async () => {
  const parent = path.resolve(".openclaw/tmp/native-credential-worker-cache");
  await fs.mkdir(parent, { recursive: true });
  root = await fs.mkdtemp(path.join(parent, "store-"));
  database = { env: { OPENCLAW_STATE_DIR: root } };
});
afterAll(async () => {
  await closeOpenClawStateDatabaseAsync();
  await fs.rm(root, { recursive: true, force: true });
});
const write = (
  name: string,
  value: string,
  run: Parameters<typeof withSecretStoreStagedWrite>[2],
  guard = () => {},
) =>
  withSecretStoreStagedWrite(
    { scope: { kind: "team" }, name, value, kind: "secret", updatedBy: "fixture", database },
    guard,
    run,
  );
const read = (name: string) =>
  readSecretStoreValueAsync({ scope: { kind: "team" }, name, database });
describe("worker-owned protected credential staging", () => {
  it("makes the exact staged value available to native resolver preparation and restores on refusal", async () => {
    const sql = observeMainThreadSql();
    try {
      await write("PREPARED_KEY", "previous-fixture", async () => {});
      await write("PREPARED_KEY", "candidate-fixture", async (stage) => {
        expect(
          await resolveSecretRefString(
            { source: "store", provider: "default", id: "PREPARED_KEY" },
            { config: {}, env: database.env },
          ),
        ).toBe("candidate-fixture");
        expect(await stage.rollback()).toBe(true);
        expect(await stage.rollback()).toBe(true);
      });
      expect(await read("PREPARED_KEY")).toEqual({ ok: true, value: "previous-fixture" });
      sql.expectIdle();
    } finally {
      sql.restore();
    }
  });
  it("prepares the exact authored candidate through the native config owner before publication", async () => {
    const configPath = path.join(root, "candidate.json");
    const original = JSON.stringify({
      plugins: { enabled: false },
      skills: { entries: { fixture: {} } },
    });
    await fs.writeFile(configPath, original);
    await withEnvAsync(
      {
        OPENCLAW_STATE_DIR: root,
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_CONFIG_READONLY: undefined,
      },
      async () => {
        const prepared = vi.fn(async (config) => {
          expect(config.skills.entries.fixture.apiKey).toEqual({
            source: "store",
            provider: "default",
            id: "NATIVE_KEY",
          });
          expect(
            await resolveSecretRefString(config.skills.entries.fixture.apiKey, {
              config,
              env: database.env,
            }),
          ).toBe("native-candidate-fixture");
          throw new Error("native preparation refused");
        });
        const release = registerManagedRuntimeConfigWriteOwner(configPath, prepared);
        try {
          const { snapshot, writeOptions } = await readConfigFileSnapshotForWrite();
          await expect(
            write("NATIVE_KEY", "native-candidate-fixture", async (stage) => {
              try {
                await commitGatewayConfigWrite({
                  snapshot,
                  writeOptions,
                  awaitRuntimeApplication: true,
                  nextConfig: {
                    ...snapshot.sourceConfig,
                    skills: {
                      entries: {
                        fixture: {
                          apiKey: { source: "store", provider: "default", id: "NATIVE_KEY" },
                        },
                      },
                    },
                  },
                });
              } catch (error) {
                await stage.rollback();
                throw error;
              }
            }),
          ).rejects.toThrow("native preparation refused");
          expect(prepared).toHaveBeenCalledOnce();
          expect(await fs.readFile(configPath, "utf8")).toBe(original);
          expect(await read("NATIVE_KEY")).toMatchObject({ ok: false });
        } finally {
          release();
        }
      },
    );
  });
  it("rejects revoked live authority at the native commit grant", async () => {
    const create = admissions.createSqliteWorkerOperationAdmission;
    let current = true;
    const spy = vi
      .spyOn(admissions, "createSqliteWorkerOperationAdmission")
      .mockImplementation((admit) =>
        create((request, grant) => {
          if (request.stage === "commit") {
            current = false;
          }
          admit(request, grant);
        }),
      );
    try {
      await expect(
        write(
          "COMMIT_REFUSED_KEY",
          "commit-refused-fixture",
          async () => {},
          () => {
            if (!current) {
              throw new Error("revoked at commit");
            }
          },
        ),
      ).rejects.toThrow("revoked at commit");
      expect(await read("COMMIT_REFUSED_KEY")).toMatchObject({ ok: false });
    } finally {
      spy.mockRestore();
    }
  });
  it("refuses current authority before native write", async () => {
    const run = vi.fn();
    await expect(
      write("REFUSED_KEY", "refused-fixture", run, () => {
        throw new Error("revoked");
      }),
    ).rejects.toThrow("revoked");
    expect(run).not.toHaveBeenCalled();
    expect(await read("REFUSED_KEY")).toMatchObject({
      ok: false,
      error: { code: "SECRET_STORE_NOT_FOUND" },
    });
  });
  it("lets revoked callers compensate only their retained exact stage", async () => {
    let current = true;
    await write(
      "REVOKED_KEY",
      "revoked-fixture",
      async (stage) => {
        current = false;
        expect(await stage.rollback()).toBe(true);
      },
      () => {
        if (!current) {
          throw new Error("revoked");
        }
      },
    );
    expect(await read("REVOKED_KEY")).toMatchObject({ ok: false });
  });
  it("preserves a worker read-admission refusal instead of falling back to synchronous SQLite", async () => {
    const spy = vi
      .spyOn(reads, "executeExistingOpenClawStateRead")
      .mockRejectedValue(new Error("read admission is closed"));
    const sql = observeMainThreadSql();
    try {
      expect(await read("PREPARED_KEY")).toMatchObject({
        ok: false,
        error: { code: "SECRET_STORE_UNAVAILABLE" },
      });
      await expect(
        resolveSecretRefString(
          { source: "store", provider: "default", id: "PREPARED_KEY" },
          { config: {}, env: database.env },
        ),
      ).rejects.toMatchObject({ code: "SECRET_PROVIDER_UNAVAILABLE" });
      sql.expectIdle();
    } finally {
      sql.restore();
      spy.mockRestore();
    }
  });
  it("does not compensate over a concurrent writer", async () => {
    await write("CONCURRENT_KEY", "first-fixture", async (first) => {
      await write("CONCURRENT_KEY", "second-fixture", async () => {});
      expect(await first.rollback()).toBe(false);
    });
    expect(await read("CONCURRENT_KEY")).toEqual({ ok: true, value: "second-fixture" });
  });
});
