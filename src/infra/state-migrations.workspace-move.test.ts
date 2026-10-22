import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import {
  detectRepointedWorkspaceAlias,
  rebindRepointedWorkspaceAlias,
} from "../agents/workspace-alias-rebind.js";
import { resolveWorkspaceStateIdentity } from "../agents/workspace-state-identity.js";
import { readWorkspaceStateSnapshot } from "../agents/workspace-state-store.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { readReceipt } from "./state-migrations.workspace-setup-receipts.js";
import { migrateLegacyWorkspaceState } from "./state-migrations.workspace-setup.js";
import { useWorkspaceMigrationTestFixture } from "./state-migrations.workspace-setup.test-support.js";

const { setup, detect, migrate } = useWorkspaceMigrationTestFixture();

it.each(["normal", "interrupted", "removed backup", "decomposed target", "decomposed source"])(
  "preserves migration history after a move: %s",
  async (mode) => {
    const interrupted = mode === "interrupted";
    const removeBackup = mode === "removed backup";
    const context = setup();
    const { env } = context;
    if (mode === "decomposed source") {
      const original = path.join(context.homeDir, "original-e\u0301");
      fs.renameSync(context.workspaceDir, original);
      context.workspaceDir = original;
    }
    const alias = path.join(context.homeDir, "workspace-alias");
    const moved = path.join(
      context.homeDir,
      mode === "decomposed target" ? "moved-e\u0301" : "moved-workspace",
    );
    const link = (dir: string) =>
      fs.symlinkSync(dir, alias, process.platform === "win32" ? "junction" : "dir");
    link(context.workspaceDir);
    const configured = {
      ...context,
      cfg: { agents: { defaults: { workspace: alias } } },
      workspaceDir: alias,
    };
    const milestones = {
      version: 1,
      bootstrapSeededAt: "2026-07-15T10:00:00.000Z",
      setupCompletedAt: "2026-07-15T10:01:00.000Z",
    };
    const raw = JSON.stringify(milestones);
    const sourcePath = path.join(context.workspaceDir, "openclaw-workspace-state.json");
    fs.writeFileSync(sourcePath, raw);
    const detected = await detect(configured);
    const source = detected.sources.find((entry) => entry.kind === "setup")!;
    const imported = await migrateLegacyWorkspaceState({
      detected,
      env,
      stateDir: context.stateDir,
      removeSource: interrupted
        ? () => {
            throw new Error("interrupted cleanup");
          }
        : undefined,
    });
    expect(imported.warnings).toHaveLength(interrupted ? 1 : 0);
    const originalReceipt = readReceipt(source, env)!;
    expect(originalReceipt.removedSource).toBe(!interrupted);
    if (removeBackup) {
      fs.unlinkSync(originalReceipt.archivePath!);
    }
    const { db } = openOpenClawStateDatabase({ env });
    const readRuns = () => db.prepare("SELECT * FROM migration_runs ORDER BY id").all();
    const runs = readRuns();

    fs.renameSync(context.workspaceDir, moved);
    fs.unlinkSync(alias);
    link(moved);
    const facts = detectRepointedWorkspaceAlias(alias, { env })!;
    expect(await rebindRepointedWorkspaceAlias(alias, facts, { env })).toBe("rebound");

    const identity = resolveWorkspaceStateIdentity(moved);
    const movedSource = {
      ...source,
      sourcePath: path.join(moved, "openclaw-workspace-state.json"),
      workspaceKey: identity.workspaceKey,
    };
    const receipt = readReceipt(movedSource, env);
    expect(receipt).toMatchObject({
      sha256: originalReceipt.sha256,
      removedSource: !interrupted,
      archivePath: expect.stringContaining(moved),
    });
    expect(fs.existsSync(receipt!.archivePath!)).toBe(!removeBackup);
    if (!removeBackup) {
      expect(fs.readFileSync(receipt!.archivePath!, "utf8")).toBe(raw);
    }
    expect(readRuns()).toEqual(runs);
    expect((await readWorkspaceStateSnapshot(alias)).setup).toEqual(milestones);
    const row = db
      .prepare("SELECT report_json FROM migration_sources WHERE source_key = ?")
      .get(receipt!.sourceKey)!;
    const canonical = JSON.stringify({
      kind: "setup",
      workspacePath: identity.workspacePath,
      ...milestones,
    });
    expect(JSON.parse(String(row.report_json))).toMatchObject({
      authoritative: true,
      canonicalFingerprint: createHash("sha256").update(canonical).digest("hex"),
    });

    const expectSettled = async () => {
      expect((await migrate(configured)).warnings).toEqual([]);
      expect((await readWorkspaceStateSnapshot(alias)).setup).toEqual(milestones);
      expect(readReceipt(movedSource, env)?.removedSource).toBe(true);
    };
    await expectSettled();
    expect(fs.existsSync(`${movedSource.sourcePath}.doctor-importing`)).toBe(false);
    expect(fs.existsSync(receipt!.archivePath!)).toBe(!removeBackup);

    // A removed source may have a later generation. The moved receipt must
    // preserve that distinction without replaying its replacement milestones.
    fs.writeFileSync(movedSource.sourcePath, '{"setupCompletedAt":"2026-07-16T00:00:00.000Z"}');
    await expectSettled();
  },
);
