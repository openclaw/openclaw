import { existsSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerBundledHealthChecks } from "../flows/bundled-health-checks.js";
import { clearHealthChecksForTest, getHealthCheck } from "../flows/health-check-registry.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { createPluginStateSyncKeyedStore } from "../plugin-state/plugin-state-store.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db-cache.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { runDoctorLintCli } from "./doctor-lint.js";
import { createTestRuntime } from "./test-runtime-config-helpers.js";

const CHECK_ID = "crabbox/warm-images";

afterEach(async () => {
  vi.restoreAllMocks();
  clearHealthChecksForTest();
  await closeOpenClawStateDatabaseAsync();
});

describe("Crabbox Doctor diagnostic storage", () => {
  it.each([false, true])(
    "awaits worker findings without host SQLite or state changes (existing=%s)",
    async (existing) => {
      await withOpenClawTestState({ label: "crabbox-doctor" }, async (state) => {
        const cfg = {
          cloudWorkers: { profiles: { worker: { provider: "crabbox" } } },
        };
        await state.writeConfig(cfg);
        const pending = {
          version: 3,
          allocations: {},
          operation: {
            type: "capture",
            id: "capture-pending",
            startedAtMs: 1_800_000_000_000,
            phase: "uncertain",
          },
        };
        const rows = () =>
          openOpenClawStateDatabase({ env: state.env })
            .db.prepare(
              "SELECT * FROM plugin_state_entries WHERE namespace = ? ORDER BY plugin_id, entry_key",
            )
            .all("warm-images");
        if (existing) {
          const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
          const options = {
            namespace: "warm-images",
            maxEntries: 128,
            overflowPolicy: "reject-new" as const,
            env: state.env,
          };
          const store = createPluginStateSyncKeyedStore("crabbox", options);
          store.register("profile", pending);
          store.register("expired", pending, { ttlMs: 1 });
          createPluginStateSyncKeyedStore("unrelated-plugin", options).register("decoy", pending);
          now.mockRestore();
        }
        const before = existing ? rows() : undefined;
        registerBundledHealthChecks({ cfg, env: state.env });
        const check = getHealthCheck(CHECK_ID);
        if (!check) {
          throw new Error("The configured Crabbox Doctor artifact did not register its check");
        }
        const detect = check.detect.bind(check);
        const native = requireNodeSqlite();
        const hostCalls: number[] = [];
        const detection = vi.spyOn(check, "detect").mockImplementation(async (...args) => {
          const sql = [
            vi.spyOn(native.DatabaseSync.prototype, "prepare"),
            vi.spyOn(native.DatabaseSync.prototype, "exec"),
            ...(["get", "all", "run", "iterate"] as const).map((method) =>
              vi.spyOn(native.StatementSync.prototype, method),
            ),
          ];
          try {
            return await detect(...args);
          } finally {
            hostCalls.push(sql.reduce((count, method) => count + method.mock.calls.length, 0));
            sql.forEach((method) => method.mockRestore());
          }
        });
        await closeOpenClawStateDatabaseAsync();
        const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
        try {
          const exitCode = await runDoctorLintCli(createTestRuntime(), {
            json: true,
            onlyIds: [CHECK_ID],
          });
          const output = JSON.parse(String(stdout.mock.calls.at(-1)?.[0]));
          expect(exitCode).toBe(existing ? 1 : 0);
          expect(output).toMatchObject({
            checksRun: 1,
            findings: existing
              ? [
                  {
                    checkId: CHECK_ID,
                    severity: "warning",
                    target: "profile",
                    fixHint: expect.stringContaining(
                      "--recover capture-pending --acknowledge-provider-cleanup",
                    ),
                  },
                ]
              : [],
          });
          expect(detection).toHaveBeenCalledOnce();
          expect(hostCalls).toEqual([0]);
        } finally {
          stdout.mockRestore();
        }
        await closeOpenClawStateDatabaseAsync();
        if (existing) {
          expect(rows()).toEqual(before);
        } else {
          expect(existsSync(resolveOpenClawStateSqlitePath(state.env))).toBe(false);
        }
      });
    },
  );
});
