import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertNoUnmigratedWorkspaceState } from "../agents/workspace-legacy-state.js";
import { readWorkspaceStateSnapshot } from "../agents/workspace-state-store.js";
import * as durability from "./directory-durability.js";
import { migrateLegacyWorkspaceState } from "./state-migrations.workspace-setup.js";
import { useWorkspaceMigrationTestFixture } from "./state-migrations.workspace-setup.test-support.js";

describe("workspace migration portable-move recovery", () => {
  const { detect, migrate, setup } = useWorkspaceMigrationTestFixture();
  afterEach(() => vi.restoreAllMocks());

  it.skipIf(process.platform === "win32")(
    "preserves the source until its archive directory can be synchronized",
    async () => {
      const context = setup();
      const source = path.join(context.workspaceDir, "openclaw-workspace-state.json");
      const completedAt = "2026-07-15T10:01:00.000Z";
      const raw = `${JSON.stringify({ version: 1, setupCompletedAt: completedAt })}\n`;
      fs.writeFileSync(source, raw);
      const pinDirectory = durability.pinDirectory;
      const pin = vi.spyOn(durability, "pinDirectory").mockImplementation(async (...args) => {
        const directory = await pinDirectory(...args);
        vi.spyOn(directory, "sync").mockResolvedValue({ status: "unsupported", code: "EINVAL" });
        return directory;
      });

      const refused = await migrate(context);

      expect(refused.warnings).toEqual([
        expect.stringContaining("Workspace setup archive directory does not support"),
      ]);
      expect(fs.readFileSync(source, "utf8")).toBe(raw);
      expect(fs.existsSync(`${source}.doctor-importing`)).toBe(false);
      expect(() =>
        assertNoUnmigratedWorkspaceState({ workspaceDir: context.workspaceDir }),
      ).toThrow();
      pin.mockRestore();

      expect((await migrate(context)).warnings).toEqual([]);
      expect(fs.existsSync(source)).toBe(false);
      expect(await readWorkspaceStateSnapshot(context.workspaceDir)).toMatchObject({
        setup: { setupCompletedAt: completedAt },
      });
    },
  );

  it.each([false, true])(
    "settles an interrupted source/claim link without replaying state (receipt=%s)",
    async (receiptExists) => {
      const context = setup();
      const source = path.join(context.workspaceDir, ".openclaw", "workspace-state.json");
      const claim = `${source}.doctor-importing`;
      const completedAt = "2026-07-15T10:01:00.000Z";
      const raw = `${JSON.stringify({ version: 1, setupCompletedAt: completedAt })}\n`;
      fs.mkdirSync(path.dirname(source), { recursive: true });
      fs.writeFileSync(source, raw);
      if (receiptExists) {
        const first = await migrateLegacyWorkspaceState({
          detected: await detect(context),
          env: context.env,
          stateDir: context.stateDir,
          removeSource: () => {
            throw new Error("Interrupted cleanup");
          },
        });
        expect(first.warnings).toHaveLength(1);
        fs.linkSync(claim, source);
      } else {
        fs.linkSync(source, claim);
      }

      const result = await migrate(context);

      expect(result.warnings).toEqual([]);
      expect(fs.existsSync(source)).toBe(false);
      expect(fs.existsSync(claim)).toBe(false);
      expect(() =>
        assertNoUnmigratedWorkspaceState({ workspaceDir: context.workspaceDir }),
      ).not.toThrow();
      expect(await readWorkspaceStateSnapshot(context.workspaceDir)).toMatchObject({
        setup: { setupCompletedAt: completedAt },
      });
      const archives = fs.readdirSync(path.dirname(source));
      expect(archives).toHaveLength(1);
      expect(archives[0]).toMatch(/^workspace-state\.json\.migrated\./);
      expect(fs.readFileSync(path.join(path.dirname(source), archives[0]!), "utf8")).toBe(raw);
    },
  );
});
