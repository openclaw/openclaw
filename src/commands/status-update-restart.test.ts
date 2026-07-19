// Status update restart tests cover restart sentinel messages and update restart action lines.
import { describe, expect, it } from "vitest";
import type { RestartSentinelPayload } from "../infra/restart-sentinel.js";
import {
  formatUpdateRestartActionLines,
  formatUpdateRestartStatusValue,
  formatUpdateTransactionDoctorLines,
} from "./status-update-restart.ts";

const basePayload = {
  kind: "update",
  status: "skipped",
  ts: 1_000,
  stats: { mode: "npm", steps: [] },
} satisfies RestartSentinelPayload;

describe("status update restart formatting", () => {
  it("surfaces failed update restarts with deep status guidance", () => {
    const value = formatUpdateRestartStatusValue(
      {
        ...basePayload,
        status: "error",
        stats: { ...basePayload.stats, reason: "managed-service-handoff-failed" },
      },
      { nowMs: 61_000, formatTimeAgo: (ageMs) => `${ageMs}ms`, warn: (text) => `warn(${text})` },
    );

    expect(value).toBe(
      "warn(failed · managed-service-handoff-failed · run openclaw gateway status --deep · 60000ms)",
    );
  });

  it("labels handoff and health-pending sentinels as restart pending", () => {
    expect(
      formatUpdateRestartStatusValue({
        ...basePayload,
        stats: { ...basePayload.stats, reason: "managed-service-handoff-started" },
      }),
    ).toBe("handoff running · gateway restart pending · run openclaw update status");
    expect(
      formatUpdateRestartStatusValue({
        ...basePayload,
        stats: { ...basePayload.stats, reason: "restart-health-pending" },
      }),
    ).toBe("restart pending health verification · run openclaw gateway status --deep");
  });

  it("formats verified update restarts with the running gateway version", () => {
    expect(
      formatUpdateRestartStatusValue(
        {
          ...basePayload,
          status: "ok",
          stats: { ...basePayload.stats, after: { version: "2026.5.15" } },
        },
        { ok: (text) => `ok(${text})` },
      ),
    ).toBe("ok(verified · gateway 2026.5.15)");
  });

  it("narrates confirmation and rollback transaction states", () => {
    const pending = {
      ...basePayload,
      stats: {
        ...basePayload.stats,
        reason: "update-confirmation-pending",
        updatePhase: "confirm",
        confirmationTier: "human",
        confirmationStatus: "delivery-acked",
      },
    } satisfies RestartSentinelPayload;
    expect(formatUpdateRestartStatusValue(pending)).toBe(
      "update confirm · awaiting human confirmation",
    );
    expect(formatUpdateTransactionDoctorLines(pending)).toEqual([
      "Update transaction: phase=confirm; confirmation=human/delivery-acked.",
      "Update transaction reason: update-confirmation-pending",
    ]);
    const confirmed = {
      ...pending,
      stats: {
        ...pending.stats,
        confirmationTier: "delivery" as const,
        confirmationStatus: "delivery-acked" as const,
      },
    };
    expect(formatUpdateRestartStatusValue(confirmed)).toBe("confirmed · cleanup pending");
    expect(formatUpdateRestartActionLines(confirmed)).toEqual([]);
    expect(
      formatUpdateRestartStatusValue({
        ...pending,
        status: "error",
        stats: { ...pending.stats, reason: "update-rollback-completed: confirmation timed out" },
      }),
    ).toBe("rolled back · previous package and state restored");
  });

  it("adds action lines for failed and pending update restarts only", () => {
    expect(
      formatUpdateRestartActionLines({
        ...basePayload,
        status: "error",
        stats: { ...basePayload.stats, reason: "managed-service-handoff-failed" },
      }),
    ).toContain("Update restart failed; run openclaw gateway status --deep.");
    expect(
      formatUpdateRestartActionLines({
        ...basePayload,
        stats: { ...basePayload.stats, reason: "restart-health-pending" },
      }),
    ).toContain(
      "Update restart is still pending; run openclaw update status --json for handoff state.",
    );
    expect(
      formatUpdateRestartActionLines({
        ...basePayload,
        status: "ok",
      }),
    ).toEqual([]);
  });
});
