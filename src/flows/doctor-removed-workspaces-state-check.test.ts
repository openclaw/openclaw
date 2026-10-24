import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { removedWorkspacesStateCheck as check } from "./doctor-removed-workspaces-state-check.js";

const runtime = { log() {}, error() {}, exit() {} };
const context = (cfg: OpenClawConfig = {}) => ({ mode: "fix" as const, runtime, cfg });

let root: string;
let staleDir: string;
beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), "openclaw-workspaces-state-"));
  staleDir = join(root, "workspaces");
  await fs.mkdir(staleDir);
  vi.stubEnv("OPENCLAW_STATE_DIR", root);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(root, { force: true, recursive: true });
});

async function fingerprint(kind: "sqlite" | "widgets-data" = "sqlite") {
  if (kind === "sqlite") {
    await fs.writeFile(join(staleDir, "workspaces.sqlite"), "stale", "utf8");
  } else {
    await Promise.all([fs.mkdir(join(staleDir, "widgets")), fs.mkdir(join(staleDir, "data"))]);
  }
}
const detect = (cfg: OpenClawConfig = {}) => check.detect({ ...context(cfg), mode: "lint" });
const repair = (cfg: OpenClawConfig = {}) => check.repair!(context(cfg), []);

it.each(["sqlite", "widgets-data"] as const)(
  "previews and removes the %s plugin state",
  async (kind) => {
    await fingerprint(kind);
    const findings = await detect();
    expect(findings).toEqual([
      expect.objectContaining({
        checkId: "core/doctor/removed-workspaces-state",
        path: staleDir,
        severity: "warning",
      }),
    ]);
    await expect(check.detect(context(), { paths: [join(root, "other")] })).resolves.toEqual([]);
    const effect = { dryRunSafe: false, kind: "state", target: staleDir };
    expect(await check.repair!({ ...context(), dryRun: true }, findings)).toMatchObject({
      changes: [expect.stringContaining("Would remove retired Workspaces plugin state")],
      effects: [{ ...effect, action: "would-remove-retired-workspaces-state" }],
    });
    await expect(fs.stat(staleDir)).resolves.toBeDefined();
    expect(await check.repair!(context(), findings)).toMatchObject({
      changes: [expect.stringContaining("Removed retired Workspaces plugin state")],
      effects: [{ ...effect, action: "remove-retired-workspaces-state" }],
    });
    await expect(fs.stat(staleDir)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(detect()).resolves.toEqual([]);
  },
);

it("ignores a plain user directory without plugin fingerprints", async () => {
  const notes = join(staleDir, "notes.md");
  await fs.writeFile(notes, "personal", "utf8");
  await expect(detect()).resolves.toEqual([]);
  await expect(repair()).resolves.toMatchObject({ status: "skipped", changes: [] });
  await expect(fs.readFile(notes, "utf8")).resolves.toBe("personal");
});

it.each(["retired directory", "symlink beneath state", "ancestor of state"])(
  "preserves an overlapping agent workspace (%s)",
  async (overlap) => {
    await fingerprint();
    let workspace = root;
    let preserved = staleDir;
    if (overlap === "symlink beneath state") {
      workspace = join(root, "active-agent-link");
      preserved = join(staleDir, "active-agent");
      await fs.mkdir(preserved);
      await fs.symlink(preserved, workspace, "dir");
    }
    const cfg = {
      agents:
        overlap === "retired directory"
          ? { entries: { ops: { workspace: join(staleDir, "..", "workspaces") } } }
          : { defaults: { workspace } },
    };
    const findings = await detect(cfg);
    expect(findings).toEqual([
      expect.objectContaining({
        message: expect.stringContaining("Automatic removal is disabled"),
        path: staleDir,
        severity: "warning",
      }),
    ]);
    expect(await check.repair!(context(cfg), findings)).toMatchObject({
      status: "skipped",
      changes: [],
      warnings: [expect.stringContaining("Automatic removal is disabled")],
    });
    await expect(fs.stat(preserved)).resolves.toBeDefined();
  },
);
