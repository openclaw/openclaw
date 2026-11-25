import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db-cache.js";
import { withExistingOpenClawStateSchema } from "../state/openclaw-state-db-schema-policy.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import {
  executeOpenClawStateWorker,
  createOpenClawStateWorkerLease,
  openOpenClawStateWorkerCleanupStore,
} from "../state/openclaw-state-worker-store.js";
import { withGatewayServiceInstallation } from "./gateway-service-installation-context.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    cleanup();
  }),
);

function readAppVersion(databasePath: string) {
  const db = openNodeSqliteDatabase(databasePath, { readOnly: true });
  try {
    return db.prepare("SELECT app_version FROM schema_meta WHERE meta_key = 'primary'").get()
      ?.app_version;
  } finally {
    db.close();
  }
}

async function fixture() {
  const env = { OPENCLAW_STATE_DIR: tempDirs.make("worker-existing-schema-") };
  const { db, path: databasePath } = openOpenClawStateDatabase({ env });
  db.prepare("UPDATE schema_meta SET app_version = ? WHERE meta_key = 'primary'").run(
    "synthetic-installed-runtime",
  );
  await closeOpenClawStateDatabaseAsync();
  return { env, databasePath };
}

function read(context: ReturnType<typeof captureOpenClawStateWorkerContext>) {
  return executeOpenClawStateWorker(context, {
    type: "plugins.conversationBindingApprovals.read",
    input: undefined,
  });
}

describe("shared-state worker schema policies", () => {
  it("preserves active service policy through a natively published hardlink and symlink", async () => {
    const { env, databasePath } = await fixture();
    captureOpenClawStateWorkerContext({ path: databasePath, env });
    const serviceDir = path.join(env.OPENCLAW_STATE_DIR, "service");
    const aliasDir = path.join(env.OPENCLAW_STATE_DIR, "service-alias");
    await fs.mkdir(serviceDir);
    const servicePath = path.join(serviceDir, "openclaw.sqlite");
    await fs.link(databasePath, servicePath);
    await fs.symlink(serviceDir, aliasDir, process.platform === "win32" ? "junction" : "dir");
    const aliasPath = path.join(aliasDir, "openclaw.sqlite");
    openOpenClawStateDatabase({ path: aliasPath, env });
    const installation = {
      root: "/synthetic-installed-runtime",
      version: "2026.10.1",
      cliVersion: "2026.10.9",
      databasePath: servicePath,
    };
    await withGatewayServiceInstallation({ installation }, async () => {
      const captured = captureOpenClawStateWorkerContext({ path: aliasPath, env });
      const lease = createOpenClawStateWorkerLease(captured);
      try {
        await lease.ready;
        await withGatewayServiceInstallation(
          { installation: { ...installation, version: "2026.10.2" } },
          async () => {
            await expect(
              read(captureOpenClawStateWorkerContext({ path: aliasPath, env })),
            ).rejects.toThrow("policy changed while its actor is in use");
          },
        );
      } finally {
        await lease.release();
      }
    });
  });

  it("reopens the whole actor when schema policy changes with a cleanup client retained", async () => {
    const { env, databasePath } = await fixture();
    const captured = captureOpenClawStateWorkerContext({ path: databasePath, env });
    expect(await read(captured)).toEqual([]);
    const cleanup = await openOpenClawStateWorkerCleanupStore(
      databasePath,
      captured,
      () => {},
      captured.admission.identity,
    );
    expect(cleanup).toBeDefined();

    await withGatewayServiceInstallation(
      {
        installation: {
          root: "/synthetic-installed-runtime",
          version: "2026.10.1",
          cliVersion: "2026.10.9",
          databasePath,
        },
      },
      async () => {
        const installed = captureOpenClawStateWorkerContext({ path: databasePath, env });
        expect(await read(installed)).toEqual([]);
      },
    );

    expect(readAppVersion(databasePath)).toBe("synthetic-installed-runtime");
    await cleanup?.close();
  });

  it("admits queued checks only while their captured existing-schema scope remains active", async () => {
    const { env, databasePath } = await fixture();
    const outsideScope = AsyncLocalStorage.snapshot();
    const captured = await withExistingOpenClawStateSchema({ path: databasePath }, async () => {
      const context = captureOpenClawStateWorkerContext({ env });
      expect(() => outsideScope(context.admission.assertCurrent)).not.toThrow();
      expect(await outsideScope(() => read(context))).toEqual([]);
      expect(readAppVersion(databasePath)).toBe("synthetic-installed-runtime");
      return context;
    });

    await expect(read(captured)).rejects.toThrow("schema admission has ended");
    expect(readAppVersion(databasePath)).toBe("synthetic-installed-runtime");
  });
});
