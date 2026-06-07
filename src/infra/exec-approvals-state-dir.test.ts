import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  resolveExecApprovalsPath,
  resolveExecApprovalsSocketPath,
  saveExecApprovals,
} from "./exec-approvals.js";

// exec-approvals must store its file/socket in the OpenClaw state dir, honoring
// OPENCLAW_STATE_DIR like the rest of the runtime — not always under $HOME/.openclaw.
//
// Documented precedence (https://docs.openclaw.ai/help/environment): OPENCLAW_HOME replaces
// $HOME as the foundation for path *defaults* (so the state dir defaults to
// <OPENCLAW_HOME>/.openclaw), while an explicit OPENCLAW_STATE_DIR *takes precedence* over
// that default. resolveStateDir() implements exactly this; the tests below pin both directions.
describe("exec-approvals path honors OPENCLAW_STATE_DIR", () => {
  const created: string[] = [];
  const originalHome = process.env.OPENCLAW_HOME;
  const originalStateDir = process.env.OPENCLAW_STATE_DIR;

  afterEach(() => {
    if (originalHome === undefined) {
      delete process.env.OPENCLAW_HOME;
    } else {
      process.env.OPENCLAW_HOME = originalHome;
    }
    if (originalStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = originalStateDir;
    }
    for (const dir of created.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function mkTmp(): string {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "oc-exec-approvals-")));
    created.push(dir);
    return dir;
  }

  it("derives <OPENCLAW_HOME>/.openclaw when no explicit OPENCLAW_STATE_DIR is set", () => {
    // OPENCLAW_HOME replaces $HOME for path defaults → state dir defaults to <home>/.openclaw.
    const home = mkTmp();
    process.env.OPENCLAW_HOME = home;
    delete process.env.OPENCLAW_STATE_DIR;

    expect(resolveExecApprovalsPath()).toBe(path.join(home, ".openclaw", "exec-approvals.json"));
    expect(resolveExecApprovalsSocketPath()).toBe(
      path.join(home, ".openclaw", "exec-approvals.sock"),
    );
  });

  it("lets explicit OPENCLAW_STATE_DIR take precedence over the OPENCLAW_HOME default", () => {
    // Both set to different dirs: the explicit OPENCLAW_STATE_DIR wins (per docs), not OPENCLAW_HOME.
    const home = mkTmp();
    const stateDir = mkTmp();
    process.env.OPENCLAW_HOME = home;
    process.env.OPENCLAW_STATE_DIR = stateDir;

    expect(resolveExecApprovalsPath()).toBe(path.join(stateDir, "exec-approvals.json"));
    expect(resolveExecApprovalsSocketPath()).toBe(path.join(stateDir, "exec-approvals.sock"));
    // ...and explicitly NOT the OPENCLAW_HOME-derived default, proving STATE_DIR precedence.
    expect(resolveExecApprovalsPath()).not.toBe(
      path.join(home, ".openclaw", "exec-approvals.json"),
    );
  });

  it("still refuses a relocated state dir whose final component is a symlink", () => {
    // OPENCLAW_STATE_DIR points at a symlinked `.openclaw` — the symlink guard must still
    // bite on the relocated path (Option B keeps the parent-component check; allowOutsideRoot
    // would otherwise skip it).
    const base = mkTmp();
    const realTarget = path.join(base, "real-state");
    fs.mkdirSync(realTarget, { recursive: true });
    const stateDir = path.join(base, ".openclaw");
    fs.symlinkSync(realTarget, stateDir, "dir");
    process.env.OPENCLAW_HOME = mkTmp();
    process.env.OPENCLAW_STATE_DIR = stateDir;

    expect(() =>
      saveExecApprovals({ version: 1, defaults: { security: "full" }, agents: {} }),
    ).toThrow(/Refusing to traverse symlink in exec approvals path/);
    expect(fs.existsSync(path.join(realTarget, "exec-approvals.json"))).toBe(false);
  });
});
