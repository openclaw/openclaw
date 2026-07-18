// Removed Workspaces state tests cover doctor detection and deletion.
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { withEnvAsync } from "../test-utils/env.js";
import { removedWorkspacesStateCheck } from "./doctor-removed-workspaces-state-check.js";

const runtime = { log() {}, error() {}, exit() {} };

describe("removed Workspaces state doctor check", () => {
  let root: string | undefined;

  afterEach(async () => {
    if (root !== undefined) {
      await fs.rm(root, { force: true, recursive: true });
      root = undefined;
    }
  });

  it("previews and removes the stale plugin state directory", async () => {
    root = await fs.mkdtemp(join(tmpdir(), "openclaw-workspaces-state-"));
    const staleDir = join(root, "workspaces");
    await fs.mkdir(join(staleDir, "assets"), { recursive: true });
    await fs.writeFile(join(staleDir, "workspaces.sqlite"), "stale", "utf8");

    await withEnvAsync({ OPENCLAW_STATE_DIR: root }, async () => {
      const findings = await removedWorkspacesStateCheck.detect({
        mode: "lint",
        runtime,
        cfg: {},
      });
      expect(findings).toEqual([
        expect.objectContaining({
          checkId: "core/doctor/removed-workspaces-state",
          path: staleDir,
          severity: "warning",
        }),
      ]);
      await expect(
        removedWorkspacesStateCheck.detect(
          { mode: "fix", runtime, cfg: {} },
          { paths: [join(root!, "other")] },
        ),
      ).resolves.toEqual([]);

      const preview = await removedWorkspacesStateCheck.repair?.(
        { mode: "fix", runtime, cfg: {}, dryRun: true },
        findings,
      );
      expect(preview).toMatchObject({
        changes: [expect.stringContaining("Would remove retired Workspaces plugin state")],
        effects: [
          {
            action: "would-remove-retired-workspaces-state",
            dryRunSafe: false,
            kind: "state",
            target: staleDir,
          },
        ],
      });
      await expect(fs.stat(staleDir)).resolves.toBeDefined();

      const repaired = await removedWorkspacesStateCheck.repair?.(
        { mode: "fix", runtime, cfg: {} },
        findings,
      );
      expect(repaired).toMatchObject({
        changes: [expect.stringContaining("Removed retired Workspaces plugin state")],
        effects: [
          {
            action: "remove-retired-workspaces-state",
            dryRunSafe: false,
            kind: "state",
            target: staleDir,
          },
        ],
      });
      await expect(fs.stat(staleDir)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(
        removedWorkspacesStateCheck.detect({ mode: "lint", runtime, cfg: {} }),
      ).resolves.toEqual([]);
    });
  });
});
