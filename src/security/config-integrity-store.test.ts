import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addAuditEntry,
  loadConfigIntegrityStore,
  saveConfigIntegrityStore,
  type ConfigIntegrityStore,
} from "./config-integrity-store.js";

describe("security/config-integrity-store", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-integrity-store-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns empty store when file does not exist", () => {
    const store = loadConfigIntegrityStore(tmpDir);
    expect(store.version).toBe(1);
    expect(store.entries).toEqual({});
    expect(store.auditLog).toEqual([]);
  });

  it("load/save roundtrip persists correctly", () => {
    const store: ConfigIntegrityStore = {
      version: 1,
      entries: {
        "openclaw.json": {
          hash: "sha256:abc123",
          updatedAt: 1700000000000,
          updatedBy: "cli",
          fileSize: 512,
        },
      },
      auditLog: [
        {
          ts: 1700000000000,
          file: "openclaw.json",
          action: "created",
          hash: "sha256:abc123",
          actor: "cli",
        },
      ],
    };

    saveConfigIntegrityStore(store, tmpDir);
    const loaded = loadConfigIntegrityStore(tmpDir);

    expect(loaded.version).toBe(1);
    expect(loaded.entries["openclaw.json"]?.hash).toBe("sha256:abc123");
    expect(loaded.entries["openclaw.json"]?.updatedBy).toBe("cli");
    expect(loaded.auditLog).toHaveLength(1);
    expect(loaded.auditLog[0]?.action).toBe("created");
  });

  it("store file is created with mode 0o600", () => {
    if (process.platform === "win32") {
      return;
    }
    const store: ConfigIntegrityStore = { version: 1, entries: {}, auditLog: [] };
    saveConfigIntegrityStore(store, tmpDir);

    const storePath = path.join(tmpDir, "identity", "config-integrity.json");
    const stat = fs.statSync(storePath);
    const mode = stat.mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("adds audit entries with timestamp", () => {
    const store: ConfigIntegrityStore = { version: 1, entries: {}, auditLog: [] };
    const before = Date.now();

    const updated = addAuditEntry(store, {
      file: "openclaw.json",
      action: "created",
      hash: "sha256:abc",
      actor: "cli",
    });

    expect(updated.auditLog).toHaveLength(1);
    expect(updated.auditLog[0]?.ts).toBeGreaterThanOrEqual(before);
    expect(updated.auditLog[0]?.ts).toBeLessThanOrEqual(Date.now());
    expect(updated.auditLog[0]?.file).toBe("openclaw.json");
    expect(updated.auditLog[0]?.actor).toBe("cli");
  });

  it("caps audit log at 1000 entries (FIFO)", () => {
    let store: ConfigIntegrityStore = { version: 1, entries: {}, auditLog: [] };

    for (let i = 0; i < 1005; i++) {
      store = addAuditEntry(store, {
        file: `file-${i}`,
        action: "updated",
        hash: `sha256:hash-${i}`,
        actor: "cli",
      });
    }

    expect(store.auditLog).toHaveLength(1000);
    // Oldest entries should be dropped (FIFO): first entry should be file-5
    expect(store.auditLog[0]?.file).toBe("file-5");
    expect(store.auditLog[999]?.file).toBe("file-1004");
  });

  it("returns empty store for corrupted JSON", () => {
    const identityDir = path.join(tmpDir, "identity");
    fs.mkdirSync(identityDir, { recursive: true });
    fs.writeFileSync(path.join(identityDir, "config-integrity.json"), "not json");

    const store = loadConfigIntegrityStore(tmpDir);
    expect(store.version).toBe(1);
    expect(store.entries).toEqual({});
    expect(store.auditLog).toEqual([]);
  });

  it("returns empty store for invalid schema", () => {
    const identityDir = path.join(tmpDir, "identity");
    fs.mkdirSync(identityDir, { recursive: true });
    fs.writeFileSync(
      path.join(identityDir, "config-integrity.json"),
      JSON.stringify({ version: 99, wrong: true }),
    );

    const store = loadConfigIntegrityStore(tmpDir);
    expect(store.version).toBe(1);
    expect(store.entries).toEqual({});
  });
});
