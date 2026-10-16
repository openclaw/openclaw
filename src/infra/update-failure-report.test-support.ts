import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, vi } from "vitest";
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
import * as reportArtifacts from "./update-failure-report-artifact.js";
import type { PreparedUpdateFailureReport } from "./update-failure-report-prepare.js";
import { submitUpdateFailureReport } from "./update-failure-report.js";

type ReportFixtureControls = {
  createIssue?: (
    issue: PreparedGithubIssue,
    hooks: GithubIssueSubmitHooks,
  ) => githubIssue.GithubIssueSubmitResult | Promise<githubIssue.GithubIssueSubmitResult>;
  reconcileIssue?: (
    issue: PreparedGithubIssue,
    hooks: githubIssue.GithubIssueReconcileHooks,
  ) => Promise<githubIssue.GithubIssueReconcileResult>;
  finalizeReceipt?: (
    ...args: Parameters<typeof reportReceipts.finalizeUpdateFailureReportReceipt>
  ) => boolean | Promise<boolean>;
  markPending?: (
    ...args: Parameters<typeof reportReceipts.markUpdateFailureReportReceiptPending>
  ) => boolean | Promise<boolean>;
  readReceipt?: (
    ...args: Parameters<typeof reportReceipts.readUpdateFailureReportReceipt>
  ) =>
    | reportReceipts.UpdateFailureReportReceipt
    | null
    | Promise<reportReceipts.UpdateFailureReportReceipt | null>;
  artifactSweepHooks?: {
    beforeList?: () => Promise<void>;
    listCandidates?: typeof reportArtifacts.listRetiredUpdateFailureReportArtifacts;
  };
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
  const claim = reportReceipts.claimUpdateFailureReportArtifactSweep;
  const list = reportArtifacts.listRetiredUpdateFailureReportArtifacts;
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
  vi.spyOn(reportReceipts, "claimUpdateFailureReportArtifactSweep").mockImplementation(
    (...args) => {
      const beforeList = reportFixtureControls.getStore()?.artifactSweepHooks?.beforeList;
      const result = claim(...args);
      // Pause after the real claim commits, before the sweep's first lease read, as before.
      return beforeList
        ? result.then(async (claimed) => {
            if (claimed) {
              await withoutFixtureControl("artifactSweepHooks", beforeList);
            }
            return claimed;
          })
        : result;
    },
  );
  vi.spyOn(reportArtifacts, "listRetiredUpdateFailureReportArtifacts").mockImplementation(
    (...args) => {
      const override = reportFixtureControls.getStore()?.artifactSweepHooks?.listCandidates;
      return override
        ? withoutFixtureControl("artifactSweepHooks", () => override(...args))
        : list(...args);
    },
  );
});

// useStateDatabaseTempDirs restores the module spies before closing each suite's real stores.
afterEach(() => reportFixtureControls.disable());

export function submitUpdateFailureReportFixture(
  prepared: PreparedUpdateFailureReport,
  previewDigest: string,
  fixture: ReportFixtureOptions = {},
) {
  const {
    createIssue,
    reconcileIssue,
    finalizeReceipt,
    markPending,
    readReceipt,
    artifactSweepHooks,
    ...options
  } = fixture;
  return reportFixtureControls.run(
    { createIssue, reconcileIssue, finalizeReceipt, markPending, readReceipt, artifactSweepHooks },
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

export function mockCreatedIssue(url: string) {
  return vi.fn(async (_issue: PreparedGithubIssue, hooks: GithubIssueSubmitHooks) => {
    await hooks.afterAuthPreflight?.();
    const commitIssueCreate = await hooks.beforeIssueCreate?.();
    commitIssueCreate?.();
    return { status: "created" as const, url };
  });
}

export function mockFallbackIssue(fallbackUrl: string | undefined) {
  if (!fallbackUrl) {
    throw new Error("expected an available browser handoff");
  }
  return vi.fn(async (_issue: PreparedGithubIssue, hooks: GithubIssueSubmitHooks) => {
    await hooks.afterAuthPreflight?.();
    return {
      url: fallbackUrl,
      reason: "cli-unavailable" as const,
      status: "browser-fallback" as const,
    };
  });
}

export function mockFallbackAfterIssueCreateNoStart(fallbackUrl: string | undefined) {
  if (!fallbackUrl) {
    throw new Error("expected an available browser handoff");
  }
  return vi.fn(async (_issue: PreparedGithubIssue, hooks: GithubIssueSubmitHooks) => {
    await hooks.afterAuthPreflight?.();
    const commitIssueCreate = await hooks.beforeIssueCreate?.();
    commitIssueCreate?.();
    return {
      url: fallbackUrl,
      reason: "transport-unavailable" as const,
      status: "browser-fallback" as const,
    };
  });
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
      if (receipt.sweepSinceMs !== undefined) {
        receipt.sweepSinceMs = 1;
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
