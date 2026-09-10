import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { assertNoUnmigratedWorkspaceState } from "../agents/workspace-legacy-state.js";
import { resolveWorkspaceStateIdentity } from "../agents/workspace-state-identity.js";
import { readWorkspaceStateSnapshot } from "../agents/workspace-state-store.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { useWorkspaceMigrationTestFixture } from "./state-migrations.workspace-setup.test-support.js";

const HASH = "a".repeat(64);

describe("legacy workspace Doctor multi-agent migration", () => {
  const { migrate, setup } = useWorkspaceMigrationTestFixture();

  it("imports setup and attestation state, records receipts, and removes files", async () => {
    const context = setup();
    const workspaces = ["alpha", "beta", "gamma"].map((id) => ({
      id,
      workspace: path.join(context.homeDir, `workspace-${id}`),
    }));
    const cfg: OpenClawConfig = {
      agents: {
        ownership: "explicit",
        entries: Object.fromEntries(workspaces.map(({ id, workspace }) => [id, { workspace }])),
      },
    };
    const seededAt = "2026-07-15T10:00:00.000Z";
    const completedAt = "2026-07-15T10:01:00.000Z";
    const mtime = new Date("2026-07-15T11:02:03.456Z");
    const sources: string[] = [];
    for (const { workspace } of workspaces) {
      await fsp.mkdir(path.join(workspace, ".openclaw"), { recursive: true });
      for (const relative of ["openclaw-workspace-state.json", ".openclaw/workspace-state.json"]) {
        const setupPath = path.join(workspace, relative);
        await fsp.writeFile(
          setupPath,
          JSON.stringify({
            version: 1,
            bootstrapSeededAt: seededAt,
            setupCompletedAt: completedAt,
          }),
          "utf8",
        );
        sources.push(setupPath);
      }
      const identity = resolveWorkspaceStateIdentity(workspace);
      const attestationPath = path.join(
        context.stateDir,
        "workspace-attestations",
        `${identity.workspaceKey}.attested`,
      );
      await fsp.mkdir(path.dirname(attestationPath), { recursive: true });
      await fsp.writeFile(
        attestationPath,
        `openclaw-workspace-attestation:v1\n2026-07-15T11:00:00.000Z\ngenerated:AGENTS.md:${HASH}\n`,
        "utf8",
      );
      await fsp.utimes(attestationPath, mtime, mtime);
      sources.push(attestationPath);
    }
    const db = openOpenClawStateDatabase({ env: context.env }).db;
    expect(db.prepare("SELECT COUNT(*) AS count FROM workspace_setup_state").get()).toEqual({
      count: 0,
    });
    expect(db.prepare("SELECT COUNT(*) AS count FROM migration_sources").get()).toEqual({
      count: 0,
    });

    const result = await migrate({ ...context, cfg });

    expect(result.warnings).toEqual([]);
    expect(result.changes).toHaveLength(sources.length);
    for (const source of sources) {
      expect(fs.existsSync(source)).toBe(false);
      expect(fs.existsSync(`${source}.doctor-importing`)).toBe(false);
    }
    for (const { workspace } of workspaces) {
      const identity = resolveWorkspaceStateIdentity(workspace);
      expect(
        db
          .prepare(
            "SELECT workspace_path, bootstrap_seeded_at, setup_completed_at FROM workspace_setup_state WHERE workspace_key = ?",
          )
          .get(identity.workspaceKey),
      ).toEqual({
        workspace_path: identity.workspacePath,
        bootstrap_seeded_at: seededAt,
        setup_completed_at: completedAt,
      });
      expect(
        db
          .prepare("SELECT attested_at_ms FROM workspace_setup_state WHERE workspace_key = ?")
          .get(identity.workspaceKey),
      ).toEqual({ attested_at_ms: mtime.getTime() });
      expect(
        db
          .prepare(
            "SELECT filename, sha256 FROM workspace_generated_bootstrap_hashes WHERE workspace_key = ?",
          )
          .get(identity.workspaceKey),
      ).toEqual({ filename: "AGENTS.md", sha256: HASH });
      expect(readWorkspaceStateSnapshot(workspace)).toMatchObject({
        identity,
        setup: { bootstrapSeededAt: seededAt, setupCompletedAt: completedAt },
        attestation: { attestedAtMs: mtime.getTime() },
      });
      expect(() => assertNoUnmigratedWorkspaceState({ workspaceDir: workspace })).not.toThrow();
    }
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS count, SUM(removed_source) AS removed FROM migration_sources WHERE migration_kind = ?",
        )
        .get("legacy-workspace-setup-files"),
    ).toEqual({ count: sources.length, removed: sources.length });
    expect(await migrate({ ...context, cfg })).toEqual({ changes: [], warnings: [] });
  });
});
