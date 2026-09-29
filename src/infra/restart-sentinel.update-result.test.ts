import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { withEnvAsync } from "../test-utils/env.js";
import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "./kysely-sync.js";
import { readRestartSentinel, writeRestartSentinel } from "./restart-sentinel.js";
import {
  buildControlPlaneUpdateRestartHealthPendingResult,
  isPendingControlPlaneUpdateRestartSentinel,
  markControlPlaneUpdateRestartSentinelFailure,
  writeControlPlaneUpdateRestartSentinel,
} from "./update-control-plane-sentinel.js";
import { prepareUpdateFailureReport } from "./update-failure-report-prepare.js";
import type { UpdateRestartSentinelMeta } from "./update-restart-sentinel-payload.js";
import { buildUpdateRestartSentinelPayload } from "./update-restart-sentinel-payload.js";
import { createUpdateRun, finishUpdateRun, getUpdateRun } from "./update-run-ledger.js";
import type { UpdateRunRecord } from "./update-run-record.js";

// Frozen v2026.9.4 reader contract; do not replace with the current recovery schema.
// https://github.com/openclaw/openclaw/blob/3a9d69db306cd7f081e06254cb89c4bcc14a7107/src/infra/update-recovery.ts
const releasedRecoverySchema = z.discriminatedUnion("serviceRestartSafe", [
  z.strictObject({
    serviceRestartSafe: z.literal(true),
    packageRollbackVerified: z.literal(true).optional(),
    version: z.string().trim().min(1),
    buildId: z.string().trim().min(1).max(96).optional(),
    service: z.enum(["healthy", "failed"]).optional(),
  }),
  z.strictObject({
    serviceRestartSafe: z.literal(false),
    packageRollbackVerified: z.boolean().optional(),
    reason: z.enum([
      "source-rollback-failed",
      "state-migration-started",
      "manager-unavailable",
      "deps-install-failed",
      "build-failed",
      "rollback-checkout-dirty",
      "runtime-verification-failed",
    ]),
  }),
]);

async function withRestartSentinelStateDir(run: () => Promise<void>): Promise<void> {
  await withTestDir({ prefix: "openclaw-sentinel-" }, async (tempDir) => {
    try {
      await withEnvAsync({ OPENCLAW_STATE_DIR: tempDir }, run);
    } finally {
      closeOpenClawStateDatabaseForTest();
    }
  });
}

