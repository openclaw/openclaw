import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { resolveWorkspaceStateIdentity } from "../agents/workspace-state-identity.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { useWorkspaceMigrationTestFixture } from "./state-migrations.workspace-setup.test-support.js";

const { migrate, setup } = useWorkspaceMigrationTestFixture();
const original = "openclaw-workspace-attestation:v1\n2026-07-15T11:00:00.000Z\n";
const recreated = "openclaw-workspace-attestation:v1\n2026-07-16T11:00:00.000Z\n";
const originalMtime = new Date("2026-07-15T11:01:00.000Z");
const recreatedMtime = new Date("2026-07-16T11:01:00.000Z");
const sha256 = (content: string) => createHash("sha256").update(content).digest("hex");

function fixture() {
  const context = setup();
  const { workspaceKey } = resolveWorkspaceStateIdentity(context.workspaceDir);
  const row = (table: string, column: string, key: string) =>
    openOpenClawStateDatabase({ env: context.env })
      .db.prepare(`SELECT * FROM ${table} WHERE ${column} = ?`)
      .get(key);
  return {
    context,
    workspaceKey,
    state: () => row("workspace_setup_state", "workspace_key", workspaceKey),
    receipt: (file: string) => row("migration_sources", "source_path", file),
    migrate: () => migrate(context),
  };
}

it("cleans a covered setup marker recreated after completed migration", async () => {
  const f = fixture();
  const file = path.join(f.context.workspaceDir, "openclaw-workspace-state.json");
  const bootstrapSeededAt = "2026-07-15T10:00:00.000Z";
  const setupCompletedAt = "2026-07-15T10:01:00.000Z";
  await fsp.writeFile(file, JSON.stringify({ version: 1, bootstrapSeededAt, setupCompletedAt }));
  expect((await f.migrate()).warnings).toEqual([]);
  const content = JSON.stringify({ version: 1, setupCompletedAt });
  await fsp.writeFile(file, content);
  expect((await f.migrate()).warnings).toEqual([]);
  expect(fs.existsSync(file)).toBe(false);
  expect(f.state()).toMatchObject({
    bootstrap_seeded_at: bootstrapSeededAt,
    setup_completed_at: setupCompletedAt,
  });
  const receipt = f.receipt(file)!;
  expect(receipt).toMatchObject({ source_sha256: sha256(content), removed_source: 1 });
  expect(JSON.parse(String(receipt.report_json))).toMatchObject({
    authoritative: true,
    resolution: "verified",
  });
});

it.each(["source", "claim", "collision"] as const)(
  "handles a recreated attestation: %s",
  async (mode) => {
    const f = fixture();
    const file = path.join(
      f.context.stateDir,
      "workspace-attestations",
      `${f.workspaceKey}.attested`,
    );
    const claim = `${file}.doctor-importing`;
    const write = async (content: string, mtime: Date) => {
      await fsp.mkdir(path.dirname(file), { recursive: true });
      await fsp.writeFile(file, content);
      await fsp.utimes(file, mtime, mtime);
    };
    await write(original, originalMtime);
    expect((await f.migrate()).warnings).toEqual([]);
    await write(recreated, recreatedMtime);
    if (mode === "claim") {
      await fsp.rename(file, claim);
    } else if (mode === "collision") {
      await fsp.writeFile(claim, recreated);
    }
    const collision = mode === "collision";
    expect((await f.migrate()).warnings).toEqual(
      collision
        ? ["Workspace state is in SQLite, but source and interrupted claim both exist."]
        : [],
    );
    expect([fs.existsSync(file), fs.existsSync(claim)]).toEqual([collision, collision]);
    expect(f.state()).toMatchObject({
      attested_at_ms: (collision ? originalMtime : recreatedMtime).getTime(),
    });
    expect(f.receipt(file)).toMatchObject({
      source_sha256: sha256(collision ? original : recreated),
      removed_source: 1,
    });
  },
);
