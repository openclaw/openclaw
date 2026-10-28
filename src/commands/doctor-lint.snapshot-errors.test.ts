import "../test-utils/prepare-compiled-subprocesses.js";
import fs from "node:fs";
import path from "node:path";
import { createRetainedOperation } from "@openclaw/worker-runtime/lifecycle";
import { Command } from "commander";
import { afterEach, expect, it, vi } from "vitest";
import { registerMaintenanceCommands } from "../cli/program/register.maintenance.js";
import { clearHealthChecksForTest } from "../flows/health-check-registry.js";
import { StateDatabaseOfflineMaintenanceError } from "../infra/gateway-state-owner-record.js";
import type { RetainedPreparedSqliteReadOnlyLocation } from "../infra/sqlite-readonly-location.types.js";
import * as snapshots from "../infra/sqlite-snapshot-source.js";
import { ExitError } from "../runtime.js";
import { openClawStateDatabaseCache } from "../state/openclaw-state-db-cache.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { withEnvAsync } from "../test-utils/env.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createStateSnapshotFailureFinding } from "./doctor-lint-output.js";

vi.mock("../flows/doctor-health-contributions.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../flows/doctor-health-contributions.js")>()),
  resolveDoctorContributionHealthChecks: async () => [],
}));

afterEach(async () => {
  vi.restoreAllMocks();
  clearHealthChecksForTest();
  await closeOpenClawStateDatabaseAsync();
});

it("keeps native codes when a plugin snapshot cause exceeds the diagnostic bound", () => {
  const cause = Object.assign(new Error("snapshot detail ".repeat(40)), { code: "EPERM" });
  const finding = createStateSnapshotFailureFinding(new Error("snapshot failed", { cause }));
  expect(finding.message).toContain("code=EPERM");
  expect(finding.message.length).toBeLessThan(cause.message.length);
});

it
  .skipIf(process.platform === "win32" || process.getuid?.() === 0)
  .each([
    "preferred denied",
    "all denied",
    "disk full",
    "lazy disk full",
    "human lazy disk full",
    "maintenance",
    "unreadable database",
  ] as const)("reports snapshot failures accurately through lint: %s", async (scenario) => {
  await withOpenClawTestState({ prefix: "lint-snapshot-errors-" }, async (state) => {
    await state.writeConfig({
      gateway: { mode: "local" },
      plugins: { enabled: false },
      memory: { search: { enabled: false } },
    });
    openOpenClawStateDatabase({ env: state.env });
    await closeOpenClawStateDatabaseAsync();
    const databasePath = resolveOpenClawStateSqlitePath(state.env);
    const before = fs.readFileSync(databasePath);
    const cache = state.path("cache");
    const preferred = path.join(cache, "openclaw");
    fs.mkdirSync(preferred, { recursive: true, mode: 0o700 });
    let denied: string | undefined;
    if (scenario === "preferred denied") {
      fs.rmdirSync(preferred);
      fs.symlinkSync(state.stateDir, preferred, "dir");
    } else if (scenario === "all denied" || scenario === "unreadable database") {
      denied = scenario === "all denied" ? cache : databasePath;
      fs.chmodSync(denied, 0);
    }
    const cleanup = vi.fn();
    const failure = Object.assign(new Error("snapshot allocation failed"), { code: "ENOSPC" });
    if (scenario.endsWith("disk full")) {
      // Fixed storage I/O failure; keep the real snapshot producer and CLI boundary.
      vi.spyOn(snapshots, "startSqliteReadOnlyLocationAsync").mockImplementation(() => {
        const pending = createRetainedOperation<RetainedPreparedSqliteReadOnlyLocation>(() => {});
        pending.reject(failure);
        return {
          ...pending.operation,
          startClose() {
            cleanup();
            const close = createRetainedOperation<void>(() => {});
            close.resolve();
            return close.operation;
          },
        };
      });
    } else if (scenario === "maintenance") {
      vi.spyOn(
        openClawStateDatabaseCache,
        "assertOpenClawStateDatabaseFreshOpenAllowedAtPath",
      ).mockImplementation(() => {
        throw new StateDatabaseOfflineMaintenanceError(
          databasePath,
          "Offline maintenance is active.",
        );
      });
    }
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    const human = scenario === "human lazy disk full";
    const tty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    if (human) {
      Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
    }
    try {
      await withEnvAsync(
        { XDG_CACHE_HOME: cache, OPENCLAW_UPDATE_IN_PROGRESS: undefined },
        async () => {
          const program = new Command();
          registerMaintenanceCommands(program);
          const lazy = scenario.includes("lazy");
          await expect(
            program.parseAsync(
              [
                "doctor",
                "--lint",
                ...(human ? [] : ["--json"]),
                ...(lazy ? ["--only", "core/doctor/state-schema"] : []),
              ],
              { from: "user" },
            ),
          ).rejects.toEqual(new ExitError(scenario === "preferred denied" ? 0 : lazy ? 1 : 2));
          if (human) {
            const message = stderr.mock.calls.flat().join(" ");
            expect(message).toContain("code=ENOSPC");
            expect(message).not.toContain("Retry after the current state operation");
            expect(cleanup).toHaveBeenCalledOnce();
            return;
          }
          const report = JSON.parse(String(stdout.mock.calls.at(-1)?.[0]));
          if (scenario === "preferred denied") {
            expect(report).toMatchObject({ ok: true, checksRun: 1, findings: [] });
            expect(fs.existsSync(path.join(cache, `openclaw-${process.getuid?.()}`))).toBe(true);
            expect(fs.lstatSync(preferred).isSymbolicLink()).toBe(true);
          } else {
            expect(report).toMatchObject({ ok: false, checksRun: lazy ? 1 : 0, checksSkipped: 0 });
            const message = report.findings
              .map((finding: { message: string }) => finding.message)
              .join(" ");
            expect(message).toContain(
              scenario === "maintenance"
                ? "Retry after the current state operation completes"
                : scenario.endsWith("disk full")
                  ? "ENOSPC"
                  : "EACCES",
            );
            if (scenario !== "maintenance") {
              expect(message).not.toContain("Retry after the current state operation");
            }
            if (scenario.endsWith("disk full")) {
              expect(cleanup).toHaveBeenCalledOnce();
            }
          }
        },
      );
    } finally {
      if (human) {
        if (tty) {
          Object.defineProperty(process.stdout, "isTTY", tty);
        } else {
          Reflect.deleteProperty(process.stdout, "isTTY");
        }
      }
      if (denied) {
        fs.chmodSync(denied, denied === databasePath ? 0o600 : 0o700);
      }
    }
    expect(fs.readFileSync(databasePath)).toEqual(before);
  });
});
