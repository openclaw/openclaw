import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { expect, it, vi } from "vitest";
import { readGatewayLockProcessNamespace } from "../../infra/gateway-lock-payload.js";
import { acquireGatewayStateOwner } from "../../infra/gateway-state-owner.js";
import { closeOpenClawAgentDatabasesAsync } from "../../state/openclaw-agent-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import * as archiveWorkers from "./session-accessor.sqlite-archive.js";
import { loadTranscriptEventsSync } from "./session-accessor.sqlite-read.js";
import { readSessionColdTranscript } from "./session-cold-storage-state.js";
import {
  restoreSessionColdTranscript,
  runSessionColdStorageMaintenance,
} from "./session-cold-storage.js";
import {
  createSessionColdStorageFixture,
  historicalId,
  maintenanceConfig,
} from "./session-cold-storage.test-support.js";

it.each(["hot", "archived", "maintenance"])(
  "checks owned Gateway %s access without synchronous filesystem work on the host",
  async (kind) =>
    withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const gatewayOwner = acquireGatewayStateOwner({
        databasePath: resolveOpenClawStateSqlitePath(state.env),
        payload: {
          pid: process.pid,
          createdAt: new Date().toISOString(),
          configPath: state.configPath,
          role: "gateway",
          processNamespace: readGatewayLockProcessNamespace(),
        },
      });
      try {
        const storePath = state.statePath("agents", "main", "agent", "openclaw-agent.sqlite");
        const fixture = await createSessionColdStorageFixture(storePath);
        const events = loadTranscriptEventsSync(fixture.scope);
        if (kind === "archived") {
          await runSessionColdStorageMaintenance({ config: maintenanceConfig(storePath) });
          expect(readSessionColdTranscript(fixture.database(), historicalId)).toBeDefined();
        }
        const calls: Array<{ operation: string; stack: string | undefined }> = [];
        const restores: Array<() => void> = [];
        const wrap = (owner: object, name: string, operation = name) => {
          const original = Reflect.get(owner, name);
          if (typeof original !== "function") {
            return;
          }
          Reflect.set(
            owner,
            name,
            new Proxy(original, {
              apply(target, receiver, args) {
                calls.push({ operation, stack: new Error().stack });
                return Reflect.apply(target, receiver, args);
              },
            }),
          );
          restores.push(() => {
            Reflect.set(owner, name, original);
          });
        };
        for (const name of Object.keys(fs)) {
          if (name.endsWith("Sync")) {
            wrap(fs, name);
          }
        }
        wrap(fs.realpathSync, "native", "realpathSync.native");
        syncBuiltinESMExports();
        try {
          if (kind === "maintenance") {
            await runSessionColdStorageMaintenance({ config: maintenanceConfig(storePath) });
          } else {
            await restoreSessionColdTranscript(fixture.scope);
          }
        } finally {
          for (const restore of restores.toReversed()) {
            restore();
          }
          syncBuiltinESMExports();
        }
        if (kind === "maintenance") {
          expect(readSessionColdTranscript(fixture.database(), historicalId)).toBeDefined();
        } else {
          expect(loadTranscriptEventsSync(fixture.scope)).toEqual(events);
          expect(readSessionColdTranscript(fixture.database(), historicalId)).toBeUndefined();
        }
        expect(calls).toEqual([]);
      } finally {
        await closeOpenClawAgentDatabasesAsync();
        gatewayOwner.release();
      }
    }),
);

it("refuses archived restoration when its database is replaced at the commit grant", async () =>
  withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const storePath = state.statePath("agents", "main", "agent", "openclaw-agent.sqlite");
    const fixture = await createSessionColdStorageFixture(storePath);
    await runSessionColdStorageMaintenance({ config: maintenanceConfig(storePath) });
    const before = fixture.snapshot();
    const detached = storePath + ".detached";
    let replaced = false;
    const original = archiveWorkers.runSqliteTranscriptArchiveWorkerOperation;
    const spy = vi
      .spyOn(archiveWorkers, "runSqliteTranscriptArchiveWorkerOperation")
      .mockImplementation((params) =>
        original(
          params.expectedMessageType === "reclaimed"
            ? {
                ...params,
                onCommitRequest() {
                  fs.renameSync(storePath, detached);
                  fs.writeFileSync(storePath, "replacement");
                  replaced = true;
                  params.onCommitRequest();
                },
              }
            : params,
        ),
      );
    try {
      await expect(restoreSessionColdTranscript(fixture.scope)).rejects.toThrow();
      expect(replaced).toBe(true);
    } finally {
      spy.mockRestore();
      if (replaced) {
        fs.unlinkSync(storePath);
        fs.renameSync(detached, storePath);
      }
    }
    expect(fixture.snapshot()).toEqual(before);
    expect(readSessionColdTranscript(fixture.database(), historicalId)).toBeDefined();
  }));
