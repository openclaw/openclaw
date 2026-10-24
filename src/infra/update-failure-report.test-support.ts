import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, expect, vi } from "vitest";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import * as githubIssue from "./github-issue.js";
import type { GithubIssueSubmitHooks, PreparedGithubIssue } from "./github-issue.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";
import * as reportReceipts from "./restart-sentinel.js";
import { readUpdateFailureReportReceipt } from "./restart-sentinel.js";
import type { PreparedUpdateFailureReport } from "./update-failure-report-prepare.js";
import { submitUpdateFailureReport } from "./update-failure-report.js";

type AsyncOverride<F extends (...args: never[]) => unknown> = (
  ...args: Parameters<F>
) => ReturnType<F> | Awaited<ReturnType<F>>;

type ReportFixtureControls = {
  createIssue?: (
    issue: PreparedGithubIssue,
    hooks: GithubIssueSubmitHooks,
  ) => githubIssue.GithubIssueSubmitResult | Promise<githubIssue.GithubIssueSubmitResult>;
  reconcileIssue?: (
    issue: PreparedGithubIssue,
    hooks: githubIssue.GithubIssueReconcileHooks,
  ) => Promise<githubIssue.GithubIssueReconcileResult>;
  finalizeReceipt?: AsyncOverride<typeof reportReceipts.finalizeUpdateFailureReportReceipt>;
  markPending?: AsyncOverride<typeof reportReceipts.markUpdateFailureReportReceiptPending>;
  readReceipt?: AsyncOverride<typeof reportReceipts.readUpdateFailureReportReceipt>;
};

type ReportFixtureOptions = NonNullable<Parameters<typeof submitUpdateFailureReport>[2]> &
  ReportFixtureControls;

// Old and successor submissions overlap across held I/O, so faults follow their async invocation.
const reportFixtureControls = new AsyncLocalStorage<ReportFixtureControls>();

function withoutFixtureControl<T>(key: keyof ReportFixtureControls, run: () => T): T {
  return reportFixtureControls.run({ ...reportFixtureControls.getStore(), [key]: undefined }, run);
}

beforeEach(() => {
  const submit = githubIssue.submitGithubIssue;
  const reconcile = githubIssue.reconcileGithubIssue;
  const finalize = reportReceipts.finalizeUpdateFailureReportReceipt;
  const pending = reportReceipts.markUpdateFailureReportReceiptPending;
  const read = reportReceipts.readUpdateFailureReportReceipt;
  vi.spyOn(githubIssue, "submitGithubIssue").mockImplementation((issue, runGh, hooks) => {
    const override = reportFixtureControls.getStore()?.createIssue;
    return override
      ? Promise.resolve(withoutFixtureControl("createIssue", () => override(issue, hooks ?? {})))
      : submit(issue, runGh, hooks);
  });
  vi.spyOn(githubIssue, "reconcileGithubIssue").mockImplementation((issue, runGh, hooks) => {
    const override = reportFixtureControls.getStore()?.reconcileIssue;
    return override
      ? withoutFixtureControl("reconcileIssue", () => override(issue, hooks ?? {}))
      : reconcile(issue, runGh, hooks);
  });
  vi.spyOn(reportReceipts, "finalizeUpdateFailureReportReceipt").mockImplementation((...args) => {
    const override = reportFixtureControls.getStore()?.finalizeReceipt;
    return override
      ? Promise.resolve(withoutFixtureControl("finalizeReceipt", () => override(...args)))
      : finalize(...args);
  });
  vi.spyOn(reportReceipts, "markUpdateFailureReportReceiptPending").mockImplementation(
    (...args) => {
      const override = reportFixtureControls.getStore()?.markPending;
      return override
        ? Promise.resolve(withoutFixtureControl("markPending", () => override(...args)))
        : pending(...args);
    },
  );
  vi.spyOn(reportReceipts, "readUpdateFailureReportReceipt").mockImplementation((...args) => {
    const override = reportFixtureControls.getStore()?.readReceipt;
    return override
      ? Promise.resolve(withoutFixtureControl("readReceipt", () => override(...args)))
      : read(...args);
  });
});

// useStateDatabaseTempDirs restores the module spies before closing each suite's real stores.
afterEach(() => reportFixtureControls.disable());

