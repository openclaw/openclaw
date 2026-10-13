import { createHash } from "node:crypto";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { vi } from "vitest";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import type { GithubIssueSubmitHooks, PreparedGithubIssue } from "./github-issue.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";
import { readUpdateFailureReportReceipt } from "./restart-sentinel.js";
import type { PreparedUpdateFailureReport } from "./update-failure-report-prepare.js";
import { submitUpdateFailureReport } from "./update-failure-report.js";

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
    submit: (options: Parameters<typeof submitUpdateFailureReport>[2] = {}) =>
      submitUpdateFailureReport(prepared, prepared.previewDigest, { stateDir, ...options }),
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
