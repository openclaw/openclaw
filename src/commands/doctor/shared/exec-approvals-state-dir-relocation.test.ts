// Tests for the doctor migration that relocates a legacy home-relative exec-approvals
// policy into the resolved state dir when OPENCLAW_STATE_DIR points elsewhere.
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureExecApprovals, type ExecApprovalsFile } from "../../../infra/exec-approvals.js";
import { captureEnv } from "../../../test-utils/env.js";
import { relocateLegacyExecApprovalsStateFile } from "./exec-approvals-state-dir-relocation.js";

const FILENAME = "exec-approvals.json";
const SOCKET_FILENAME = "exec-approvals.sock";

describe("exec-approvals state-dir relocation doctor migration", () => {
  const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR", "OPENCLAW_HOME"]);
  let tempRoot = "";
  let homeDir = "";
  let stateDir = "";
  let legacyPath = "";
  let canonicalPath = "";

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-exec-approvals-relocate-"));
    homeDir = path.join(tempRoot, "home");
    stateDir = path.join(tempRoot, "state");
    legacyPath = path.join(homeDir, ".openclaw", FILENAME);
    canonicalPath = path.join(stateDir, FILENAME);
    process.env.OPENCLAW_HOME = homeDir;
    process.env.OPENCLAW_STATE_DIR = stateDir;
  });

  afterEach(async () => {
    envSnapshot.restore();
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  async function writeLegacyPolicy(security: string): Promise<void> {
    await fs.mkdir(path.dirname(legacyPath), { recursive: true });
    await fs.writeFile(
      legacyPath,
      `${JSON.stringify({ version: 1, defaults: { security }, agents: {} }, null, 2)}\n`,
      { mode: 0o600 },
    );
  }

  // Produce the legacy file the shipped runtime actually wrote: ensureExecApprovals with no
  // OPENCLAW_STATE_DIR persists the policy plus the generated home-relative socket path/token
  // at <home>/.openclaw, exercising the real persistence path rather than a hand-built fixture.
  function writeLegacyPolicyViaRuntime(): ExecApprovalsFile {
    const relocated = process.env.OPENCLAW_STATE_DIR;
    delete process.env.OPENCLAW_STATE_DIR;
    try {
      return ensureExecApprovals();
    } finally {
      if (relocated === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = relocated;
      }
    }
  }

  async function readCanonicalPolicy(): Promise<ExecApprovalsFile> {
    return JSON.parse(await fs.readFile(canonicalPath, "utf8")) as ExecApprovalsFile;
  }

  it("moves a legacy home policy into the relocated state dir", async () => {
    await writeLegacyPolicy("deny");

    const result = await relocateLegacyExecApprovalsStateFile({ env: process.env });

    expect(result.warnings).toEqual([]);
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]).toContain("Moved exec-approvals policy");
    await expect(fs.readFile(canonicalPath, "utf8")).resolves.toContain('"security": "deny"');
    await expect(fs.access(legacyPath)).rejects.toThrow();
  });

  // The migration writes a temp file inside the canonical dir then renames within it, so a
  // legacy file on one device and a state dir on another must not hit EXDEV. Every other test
  // shares a single tmpdir (same device); this forces a genuine cross-mount move using a tmpfs
  // state dir (Linux /dev/shm), and skips where no second device is available (macOS/Windows).
  it.skipIf(!fsSync.existsSync("/dev/shm"))(
    "relocates across a device boundary when the state dir is on another mount (EXDEV-safe)",
    async (ctx) => {
      const tmpfsState = await fs.mkdtemp("/dev/shm/openclaw-exec-approvals-xdev-");
      try {
        const diskDev = fsSync.statSync(tempRoot).dev;
        const tmpfsDev = fsSync.statSync(tmpfsState).dev;
        if (diskDev === tmpfsDev) {
          // os.tmpdir() is itself on tmpfs here, so there is no cross-device boundary to exercise.
          ctx.skip();
          return;
        }
        process.env.OPENCLAW_STATE_DIR = tmpfsState;
        const tmpfsCanonical = path.join(tmpfsState, FILENAME);
        await writeLegacyPolicy("deny");

        const result = await relocateLegacyExecApprovalsStateFile({ env: process.env });

        expect(result.warnings).toEqual([]);
        expect(result.changes).toHaveLength(1);
        expect(result.changes[0]).toContain("Moved exec-approvals policy");
        await expect(fs.readFile(tmpfsCanonical, "utf8")).resolves.toContain('"security": "deny"');
        await expect(fs.access(legacyPath)).rejects.toThrow();
      } finally {
        await fs.rm(tmpfsState, { recursive: true, force: true });
      }
    },
  );

  it("is a no-op for default installs where state dir equals the home location", async () => {
    delete process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_HOME = homeDir;
    await writeLegacyPolicy("deny");

    const result = await relocateLegacyExecApprovalsStateFile({ env: process.env });

    expect(result).toEqual({ changes: [], warnings: [] });
    // Default-install file stays exactly where it was; nothing moved or removed.
    await expect(fs.readFile(legacyPath, "utf8")).resolves.toContain('"security": "deny"');
  });

  it("does nothing when no legacy policy exists", async () => {
    const result = await relocateLegacyExecApprovalsStateFile({ env: process.env });

    expect(result).toEqual({ changes: [], warnings: [] });
    await expect(fs.access(canonicalPath)).rejects.toThrow();
  });

  it("refuses to clobber an existing canonical policy and warns about the legacy file", async () => {
    await writeLegacyPolicy("deny");
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(
      canonicalPath,
      `${JSON.stringify({ version: 1, defaults: { security: "allowlist" }, agents: {} }, null, 2)}\n`,
      { mode: 0o600 },
    );

    const result = await relocateLegacyExecApprovalsStateFile({ env: process.env });

    expect(result.changes).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("Both");
    // Canonical policy is preserved untouched; legacy file is left for manual reconciliation.
    await expect(fs.readFile(canonicalPath, "utf8")).resolves.toContain('"security": "allowlist"');
    await expect(fs.readFile(legacyPath, "utf8")).resolves.toContain('"security": "deny"');
  });

  it("rewrites the generated home socket path to the relocated state dir and keeps the token", async () => {
    const legacy = writeLegacyPolicyViaRuntime();
    // Sanity: the shipped persistence wrote the generated home-relative socket and a token.
    expect(legacy.socket?.path).toBe(path.join(homeDir, ".openclaw", SOCKET_FILENAME));
    const token = legacy.socket?.token;
    expect(token).toBeTruthy();

    const result = await relocateLegacyExecApprovalsStateFile({ env: process.env });

    expect(result.warnings).toEqual([]);
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]).toContain("rewrote the generated socket path");
    const moved = await readCanonicalPolicy();
    expect(moved.socket?.path).toBe(path.join(stateDir, SOCKET_FILENAME));
    expect(moved.socket?.token).toBe(token);
    await expect(fs.access(legacyPath)).rejects.toThrow();
  });

  it("preserves an operator-chosen custom socket path during relocation", async () => {
    const customSocket = path.join(tempRoot, "custom", "approvals.sock");
    await fs.mkdir(path.dirname(legacyPath), { recursive: true });
    await fs.writeFile(
      legacyPath,
      `${JSON.stringify(
        {
          version: 1,
          socket: { path: customSocket, token: "operator-token" },
          defaults: { security: "deny" },
          agents: {},
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );

    const result = await relocateLegacyExecApprovalsStateFile({ env: process.env });

    expect(result.warnings).toEqual([]);
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]).not.toContain("rewrote the generated socket path");
    const moved = await readCanonicalPolicy();
    expect(moved.socket?.path).toBe(customSocket);
    expect(moved.socket?.token).toBe("operator-token");
    expect(moved.defaults?.security).toBe("deny");
  });

  it("refuses to relocate into a symlinked state dir and keeps the legacy policy", async () => {
    // A symlinked OPENCLAW_STATE_DIR is unsafe: runtime exec approvals refuse symlinked
    // parents, so relocating there and deleting the legacy file would strand the policy.
    const realState = path.join(tempRoot, "real-state");
    await fs.mkdir(realState, { recursive: true });
    const symlinkedState = path.join(tempRoot, "linked-state");
    await fs.symlink(realState, symlinkedState);
    process.env.OPENCLAW_STATE_DIR = symlinkedState;
    await writeLegacyPolicy("deny");

    const result = await relocateLegacyExecApprovalsStateFile({ env: process.env });

    expect(result.changes).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("symlink");
    // Legacy policy is preserved because the destination was rejected before any write.
    await expect(fs.readFile(legacyPath, "utf8")).resolves.toContain('"security": "deny"');
    await expect(fs.access(path.join(realState, FILENAME))).rejects.toThrow();
  });

  it("warns instead of following a symlinked legacy policy", async () => {
    const outside = path.join(tempRoot, "outside-policy.json");
    await fs.writeFile(outside, `${JSON.stringify({ version: 1, agents: {} })}\n`, { mode: 0o600 });
    await fs.mkdir(path.dirname(legacyPath), { recursive: true });
    await fs.symlink(outside, legacyPath);

    const result = await relocateLegacyExecApprovalsStateFile({ env: process.env });

    expect(result.changes).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("not a regular file");
    await expect(fs.access(canonicalPath)).rejects.toThrow();
  });
});
