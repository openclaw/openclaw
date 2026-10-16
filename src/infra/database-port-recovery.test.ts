import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  archiveDatabasePortManifest,
  assertDatabasePortRecoveryAllowed,
  assertDatabasePortStartupAllowed,
  databasePortManifestPath,
  DatabasePortRecoveryError,
  type DatabasePortManifest,
  writeDatabasePortManifest,
} from "./database-port-recovery.js";
import { makeDatabasePortManifest } from "./database-port-recovery.test-support.js";

vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>();
  return { ...original, default: { ...original } };
});

let stateDir: string;
let manifest: DatabasePortManifest;
const custody = () => {};

function write(value = manifest) {
  writeDatabasePortManifest(stateDir, value, custody);
}

function publishing(): DatabasePortManifest {
  return {
    ...manifest,
    state: "publishing",
    revision: 2,
    targets: manifest.targets.map((target) => ({
      ...target,
      verification: {
        contentHash: "b".repeat(64),
        catalogHash: "c".repeat(64),
        allocationHash: "d".repeat(64),
        rowCount: 42,
        ownerAdmitted: true,
      },
    })),
  };
}

function intent() {
  return {
    manifestPath: databasePortManifestPath(stateDir),
    operationId: manifest.operationId,
    action: "resume" as const,
  };
}

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "database-port-recovery-"));
  manifest = makeDatabasePortManifest(stateDir);
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(stateDir, { recursive: true, force: true });
});

describe("database port startup exclusion", () => {
  it.skipIf(process.platform === "win32").each(["preparing", "publishing"] as const)(
    "refuses %s with both recovery commands",
    (state) => {
      write();
      if (state === "publishing") {
        write(publishing());
      }
      expect(() => assertDatabasePortStartupAllowed(stateDir)).toThrow(DatabasePortRecoveryError);
      expect(() => assertDatabasePortStartupAllowed(stateDir)).toThrow(
        `--resume '${databasePortManifestPath(stateDir)}'`,
      );
      expect(() => assertDatabasePortStartupAllowed(stateDir)).toThrow("--rollback");
    },
  );

  it
    .skipIf(process.platform === "win32")
    .each([
      "malformed",
      "unknown-version",
      "unknown-state",
      "incomplete-complete",
      "dsn-field",
    ] as const)("refuses %s in an otherwise valid contract", (kind) => {
    write();
    const change = {
      "unknown-version": { version: 500 },
      "unknown-state": { state: "future" },
      "incomplete-complete": { state: "complete", outcome: "ported" },
      "dsn-field": { dsn: "postgres://example.invalid/database" },
    };
    const raw = kind === "malformed" ? "{" : JSON.stringify({ ...manifest, ...change[kind] });
    fs.writeFileSync(databasePortManifestPath(stateDir), raw);
    expect(() => assertDatabasePortStartupAllowed(stateDir)).toThrow(DatabasePortRecoveryError);
  });

  it("refuses present but unreadable manifests", () => {
    vi.spyOn(fs, "readFileSync").mockImplementation(() => {
      throw Object.assign(new Error("denied"), { code: "EACCES" });
    });
    expect(() => assertDatabasePortStartupAllowed(stateDir)).toThrow(DatabasePortRecoveryError);
  });

  it.skipIf(process.platform === "win32")("refuses dangling manifest symlinks", () => {
    write();
    fs.unlinkSync(databasePortManifestPath(stateDir));
    fs.symlinkSync(path.join(stateDir, "missing"), databasePortManifestPath(stateDir));
    expect(() => assertDatabasePortStartupAllowed(stateDir)).toThrow(DatabasePortRecoveryError);
  });
});

