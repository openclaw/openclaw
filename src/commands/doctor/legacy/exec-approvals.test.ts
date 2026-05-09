import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadExecApprovals,
  resolveExecApprovalsPath,
  type ExecApprovalsFile,
} from "../../../infra/exec-approvals.js";
import { resetPluginStateStoreForTests } from "../../../plugin-state/plugin-state-store.js";
import {
  importLegacyExecApprovalsFileToSqlite,
  legacyExecApprovalsFileExists,
} from "./exec-approvals.js";

const tempDirs: string[] = [];
const originalOpenClawHome = process.env.OPENCLAW_HOME;
const originalStateDir = process.env.OPENCLAW_STATE_DIR;

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
  resetPluginStateStoreForTests();
  if (originalOpenClawHome === undefined) {
    delete process.env.OPENCLAW_HOME;
  } else {
    process.env.OPENCLAW_HOME = originalOpenClawHome;
  }
  if (originalStateDir === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = originalStateDir;
  }
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function createHomeDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-exec-approvals-"));
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-exec-state-"));
  tempDirs.push(dir, stateDir);
  process.env.OPENCLAW_HOME = dir;
  process.env.OPENCLAW_STATE_DIR = stateDir;
  return dir;
}

function writeApprovalsFile(homeDir: string, file: ExecApprovalsFile): string {
  const approvalsPath = resolveExecApprovalsPath({
    ...process.env,
    OPENCLAW_HOME: homeDir,
  });
  fs.mkdirSync(path.dirname(approvalsPath), { recursive: true });
  fs.writeFileSync(approvalsPath, `${JSON.stringify(file)}\n`, "utf8");
  return approvalsPath;
}

describe("legacy exec approvals migration", () => {
  it("imports legacy approvals files into SQLite and removes the source", () => {
    const dir = createHomeDir();
    const approvalsPath = writeApprovalsFile(dir, {
      version: 1,
      defaults: { security: "deny" },
      agents: {},
    });

    expect(legacyExecApprovalsFileExists()).toBe(true);
    expect(importLegacyExecApprovalsFileToSqlite()).toEqual({ imported: true });

    expect(loadExecApprovals().defaults?.security).toBe("deny");
    expect(fs.existsSync(approvalsPath)).toBe(false);
  });

  it("skips when the legacy approvals file is missing", () => {
    createHomeDir();

    expect(legacyExecApprovalsFileExists()).toBe(false);
    expect(importLegacyExecApprovalsFileToSqlite()).toEqual({ imported: false });
  });
});
