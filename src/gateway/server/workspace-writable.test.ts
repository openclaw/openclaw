// Workspace writability checker tests for readiness (ENOSPC / disk-full).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createWorkspaceWritableChecker } from "./workspace-writable.js";

describe("createWorkspaceWritableChecker", () => {
  let probeDir: string;

  beforeEach(() => {
    probeDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-readyz-workspace-"));
  });

  afterEach(() => {
    fs.rmSync(probeDir, { recursive: true, force: true });
  });

  it("reports writable when the workspace directory is writable", () => {
    const checker = createWorkspaceWritableChecker(probeDir);
    const result = checker();
    expect(result.writable).toBe(true);
    expect("failing" in result ? result.failing : undefined).toBeUndefined();
  });

  it("leaves no probe file after a successful check", () => {
    const checker = createWorkspaceWritableChecker(probeDir);
    checker();
    const entries = fs.readdirSync(probeDir);
    expect(entries).not.toContain(".openclaw-readyz-probe");
  });

  it("returns writable when workspaceDir is an empty string", () => {
    const checker = createWorkspaceWritableChecker("");
    expect(checker()).toEqual({ writable: true });
  });

  it("caches the result within the configured TTL", () => {
    const checker = createWorkspaceWritableChecker(probeDir, { cacheTtlMs: 60_000 });
    const first = checker();
    const second = checker();
    expect(first.writable).toBe(true);
    // Second call is served from cache within the TTL.
    expect(second).toEqual(first);
  });
});
