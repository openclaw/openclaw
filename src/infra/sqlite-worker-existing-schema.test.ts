import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db-cache.js";
import { withExistingOpenClawStateSchema } from "../state/openclaw-state-db-schema-policy.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { getOpenClawStateWorkerOwner } from "../state/openclaw-state-worker-owner.js";
import {
  executeOpenClawStateWorker,
  openOpenClawStateWorkerCleanupStore,
} from "../state/openclaw-state-worker-store.js";
import { withGatewayServiceInstallation } from "./gateway-service-installation-context.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { runtimeProcessEntrypoints } from "./runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";
import { openSharedStateSqliteWorkerStore } from "./sqlite-worker-store.js";

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

describe("existing-schema shared-state workers", () => {
  it("preserves installed release metadata through managed and ordinary worker opens", async () => {
    const { env, databasePath } = await fixture();

    await withExistingOpenClawStateSchema({ path: databasePath }, async () => {
      const captured = captureOpenClawStateWorkerContext({ path: databasePath, env });
      for (let attempt = 0; attempt < 2; attempt += 1) {
        expect(await read(captured)).toEqual([]);
        expect(readAppVersion(databasePath)).toBe("synthetic-installed-runtime");
      }
    });

    const ordinary = captureOpenClawStateWorkerContext({ path: databasePath, env });
    await expect(
      openSharedStateSqliteWorkerStore(
        {
          moduleUrl: resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.sharedStateStore),
          databasePath,
        },
        ordinary,
      ),
    ).rejects.toThrow("schema policy changed");
    expect(await read(ordinary)).toEqual([]);
    expect(readAppVersion(databasePath)).toBe("synthetic-installed-runtime");
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

it("retains equivalent installed-service facts and rejects active policy changes without hanging", async () => {
  const { env, databasePath } = await fixture();
  const captured = captureOpenClawStateWorkerContext({ path: databasePath, env });
  const installation = {
    root: "/older",
    version: "2026.10.3",
    cliVersion: "2026.11.4",
    databasePath,
  };
  captured.gatewayServiceInstallation = installation;
  const owner = getOpenClawStateWorkerOwner();
  const store = await owner.open(captured);
  if (!store) {
    throw new Error("Expected retained worker");
  }
  const release = owner.retainOperation(store);
  try {
    expect(
      await owner.open(
        { ...captured, gatewayServiceInstallation: { ...installation } },
        { signal: AbortSignal.timeout(2000) },
      ),
    ).toBe(store);
    await expect(
      owner.open(
        { ...captured, gatewayServiceInstallation: { ...installation, root: "/different" } },
        { signal: AbortSignal.timeout(2000) },
      ),
    ).rejects.toThrow("policy changed during active use");
  } finally {
    await release();
  }
});

it("reopens service policy after retiring every retained cleanup client", async () => {
  const { env, databasePath } = await fixture();
  const captured = captureOpenClawStateWorkerContext({ path: databasePath, env });
  expect(await read(captured)).toEqual([]);
  const cleanup = await openOpenClawStateWorkerCleanupStore(
    databasePath,
    captured,
    () => {},
    captured.admission.identity,
  );
  try {
    const installed = {
      ...captured,
      gatewayServiceInstallation: {
        root: "/older",
        version: "2026.10.3",
        cliVersion: "2026.11.4",
        databasePath,
      },
    };
    expect(await read(installed)).toEqual([]);
    expect(readAppVersion(databasePath)).toBe("synthetic-installed-runtime");
  } finally {
    await cleanup?.close();
  }
});

it("reuses an active worker under unrelated installation facts", async () => {
  const { env, databasePath } = await fixture();
  const owner = getOpenClawStateWorkerOwner();
  const store = await owner.open(captureOpenClawStateWorkerContext({ path: databasePath, env }));
  if (!store) {
    throw new Error("Expected retained worker");
  }
  const release = owner.retainOperation(store);
  try {
    const installation = {
      root: "/older",
      version: "2026.10.3",
      cliVersion: "2026.11.4",
      databasePath: path.join(env.OPENCLAW_STATE_DIR, "unrelated.sqlite"),
    };
    const next = withGatewayServiceInstallation({ installation }, () =>
      captureOpenClawStateWorkerContext({ path: databasePath, env }),
    );
    expect(await owner.open(next, { signal: AbortSignal.timeout(2000) })).toBe(store);
    expect(next.gatewayServiceInstallation).toBeUndefined();
  } finally {
    await release();
  }
});

it("preserves a matching service policy through published hard-link and symlink aliases", async () => {
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
    root: "/older",
    version: "2026.10.3",
    cliVersion: "2026.11.4",
    databasePath: servicePath,
  };
  const capture = () => captureOpenClawStateWorkerContext({ path: aliasPath, env });
  const context = withGatewayServiceInstallation({ installation }, capture);
  expect(context.gatewayServiceInstallation).toEqual(installation);
  const owner = getOpenClawStateWorkerOwner();
  const store = await owner.open(context);
  if (!store) {
    throw new Error("Expected retained worker");
  }
  const release = owner.retainOperation(store);
  try {
    const next = withGatewayServiceInstallation(
      { installation: { ...installation, version: "2026.10.4" } },
      capture,
    );
    await expect(owner.open(next, { signal: AbortSignal.timeout(2000) })).rejects.toThrow(
      "policy changed during active use",
    );
  } finally {
    await release();
  }
});
