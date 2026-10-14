import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { MigrationPlan } from "../plugins/migration-provider.types.js";
import {
  buildSetupMigrationPlanSourceSnapshot,
  buildSetupMigrationTargetSnapshot,
} from "./setup.migration-snapshot.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it.runIf(process.platform !== "win32")(
  "preserves persisted migration fingerprints across filesystem traversal changes",
  async () => {
    const root = tempDirs.make("openclaw-migration-fingerprint-");
    const workspaceDir = path.join(root, "workspace");
    const stateDir = path.join(root, "state");
    await fs.mkdir(path.join(workspaceDir, "nested"), { recursive: true });
    await fs.mkdir(path.join(workspaceDir, "empty"));
    await fs.mkdir(path.join(stateDir, "credentials"), { recursive: true });
    await fs.mkdir(path.join(stateDir, "agents"));
    await fs.writeFile(path.join(workspaceDir, "nested", "notes.txt"), "alpha\r\nΩ\0tail\n");
    await fs.writeFile(path.join(workspaceDir, "payload"), Buffer.alloc(80 * 1024, 0xa7));
    await fs.writeFile(path.join(stateDir, "credentials", "fixture"), "synthetic credential\n");
    await fs.writeFile(path.join(root, "source.db"), "synthetic database\n");
    await fs.writeFile(path.join(root, "source.db-wal"), "synthetic WAL\n");
    await fs.symlink("nested/notes.txt", path.join(workspaceDir, "file-link"));
    await fs.symlink("nested", path.join(workspaceDir, "directory-link"));
    await fs.symlink("missing-target", path.join(workspaceDir, "dangling"));
    await fs.symlink(".", path.join(workspaceDir, "cycle"));
    const plan: MigrationPlan = {
      providerId: "fixture",
      source: "fixture",
      items: ["workspace", "source.db", "missing-source"].map((source) => ({
        id: source,
        kind: "memory",
        action: "copy",
        status: "planned",
        source: path.join(root, source),
      })),
      summary: {
        total: 3,
        planned: 3,
        migrated: 0,
        skipped: 0,
        conflicts: 0,
        errors: 0,
        sensitive: 0,
      },
    };

    const source = await buildSetupMigrationPlanSourceSnapshot(plan);
    const target = await buildSetupMigrationTargetSnapshot({
      config: {
        gateway: { port: 18789 },
        wizard: { lastRunMode: "local", securityAcknowledgedAt: "2026-09-01T00:00:00Z" },
        telemetry: { enabled: false, consentedAt: "2026-09-01T00:00:00Z" },
      },
      stateDir,
      workspaceDir,
    });
    // Captured from the separate source/target walkers before their consolidation.
    expect({ source, target }).toEqual({
      source: "e6266b4e63d5f3534aecd6bc54dc10e027a9d03ed117ad0378a3abe1752b67ee",
      target: "0aa972f6bef48d23586313cbb04b873d75e547ff8dab7768ce64312cae6728c6",
    });
  },
);