describe("control-plane update restart sentinel", () => {
  it.each([
    { status: "ok", reason: undefined, eligible: true },
    { status: "error", reason: "doctor-failed", eligible: false },
    { status: "skipped", reason: "already-current", eligible: true },
    { status: "skipped", reason: "cancelled", eligible: false },
  ] as const)(
    "publishes exhausted readiness without a success continuation (status=$status, reason=$reason)",
    ({ status, reason, eligible }) => {
      const payload = buildUpdateRestartSentinelPayload({
        result: {
          status,
          reason,
          mode: "npm",
          durationMs: 90_000,
          steps: [
            {
              name: "gateway verification",
              command: "gateway verification",
              cwd: "/candidate",
              durationMs: 90_000,
              exitCode: 0,
              termination: "timeout",
              advisory: {
                kind: "recoverable-maintenance",
                message: "Readiness observation ended after 90s; PID 7376 still running.",
              },
            },
          ],
        },
        meta: { continuationMessage: "Continue after success" },
      });
      expect(payload).toMatchObject({
        status: eligible ? "skipped" : status,
        stats: { reason: eligible ? "gateway-readiness-unverified" : reason },
      });
      expect(payload.continuation).toBeUndefined();
      expect(isPendingControlPlaneUpdateRestartSentinel(payload)).toBe(false);
    },
  );

  it.each(["handoff", "restart", "rollback", "unsafe", "success"] as const)(
    "does not publish a targetless CLI %s notice for a restored runtime",
    async (phase) => {
      await withRestartSentinelStateDir(async () => {
        const run = createUpdateRun({ trigger: "cli" });
        const status =
          phase === "handoff" || phase === "restart"
            ? "skipped"
            : phase === "success"
              ? "ok"
              : "error";
        const reason =
          phase === "handoff"
            ? "managed-service-handoff-started"
            : phase === "restart"
              ? "restart-health-pending"
              : "restart-unhealthy";
        if (phase === "rollback") {
          finishUpdateRun(run.runId, { status: "rolled-back", reason });
        }
        const before = getUpdateRun(run.runId);
        await writeControlPlaneUpdateRestartSentinel({
          meta: { runId: run.runId, handoffId: "owned-handoff", root: "/owned/package" },
          result: {
            runId: run.runId,
            status,
            reason,
            mode: "npm",
            steps: [],
            durationMs: 1,
            ...(phase === "unsafe"
              ? { recovery: { serviceRestartSafe: false, reason: "runtime-verification-failed" } }
              : {}),
          },
        });
        expect(await readRestartSentinel()).toBeNull();
        expect(getUpdateRun(run.runId)).toEqual(before);
      });
    },
  );

  it.each<{
    label: string;
    meta: UpdateRestartSentinelMeta;
    origin?: UpdateRunRecord["origin"];
    trigger?: "api";
    unknown?: boolean;
  }>([
    { label: "session", meta: { sessionKey: "agent:ops:main" } },
    { label: "delivery", meta: { deliveryContext: { channel: "slack", to: "room" } } },
    { label: "thread", meta: { threadId: "thread-1" } },
    { label: "note", meta: { note: "Explicit operator follow-up" } },
    { label: "continuation", meta: { continuationMessage: "Resume the requested work" } },
    { label: "recorded session", meta: {}, origin: { sessionKey: "agent:ops:main" } },
    {
      label: "recorded delivery",
      meta: {},
      origin: { deliveryContext: { channel: "slack", to: "room" } },
    },
    { label: "Gateway", meta: {}, trigger: "api" as const },
    { label: "unknown run", meta: {}, unknown: true },
  ])("retains the $label update notice", async ({ meta, origin, trigger, unknown }) => {
    await withRestartSentinelStateDir(async () => {
      const run = unknown ? undefined : createUpdateRun({ trigger: trigger ?? "cli", origin });
      await writeControlPlaneUpdateRestartSentinel({
        meta: { ...meta, runId: run?.runId },
        result: { status: "ok", mode: "npm", steps: [], durationMs: 1 },
      });
      const payload = (await readRestartSentinel())?.payload;
      expect(payload).toMatchObject({ kind: "update", status: "ok" });
      expect(payload?.message).toBe(meta.note ?? undefined);
      if (meta.sessionKey) {
        expect(payload?.sessionKey).toBe(meta.sessionKey);
      }
      if (meta.deliveryContext) {
        expect(payload?.deliveryContext).toEqual(meta.deliveryContext);
      }
      if (meta.threadId) {
        expect(payload?.threadId).toBe(meta.threadId);
      }
      if (meta.continuationMessage) {
        expect(payload?.continuation).toEqual({
          kind: "agentTurn",
          message: meta.continuationMessage,
        });
      }
    });
  });

  it.each(["cli", "api"] as const)(
    "keeps pending notice failure marking scoped to requested %s reporting",
    async (trigger) => {
      await withRestartSentinelStateDir(async () => {
        const run = createUpdateRun({ trigger });
        const noticeOwner = trigger === "cli" ? createUpdateRun({ trigger: "api" }) : run;
        await writeRestartSentinel(
          buildUpdateRestartSentinelPayload({
            result: {
              status: "skipped",
              mode: "npm",
              reason: "restart-health-pending",
              steps: [],
              durationMs: 1,
            },
            meta: { runId: noticeOwner.runId, sessionKey: "agent:ops:main" },
          }),
        );
        const before = await readRestartSentinel();
        const marked = await markControlPlaneUpdateRestartSentinelFailure("restart-unhealthy", {
          runId: run.runId,
        });
        if (trigger === "cli") {
          expect(marked).toBeNull();
          expect(await readRestartSentinel()).toEqual(before);
        } else {
          expect(marked).toMatchObject({
            status: "error",
            stats: { runId: run.runId, reason: "restart-unhealthy" },
          });
          expect((await readRestartSentinel())?.payload).toEqual(marked);
        }
      });
    },
  );

  it.each(["recorded", "explicit", "other-session", "other-delivery", "same-route"] as const)(
    "carries the complete %s notice route without mixing destinations",
    async (route) => {
      await withRestartSentinelStateDir(async () => {
        const origin = {
          sessionKey: "agent:ops:telegram:group:room",
          deliveryContext: {
            channel: "telegram",
            to: "room",
            accountId: "recorded-account",
            threadId: "recorded-thread",
          },
        };
        const run = createUpdateRun({ trigger: "cli", origin });
        const meta: UpdateRestartSentinelMeta = {
          runId: run.runId,
          handoffId: "owner",
          note: "Requested note",
          continuationMessage: "Requested continuation",
          ...(route === "explicit"
            ? {
                sessionKey: "agent:other:slack:channel:room2",
                deliveryContext: { channel: "slack", to: "room2", accountId: "explicit-account" },
                threadId: "explicit-thread",
              }
            : route === "other-session"
              ? { sessionKey: "agent:other:main" }
              : route === "other-delivery"
                ? {
                    deliveryContext: {
                      channel: "slack",
                      to: "room2",
                      accountId: "explicit-account",
                    },
                  }
                : route === "same-route"
                  ? { sessionKey: origin.sessionKey, deliveryContext: { channel: "telegram" } }
                  : {}),
        };
        await writeControlPlaneUpdateRestartSentinel({
          meta,
          result: { status: "ok", mode: "npm", steps: [], durationMs: 1 },
        });
        const payload = (await readRestartSentinel())?.payload;
        expect(payload?.sessionKey).toBe(meta.sessionKey ?? origin.sessionKey);
        expect(payload?.deliveryContext).toEqual(
          route === "other-session"
            ? undefined
            : route === "explicit" || route === "other-delivery"
              ? meta.deliveryContext
              : {
                  channel: "telegram",
                  to: "room",
                  accountId: "recorded-account",
                },
        );
        expect(payload?.threadId).toBe(
          route === "other-session" || route === "other-delivery"
            ? undefined
            : (meta.threadId ?? "recorded-thread"),
        );
        expect(payload?.message).toBe(meta.note);
        expect(payload?.continuation).toEqual({
          kind: "agentTurn",
          message: meta.continuationMessage,
        });
        expect(payload?.stats).toMatchObject({ runId: run.runId, handoffId: "owner" });
      });
    },
  );

  it.each(["other-run", "other-handoff", "matching"] as const)(
    "binds a routed failure marker to the %s sentinel owner",
    async (owner) => {
      await withRestartSentinelStateDir(async () => {
        const run = createUpdateRun({ trigger: "api", origin: { sessionKey: "agent:ops:main" } });
        const other = createUpdateRun({ trigger: "api" });
        await writeRestartSentinel(
          buildUpdateRestartSentinelPayload({
            result: { status: "ok", mode: "npm", steps: [], durationMs: 1 },
            meta: {
              runId: owner === "other-run" ? other.runId : run.runId,
              handoffId: owner === "other-handoff" ? "successor" : "original",
              sessionKey: "agent:ops:main",
              continuationMessage: "Do not lose the requested continuation",
            },
          }),
        );
        const before = await readRestartSentinel();
        const marked = await markControlPlaneUpdateRestartSentinelFailure("restart-unhealthy", {
          runId: run.runId,
          handoffId: "original",
        });
        if (owner === "matching") {
          expect(marked).toMatchObject({
            status: "error",
            stats: { runId: run.runId, handoffId: "original", reason: "restart-unhealthy" },
          });
          expect(marked?.continuation).toBeUndefined();
        } else {
          expect(marked).toBeNull();
          expect(await readRestartSentinel()).toEqual(before);
        }
      });
    },
  );

  it.each([undefined, "agent:main:main"])(
    "does not infer a continuation from an update's session route (%s)",
    (sessionKey) => {
      const payload = buildUpdateRestartSentinelPayload({
        result: { status: "ok", mode: "npm", steps: [], durationMs: 1 },
        meta: sessionKey ? { sessionKey } : {},
        nowMs: 1,
      });

      expect(payload.sessionKey).toBe(sessionKey);
      expect(payload.continuation).toBeUndefined();
    },
  );

  it("preserves advisory step classification through the typed sentinel round trip", async () => {
    await withRestartSentinelStateDir(async () => {
      await writeRestartSentinel(
        buildUpdateRestartSentinelPayload({
          result: {
            status: "error",
            mode: "npm",
            steps: [
              {
                name: "post-install doctor",
                command: "openclaw doctor",
                cwd: "/tmp/openclaw",
                durationMs: 1,
                exitCode: 86,
                advisory: {
                  kind: "package-post-install-doctor",
                  message: "private advisory detail",
                },
              },
            ],
            durationMs: 1,
          },
          meta: {},
        }),
      );

      const steps = (await readRestartSentinel())?.payload.stats?.steps;
      expect(steps).toEqual([
        expect.objectContaining({ name: "post-install doctor", advisory: true }),
      ]);
      expect(JSON.stringify(steps)).not.toContain("private advisory detail");
    });
  });

  it.each([
    { serviceRestartSafe: false, reason: "runtime-verification-failed" },
    { serviceRestartSafe: true, version: "1.0.0", service: "failed" },
    {
      serviceRestartSafe: true,
      version: "1.0.0",
      buildId: "restored-git-build",
      service: "healthy",
    },
    { serviceRestartSafe: false, reason: "state-migration-started" },
  ] as const)(
    "preserves recovery through the typed sentinel round trip ($serviceRestartSafe)",
    async (recovery) => {
      await withRestartSentinelStateDir(async () => {
        await writeRestartSentinel(
          buildUpdateRestartSentinelPayload({
            result: { status: "error", mode: "npm", recovery, steps: [], durationMs: 1 },
            meta: {},
          }),
        );
        expect((await readRestartSentinel())?.payload.stats?.recovery).toEqual(recovery);
      });
    },
  );

  it.each([
    { service: "failed", reason: "channel-errors", health: "failed" },
    { service: undefined, reason: "gateway-readiness-pending", health: "unverified" },
  ] as const)(
    "keeps $health rollback notifications readable by released 2026.9.4",
    async ({ service, reason, health }) => {
      await withRestartSentinelStateDir(async () => {
        const persisted = {
          serviceRestartSafe: true as const,
          version: "2026.9.4",
          buildId: "restored-build",
          ...(service ? { service } : {}),
        };
        const result = {
          status: "error" as const,
          mode: "npm" as const,
          reason: "readyz-unhealthy",
          recovery: { ...persisted, packageRollbackVerified: true as const, reason },
          steps: [],
          durationMs: 1,
        };
        await writeControlPlaneUpdateRestartSentinel({
          result,
          meta: { sessionKey: "agent:main:main" },
        });
        const { db } = openOpenClawStateDatabase();
        const row = executeSqliteQueryTakeFirstSync(
          db,
          getNodeSqliteKysely<OpenClawStateKyselyDatabase>(db)
            .selectFrom("gateway_restart_sentinel")
            .select("stats_json")
            .where("sentinel_key", "=", "current"),
        );
        const stats = z
          .object({ recovery: releasedRecoverySchema })
          .parse(JSON.parse(row?.stats_json ?? "null"));
        expect(stats.recovery).toEqual(persisted);
        expect(result.recovery).toEqual({ ...persisted, packageRollbackVerified: true, reason });
        const report = await prepareUpdateFailureReport({ attemptId: "released-reader", result });
        expect(report.body).toContain(`Gateway health ${health} (${reason})`);
      });
    },
  );

  it.each([true, false])(
    "keeps package rollback diagnostics out of prior-runtime sentinel recovery (%s)",
    async (packageRollbackVerified) => {
      const priorUnsafeRecoverySchema = z.strictObject({
        serviceRestartSafe: z.literal(false),
        reason: z.enum([
          "source-rollback-failed",
          "state-migration-started",
          "manager-unavailable",
          "deps-install-failed",
          "build-failed",
          "rollback-checkout-dirty",
          "runtime-verification-failed",
        ]),
      });
      const recovery = {
        serviceRestartSafe: false as const,
        reason: "runtime-verification-failed" as const,
        packageRollbackVerified,
      };
      const payload = buildUpdateRestartSentinelPayload({
        result: { status: "error", mode: "npm", recovery, steps: [], durationMs: 1 },
        meta: {},
      });

      expect(recovery.packageRollbackVerified).toBe(packageRollbackVerified);
      expect(payload.stats?.recovery).toEqual({
        serviceRestartSafe: false,
        reason: "runtime-verification-failed",
      });
      expect(priorUnsafeRecoverySchema.safeParse(payload.stats?.recovery).success).toBe(true);

      await withRestartSentinelStateDir(async () => {
        await writeRestartSentinel(payload);
        expect((await readRestartSentinel())?.payload.stats?.recovery).toEqual({
          serviceRestartSafe: false,
          reason: "runtime-verification-failed",
        });
      });
    },
  );

  it.each(["ok", "skipped"] as const)(
    "preserves the same-revision Git producer's %s outcome",
    (status) => {
      const payload = buildUpdateRestartSentinelPayload({
        result: {
          status,
          ...(status === "skipped" ? { reason: "already-current" } : {}),
          mode: "git",
          before: { sha: "aaaaaaaa" },
          after: { sha: "aaaaaaaa" },
          steps: [],
          durationMs: 42,
        },
        meta: { continuationMessage: "Verify the completed runtime maintenance." },
        nowMs: 1,
      });

      expect(payload.status).toBe(status);
      expect(payload.stats?.reason).toBe(status === "skipped" ? "already-current" : null);
      expect(payload.continuation).toEqual(
        status === "ok"
          ? {
              kind: "agentTurn",
              message: "Verify the completed runtime maintenance.",
            }
          : undefined,
      );
    },
  );

  it("keeps restart-health-pending sentinels continuation-free until final success", () => {
    const result = {
      runId: "ab186c13-181b-4cf7-a882-c179928539e6",
      status: "ok" as const,
      mode: "npm" as const,
      root: "/tmp/openclaw",
      before: { version: "2026.4.23" },
      after: { version: "2026.4.24" },
      steps: [],
      durationMs: 42,
      recovery: { serviceRestartSafe: true, version: "2026.4.24" } as const,
    };
    const meta = {
      target: "version 2026.4.24",
      sessionKey: "agent:main:webchat:dm:user-123",
      continuationMessage: "  Check the running version and finish the update report.\n",
    };

    const pendingResult = buildControlPlaneUpdateRestartHealthPendingResult(result);
    const pendingPayload = buildUpdateRestartSentinelPayload({
      result: pendingResult,
      meta,
      nowMs: 1,
    });

    expect(pendingPayload.status).toBe("skipped");
    expect(pendingPayload.stats).toMatchObject({
      runId: result.runId,
      reason: "restart-health-pending",
    });
    expect(pendingPayload.continuation).toBeUndefined();
    expect(isPendingControlPlaneUpdateRestartSentinel(pendingPayload)).toBe(true);

    const finalPayload = buildUpdateRestartSentinelPayload({
      result,
      meta,
      nowMs: 2,
    });

    expect(finalPayload.status).toBe("ok");
    expect(finalPayload.stats).toMatchObject({
      runId: result.runId,
      target: "version 2026.4.24",
      recovery: { serviceRestartSafe: true },
    });
    expect(finalPayload.continuation).toEqual({
      kind: "agentTurn",
      message: "Check the running version and finish the update report.",
    });
    expect(isPendingControlPlaneUpdateRestartSentinel(finalPayload)).toBe(false);
  });
});