export function submitUpdateFailureReportFixture(
  prepared: PreparedUpdateFailureReport,
  previewDigest: string,
  fixture: ReportFixtureOptions = {},
) {
  const { createIssue, reconcileIssue, finalizeReceipt, markPending, readReceipt, ...options } =
    fixture;
  return reportFixtureControls.run(
    { createIssue, reconcileIssue, finalizeReceipt, markPending, readReceipt },
    () => submitUpdateFailureReport(prepared, previewDigest, options),
  );
}

export function createUpdateFailureReportFixture(
  prepared: PreparedUpdateFailureReport,
  stateDir: string,
) {
  const env = { OPENCLAW_STATE_DIR: stateDir };
  return {
    prepared,
    stateDir,
    env,
    receipt: () => readUpdateFailureReportReceipt(prepared.attemptId, env),
    submit: (options: ReportFixtureOptions = {}) =>
      submitUpdateFailureReportFixture(prepared, prepared.previewDigest, { stateDir, ...options }),
  };
}

export async function expectMissing(file: string) {
  await expect(fs.stat(file)).rejects.toMatchObject({ code: "ENOENT" });
}

export function savedReportArtifactPath(
  prepared: PreparedUpdateFailureReport,
  reservationId: string,
  previewDigest = prepared.previewDigest,
): string {
  const parsed = path.parse(prepared.savedReportPath);
  const artifactKey = createHash("sha256")
    .update(`${reservationId}\0${previewDigest}`)
    .digest("hex");
  return path.join(parsed.dir, `${parsed.name}.${artifactKey}${parsed.ext}`);
}

function mockIssue<T extends githubIssue.GithubIssueSubmitResult>(
  result: T,
  create: boolean,
  controls: { afterAuth?: () => void; onCreate?: () => void } = {},
) {
  return vi.fn(async (_issue: PreparedGithubIssue, hooks: GithubIssueSubmitHooks) => {
    await hooks.afterAuthPreflight?.();
    controls.afterAuth?.();
    if (create) {
      const commitIssueCreate = await hooks.beforeIssueCreate?.();
      commitIssueCreate?.();
      controls.onCreate?.();
    }
    return result;
  });
}

export const mockCreatedIssue = (
  url: string,
  controls?: { afterAuth?: () => void; onCreate?: () => void },
) => mockIssue({ status: "created", url }, true, controls);
export const mockFallbackIssue = (url: string | undefined) => fallbackIssue(url, false);
export const mockFallbackAfterIssueCreateNoStart = (url: string | undefined) =>
  fallbackIssue(url, true);

function fallbackIssue(fallbackUrl: string | undefined, create: boolean) {
  if (!fallbackUrl) {
    throw new Error("expected an available browser handoff");
  }
  return mockIssue(
    {
      url: fallbackUrl,
      reason: create ? "transport-unavailable" : "cli-unavailable",
      status: "browser-fallback",
    },
    create,
  );
}

/** Age the persisted lease through a foreign writer, preserving worker-clock behavior. */
export function expireUpdateFailureReportReceipt(attemptId: string, stateDir: string): void {
  const key = `update-failure-report:${createHash("sha256").update(attemptId).digest("hex")}`;
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      const stateDb =
        getNodeSqliteKysely<Pick<OpenClawStateKyselyDatabase, "gateway_restart_sentinel">>(db);
      const row = executeSqliteQueryTakeFirstSync(
        db,
        stateDb
          .selectFrom("gateway_restart_sentinel")
          .select("message")
          .where("sentinel_key", "=", key),
      );
      if (!row?.message) {
        throw new Error("Expected an existing report lease");
      }
      const receipt: unknown = JSON.parse(row.message);
      if (!isRecord(receipt)) {
        throw new Error("Expected a serialized report lease");
      }
      if (receipt.preparingSinceMs !== undefined) {
        receipt.preparingSinceMs = 1;
      }
      executeSqliteQuerySync(
        db,
        stateDb
          .updateTable("gateway_restart_sentinel")
          .set({ message: JSON.stringify(receipt) })
          .where("sentinel_key", "=", key),
      );
    },
    { env: { OPENCLAW_STATE_DIR: stateDir } },
  );
}
