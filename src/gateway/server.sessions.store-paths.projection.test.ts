import fsSync from "node:fs";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { expect, test, vi } from "vitest";
import * as runtimePaths from "../config/paths.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.entry.js";
import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import { withOpenClawAgentDatabaseWrite } from "../state/openclaw-agent-db-write.js";
import * as agentDatabasePaths from "../state/openclaw-agent-db.paths.js";
import { withEnvAsync } from "../test-utils/env.js";
import { loadGatewayTestConfig } from "./test-helpers.config-runtime.js";
import { testState } from "./test-helpers.js";
import {
  directSessionReq,
  getGatewayConfigModule,
  setupGatewaySessionsHandlerTestHarness,
} from "./test/server-sessions.test-helpers.js";

const { createSessionStoreDir } = setupGatewaySessionsHandlerTestHarness();
const agentIds = Array.from({ length: 29 }, (_, index) => `agent-${index}`);

function configureStores(stateDir: string) {
  const storeTemplate = path.join(stateDir, "agents", "{agentId}", "sessions", "sessions.json");
  testState.sessionConfig = { store: storeTemplate };
  testState.agentsConfig = { entries: Object.fromEntries(agentIds.map((id) => [id, {}])) };
  return storeTemplate;
}

async function seedStores(storeTemplate: string, agentRuntimeOverride?: "openclaw") {
  for (const agentId of agentIds) {
    const storePath = storeTemplate.replace("{agentId}", agentId);
    // Seed metadata without unrelated lifecycle deletion workers.
    await withOpenClawAgentDatabaseWrite(
      { agentId, path: resolveSqliteTargetFromSessionStorePath(storePath, { agentId }).path },
      () =>
        replaceSessionEntrySync(
          { agentId, sessionKey: `agent:${agentId}:main`, storePath },
          { sessionId: `session-${agentId}`, updatedAt: 10, agentRuntimeOverride },
        ),
    );
  }
}

test("automatic list and search projection reuse conventional state-directory preparation", async () => {
  const { dir: home } = await createSessionStoreDir();
  testState.sessionStorePath = undefined;
  const stateDir = path.join(home, ".openclaw");
  const legacyStateDir = path.join(home, ".clawdbot");
  await fs.mkdir(stateDir, { recursive: true });
  try {
    await withEnvAsync(
      { OPENCLAW_HOME: home, OPENCLAW_STATE_DIR: undefined, OPENCLAW_TEST_FAST: "0" },
      async () => {
        runtimePaths.pinRuntimePaths();
        const storeTemplate = configureStores(stateDir);
        const { setRuntimeConfigSnapshot } = await getGatewayConfigModule();
        const { resolvePluginMetadataSnapshot } =
          await import("../plugins/plugin-metadata-snapshot.js");
        const { withPluginMetadataSnapshotScope } =
          await import("../plugins/current-plugin-metadata-snapshot.js");
        const config = loadGatewayTestConfig();
        setRuntimeConfigSnapshot(config);
        const metadata = resolvePluginMetadataSnapshot({ config, allowCurrent: false });
        await withPluginMetadataSnapshotScope(
          metadata,
          async () => {
            for (const agentRuntimeOverride of ["openclaw", undefined] as const) {
              await seedStores(storeTemplate, agentRuntimeOverride);
              for (const search of [undefined, "unmatched-runtime-search", "openclaw"]) {
                const request = { configuredAgentsOnly: true, includeGlobal: false, search };
                expect((await directSessionReq("sessions.list", request)).ok).toBe(true);
                const exists = vi.spyOn(fsSync, "existsSync");
                const environments = vi.spyOn(runtimePaths, "captureRuntimeStateEnvironment");
                syncBuiltinESMExports();
                try {
                  const listed = await directSessionReq<{ sessions: Array<{ key: string }> }>(
                    "sessions.list",
                    request,
                  );
                  expect(listed.ok).toBe(true);
                  expect(listed.payload?.sessions).toHaveLength(
                    search === "unmatched-runtime-search" ? 0 : agentIds.length,
                  );
                  expect.soft(environments.mock.calls.length, search ?? "list").toBe(0);
                  const probes = exists.mock.calls.filter(
                    ([pathname]) => pathname === stateDir || pathname === legacyStateDir,
                  );
                  expect
                    .soft(probes, `${search ?? "list"}: ${agentRuntimeOverride ?? "auto"}`)
                    .toEqual([]);
                } finally {
                  for (const spy of [exists, environments]) {
                    spy.mockRestore();
                  }
                  syncBuiltinESMExports();
                }
              }
            }
          },
          { config, trustConfigIdentity: true },
        );
      },
    );
  } finally {
    runtimePaths.pinRuntimePaths();
  }
});

test("configured-only multi-store target preparation is reused across distinct lists", async () => {
  const { dir: stateDir } = await createSessionStoreDir();
  testState.sessionStorePath = undefined;
  await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
    const storeTemplate = configureStores(stateDir);
    (await getGatewayConfigModule()).setRuntimeConfigSnapshot(loadGatewayTestConfig());
    await seedStores(storeTemplate);

    expect((await directSessionReq("sessions.list", { configuredAgentsOnly: true })).ok).toBe(true);
    const matcher = vi.spyOn(agentDatabasePaths, "createOpenClawAgentDatabasePathMatcher");
    const lstat = vi.spyOn(fsSync, "lstatSync");
    const readlink = vi.spyOn(fsSync, "readlinkSync");
    const realpath = vi.spyOn(fsSync.realpathSync, "native");
    const stat = vi.spyOn(fsSync, "statSync");
    const spies = { matcher, lstat, readlink, realpath, stat };
    syncBuiltinESMExports();
    try {
      const first = await directSessionReq<{ path: string }>("sessions.list", {
        configuredAgentsOnly: true,
        includeGlobal: false,
      });
      expect(first).toMatchObject({ ok: true, payload: { path: "(multiple)" } });
      for (const spy of [matcher, realpath, stat]) {
        expect(spy).not.toHaveBeenCalled();
      }

      for (const spy of Object.values(spies)) {
        spy.mockClear();
      }
      const second = await directSessionReq<{ path: string }>("sessions.list", {
        configuredAgentsOnly: true,
        includeUnknown: false,
      });

      expect(second).toMatchObject({ ok: true, payload: { path: "(multiple)" } });
      for (const spy of Object.values(spies)) {
        expect(spy).not.toHaveBeenCalled();
      }
    } finally {
      for (const spy of Object.values(spies)) {
        spy.mockRestore();
      }
      syncBuiltinESMExports();
    }
  });
});
