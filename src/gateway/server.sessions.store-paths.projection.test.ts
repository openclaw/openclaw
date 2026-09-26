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
            const stateDirectoryProbes: Array<{
              search: string;
              runtime: string;
              stack: string | undefined;
            }> = [];
            for (const search of [undefined, "unmatched-runtime-search", "openclaw"]) {
              const request = { configuredAgentsOnly: true, includeGlobal: false, search };
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
                stateDirectoryProbes.length = 0;
                const existsSync = fsSync.existsSync;
                const exists = vi.spyOn(fsSync, "existsSync").mockImplementation((pathname) => {
                  // Retain bounded provenance for probes that only reproduce in shared CI shards.
                  if (
                    stateDirectoryProbes.length < 3 &&
                    (pathname === stateDir || pathname === legacyStateDir)
                  ) {
                    stateDirectoryProbes.push({
                      search: search ?? "list",
                      runtime: agentRuntimeOverride ?? "auto",
                      stack: new Error("Unexpected state-directory probe").stack,
                    });
                  }
                  return existsSync(pathname);
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
                  expect
                    .soft(
                      stateDirectoryProbes,
                      `${search ?? "list"}: ${agentRuntimeOverride ?? "auto"}`,
                    )
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
