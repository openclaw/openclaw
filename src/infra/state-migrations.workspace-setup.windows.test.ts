import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { readWorkspaceStateSnapshot } from "../agents/workspace-state-store.js";
import { useWorkspaceMigrationTestFixture } from "./state-migrations.workspace-setup.test-support.js";

const { migrate, setup } = useWorkspaceMigrationTestFixture();

it.runIf(process.platform === "win32")(
  "migrates legacy workspace setup with a synchronized archive on Windows",
  async () => {
    const context = setup();
    const source = path.join(context.workspaceDir, "openclaw-workspace-state.json");
    const completedAt = "2026-07-15T10:01:00.000Z";
    const raw = `${JSON.stringify({ version: 1, setupCompletedAt: completedAt })}\n`;
    fs.writeFileSync(source, raw);

    expect((await migrate(context)).warnings).toEqual([]);

    expect((await readWorkspaceStateSnapshot(context.workspaceDir)).setup).toMatchObject({
      setupCompletedAt: completedAt,
    });
    expect(fs.existsSync(source)).toBe(false);
    expect(fs.existsSync(`${source}.doctor-importing`)).toBe(false);
    const archives = fs
      .readdirSync(context.workspaceDir)
      .filter((name) => name.startsWith("openclaw-workspace-state.json.migrated."));
    expect(archives).toHaveLength(1);
    expect(fs.readFileSync(path.join(context.workspaceDir, archives[0]!), "utf8")).toBe(raw);
  },
);