// Private POSIX modes and directory fsync are required for manifest publication.
describe.skipIf(process.platform === "win32")("durable port manifest lifecycle", () => {
  it("writes private revisions, allows complete, then archives before clearing the guard", () => {
    write();
    const fixed = databasePortManifestPath(stateDir);
    if (process.platform !== "win32") {
      expect(fs.statSync(fixed).mode & 0o777).toBe(0o600);
      expect(fs.statSync(path.dirname(fixed)).mode & 0o777).toBe(0o700);
      expect(fs.statSync(path.dirname(path.dirname(fixed))).mode & 0o777).toBe(0o700);
    }
    write(publishing());
    const complete: DatabasePortManifest = {
      ...publishing(),
      revision: 3,
      state: "complete",
      outcome: "ported",
    };
    write(complete);
    expect(() => assertDatabasePortStartupAllowed(stateDir)).not.toThrow();
    expect(assertDatabasePortRecoveryAllowed(stateDir, intent())).toEqual(complete);
    expect(() =>
      assertDatabasePortRecoveryAllowed(stateDir, { ...intent(), action: "rollback" }),
    ).toThrow(DatabasePortRecoveryError);
    const archived = archiveDatabasePortManifest(stateDir, manifest.operationId, custody);
    expect(JSON.parse(fs.readFileSync(archived, "utf8"))).toEqual(complete);
    expect(fs.existsSync(fixed)).toBe(false);
    expect(() => assertDatabasePortStartupAllowed(stateDir)).not.toThrow();
  });

  it("refuses skipped states, altered targets, and unverified publication", () => {
    write();
    const before = fs.readFileSync(databasePortManifestPath(stateDir), "utf8");
    expect(() => write({ ...publishing(), state: "complete", outcome: "ported" })).toThrow();
    expect(() =>
      write({
        ...manifest,
        revision: 2,
        targets: manifest.targets.map((target) => ({
          ...target,
          intended: {
            engine: "postgres",
            anchorPath: path.join(stateDir, "other.sqlite"),
            namespace: "other_port",
          },
        })),
      }),
    ).toThrow();
    expect(() => write({ ...manifest, revision: 2, state: "publishing" })).toThrow();
    expect(fs.readFileSync(databasePortManifestPath(stateDir), "utf8")).toBe(before);
  });

  it("preserves the old revision if custody is lost immediately before rename", () => {
    write();
    const check = vi
      .fn()
      .mockImplementationOnce(custody)
      .mockImplementation(() => {
        throw new Error("custody lost");
      });
    expect(() => writeDatabasePortManifest(stateDir, publishing(), check)).toThrow("custody lost");
    expect(JSON.parse(fs.readFileSync(databasePortManifestPath(stateDir), "utf8"))).toEqual(
      manifest,
    );
    expect(fs.readdirSync(path.dirname(databasePortManifestPath(stateDir)))).toEqual([
      "manifest.json",
    ]);
  });

  it("preserves the old revision on rename failure", () => {
    write();
    vi.spyOn(fs, "renameSync").mockImplementation(() => {
      throw new Error("rename failed");
    });
    expect(() => write(publishing())).toThrow("rename failed");
    expect(JSON.parse(fs.readFileSync(databasePortManifestPath(stateDir), "utf8"))).toEqual(
      manifest,
    );
  });

  it("retains startup exclusion if directory sync fails after rename", () => {
    write();
    const sync = fs.fsyncSync;
    vi.spyOn(fs, "fsyncSync").mockImplementation((fd) => {
      if (fs.fstatSync(fd).isDirectory()) {
        throw new Error("directory sync failed");
      }
      sync(fd);
    });
    expect(() => write(publishing())).toThrow("directory sync failed");
    expect(JSON.parse(fs.readFileSync(databasePortManifestPath(stateDir), "utf8"))).toEqual(
      publishing(),
    );
    expect(() => assertDatabasePortStartupAllowed(stateDir)).toThrow(DatabasePortRecoveryError);
  });

  it("keeps the fixed manifest if archive publication fails", () => {
    write();
    write(publishing());
    write({ ...publishing(), revision: 3, state: "complete", outcome: "rolled-back" });
    vi.spyOn(fs, "renameSync").mockImplementation(() => {
      throw new Error("archive failed");
    });
    expect(() => archiveDatabasePortManifest(stateDir, manifest.operationId, custody)).toThrow(
      "archive failed",
    );
    expect(fs.existsSync(databasePortManifestPath(stateDir))).toBe(true);
  });
});

describe.skipIf(process.platform === "win32")("manifest-bound recovery admission", () => {
  it("admits only the fixed active manifest for the selected root and operation", () => {
    write();
    expect(assertDatabasePortRecoveryAllowed(stateDir, intent())).toEqual(manifest);
    expect(() =>
      assertDatabasePortRecoveryAllowed(stateDir, {
        ...intent(),
        manifestPath: path.join(stateDir, "other.json"),
      }),
    ).toThrow();
    expect(() =>
      assertDatabasePortRecoveryAllowed(stateDir, { ...intent(), operationId: "wrong" }),
    ).toThrow();
    const replaced = { ...manifest, root: { ...manifest.root, ino: "0" } };
    fs.writeFileSync(databasePortManifestPath(stateDir), JSON.stringify(replaced));
    expect(() => assertDatabasePortRecoveryAllowed(stateDir, intent())).toThrow(
      DatabasePortRecoveryError,
    );
  });

  it.skipIf(process.platform === "win32")("refuses nonprivate or aliased manifest paths", () => {
    write();
    const fixed = databasePortManifestPath(stateDir);
    fs.chmodSync(fixed, 0o644);
    expect(() => assertDatabasePortRecoveryAllowed(stateDir, intent())).toThrow("privately owned");
    fs.chmodSync(fixed, 0o600);
    fs.linkSync(fixed, path.join(stateDir, "alias"));
    expect(() => assertDatabasePortRecoveryAllowed(stateDir, intent())).toThrow("privately owned");
  });
});
