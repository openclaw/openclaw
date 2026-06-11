import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runSelfImprovementMaintenance } from "./maintenance.js";

const tempDirs: string[] = [];
const now = Date.parse("2026-05-07T12:00:00.000Z");
const old = now - 120 * 24 * 60 * 60_000;

async function tempStateDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "openclaw-self-improvement-maintenance-"));
  tempDirs.push(dir);
  await mkdir(join(dir, "self-improvement"), { recursive: true });
  return dir;
}

async function writeStore(stateDir: string, filename: string, value: unknown) {
  await writeFile(
    join(stateDir, "self-improvement", filename),
    `${JSON.stringify(value, null, 2)}\n`,
    "utf8",
  );
}

async function readStore<T>(stateDir: string, filename: string): Promise<T> {
  return JSON.parse(await readFile(join(stateDir, "self-improvement", filename), "utf8")) as T;
}

describe("self-improvement retention maintenance", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
  });

  it("dry-runs without mutating stores", async () => {
    const stateDir = await tempStateDir();
    await writeStore(stateDir, "recommendations.json", {
      version: 2,
      recommendations: [
        { id: "active", status: "open", updatedAt: old, lastSeenAt: old },
        { id: "closed", status: "resolved", updatedAt: old, lastSeenAt: old },
      ],
    });

    const result = await runSelfImprovementMaintenance({ stateDir, now });

    expect(result.dryRun).toBe(true);
    expect(result.applied).toBe(false);
    expect(result.stores.find((store) => store.store === "recommendations")).toMatchObject({
      before: 2,
      after: 1,
      pruned: 1,
      retainedActive: 1,
    });
    const stored = await readStore<{ recommendations: unknown[] }>(
      stateDir,
      "recommendations.json",
    );
    expect(stored.recommendations).toHaveLength(2);
  });

  it("applies conservative pruning and writes sanitized count-only audit metadata", async () => {
    const stateDir = await tempStateDir();
    await writeStore(stateDir, "recommendations.json", {
      version: 2,
      recommendations: [
        {
          id: "active",
          status: "open",
          updatedAt: old,
          lastSeenAt: old,
          resolutionProof: "api_key=secret-value",
        },
        {
          id: "closed",
          status: "dismissed",
          updatedAt: old,
          lastSeenAt: old,
          dismissalReason: "token=secret-value",
        },
      ],
    });
    await writeStore(stateDir, "audit-events.json", {
      version: 1,
      events: [
        {
          id: "old_event",
          createdAt: old,
          kind: "analysis_run",
          actor: "governor",
          targetId: "analysis",
          summary: "Old event",
        },
      ],
    });
    await writeStore(stateDir, "health-snapshots.json", { version: 1, snapshots: [] });
    await writeStore(stateDir, "scorecards.json", { version: 1, scorecards: [] });
    await writeStore(stateDir, "proposals.json", { version: 1, proposals: [] });

    const result = await runSelfImprovementMaintenance({ stateDir, now, apply: true });

    expect(result.applied).toBe(true);
    expect(result.auditEventId).toBeTruthy();
    const recommendations = await readStore<{ recommendations: Array<{ id?: string }> }>(
      stateDir,
      "recommendations.json",
    );
    expect(recommendations.recommendations.map((entry) => entry.id)).toEqual(["active"]);
    const audit = await readStore<{
      events: Array<{ kind?: string; metadata?: Record<string, unknown> }>;
    }>(stateDir, "audit-events.json");
    const maintenanceEvent = audit.events.find((event) => event.kind === "retention_maintenance");
    expect(maintenanceEvent?.metadata).toMatchObject({
      totalBefore: expect.any(Number),
      totalAfter: expect.any(Number),
      totalPruned: expect.any(Number),
    });
    expect(JSON.stringify(maintenanceEvent)).not.toContain("secret-value");
    expect(JSON.stringify(maintenanceEvent)).not.toContain("api_key=");
    expect(JSON.stringify(maintenanceEvent)).not.toContain("token=");
  });
});
