import fsSync from "node:fs";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { expect, test, vi } from "vitest";
import * as runtimePaths from "../config/paths.js";
import { withEnvAsync } from "../test-utils/env.js";
import { testState, writeSessionStore } from "./test-helpers.js";
import {
  directSessionReq,
  getGatewayConfigModule,
  setupGatewaySessionsHandlerTestHarness,
} from "./test/server-sessions.test-helpers.js";

const { createSessionStoreDir } = setupGatewaySessionsHandlerTestHarness();

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
        const agentIds = Array.from({ length: 29 }, (_, index) => `agent-${index}`);
        const storeTemplate = path.join(
          stateDir,
          "agents",
          "{agentId}",
          "sessions",
          "sessions.json",
        );
        testState.sessionConfig = { store: storeTemplate };
        testState.agentsConfig = {
          list: agentIds.map((id, index) => ({ id, default: index === 0 })),
        };
        const { getRuntimeConfig } = await getGatewayConfigModule();
        const { resolvePluginMetadataSnapshot } =
          await import("../plugins/plugin-metadata-snapshot.js");
        const { withPluginMetadataSnapshotScope } =
          await import("../plugins/current-plugin-metadata-snapshot.js");
        const config = getRuntimeConfig();
        const metadata = resolvePluginMetadataSnapshot({ config, allowCurrent: false });
        // Normal Gateway requests inherit the immutable metadata prepared at startup.
        await withPluginMetadataSnapshotScope(
          metadata,
          async () => {
            const observations = [];
            const filesystemProbes: Array<{
              operation: string;
              pathname: fsSync.PathLike;
              search: string;
              runtime: string;
              error: Error;
            }> = [];
            for (const search of [undefined, "unmatched-runtime-search", "openclaw"]) {
              const request = { configuredAgentsOnly: true, includeGlobal: false, search };
              const counts = [];
              for (const agentRuntimeOverride of ["openclaw", undefined]) {
                for (const agentId of agentIds) {
                  await writeSessionStore({
                    agentId,
                    entries: {
                      [`agent:${agentId}:main`]: {
                        sessionId: `session-${agentId}`,
                        updatedAt: 10,
                        agentRuntimeOverride,
                      },
                    },
                    storePath: storeTemplate.replace("{agentId}", agentId),
                  });
                }
                const warm = await directSessionReq("sessions.list", request);
                expect(warm.ok).toBe(true);
                const recordProbe = (operation: string, pathname: fsSync.PathLike) => {
                  if (filesystemProbes.length < 6) {
                    filesystemProbes.push({
                      operation,
                      pathname,
                      search: search ?? "list",
                      runtime: agentRuntimeOverride ?? "auto",
                      error: new Error("Unexpected filesystem probe"),
                    });
                  }
                };
                const existsSync = fsSync.existsSync;
                const exists = vi.spyOn(fsSync, "existsSync").mockImplementation((pathname) => {
                  if (pathname === stateDir || pathname === legacyStateDir) {
                    recordProbe("exists", pathname);
                  }
                  return existsSync(pathname);
                });
                const lstatSync = fsSync.lstatSync;
                const lstat = vi.spyOn(fsSync, "lstatSync").mockImplementation((...args) => {
                  recordProbe("lstat", args[0]);
                  return lstatSync(...args);
                });
                const readlink = vi.spyOn(fsSync, "readlinkSync");
                const realpath = vi.spyOn(fsSync.realpathSync, "native");
                const statSync = fsSync.statSync;
                const stat = vi.spyOn(fsSync, "statSync").mockImplementation((...args) => {
                  recordProbe("stat", args[0]);
                  return statSync(...args);
                });
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
                  counts.push({
                    exists: exists.mock.calls.length,
                    stateDirectoryExists: exists.mock.calls.filter(
                      ([pathname]) => pathname === stateDir || pathname === legacyStateDir,
                    ).length,
                    lstat: lstat.mock.calls.length,
                    readlink: readlink.mock.calls.length,
                    realpath: realpath.mock.calls.length,
                    stat: stat.mock.calls.length,
                  });
                } finally {
                  for (const spy of [exists, lstat, readlink, realpath, stat, environments]) {
                    spy.mockRestore();
                  }
                  syncBuiltinESMExports();
                }
              }
              observations.push({
                surface: search ? "search" : "list",
                pinned: counts[0],
                auto: counts[1],
              });
            }
            // Format stacks after restoring spies: source-map lookup can itself touch the filesystem.
            const provenance = filesystemProbes.map((probe) => ({
              operation: probe.operation,
              pathname: String(probe.pathname).replace(home, "<fixture>"),
              search: probe.search,
              runtime: probe.runtime,
              stack: probe.error.stack,
            }));
            expect(observations, JSON.stringify(provenance, null, 2)).toEqual(
              observations.map(({ surface, pinned }) => ({ surface, pinned, auto: pinned })),
            );
          },
          { config, trustConfigIdentity: true },
        );
      },
    );
  } finally {
    runtimePaths.pinRuntimePaths();
  }
});
