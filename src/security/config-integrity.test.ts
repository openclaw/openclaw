import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  loadConfigIntegrityStore,
  saveConfigIntegrityStore,
  type ConfigIntegrityStore,
} from "./config-integrity-store.js";
import {
  computeFileIntegrityHash,
  updateFileIntegrityHash,
  verifyAllIntegrity,
  verifyConfigIntegrityOnStartup,
  verifyFileIntegrity,
} from "./config-integrity.js";

describe("security/config-integrity", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-integrity-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("computeFileIntegrityHash", () => {
    it("computes SHA-256 hash for known content", () => {
      const filePath = path.join(tmpDir, "test.txt");
      fs.writeFileSync(filePath, "hello world");

      const hash = computeFileIntegrityHash(filePath);
      expect(hash).toMatch(/^sha256:[a-f0-9]{64}$/);
      // Known SHA-256 of "hello world"
      expect(hash).toBe("sha256:b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9");
    });

    it("returns different hashes for different content", () => {
      const file1 = path.join(tmpDir, "a.txt");
      const file2 = path.join(tmpDir, "b.txt");
      fs.writeFileSync(file1, "content A");
      fs.writeFileSync(file2, "content B");

      expect(computeFileIntegrityHash(file1)).not.toBe(computeFileIntegrityHash(file2));
    });

    it("detects whitespace changes", () => {
      const file1 = path.join(tmpDir, "ws1.txt");
      const file2 = path.join(tmpDir, "ws2.txt");
      fs.writeFileSync(file1, '{"key": "value"}');
      fs.writeFileSync(file2, '{"key":"value"}');

      expect(computeFileIntegrityHash(file1)).not.toBe(computeFileIntegrityHash(file2));
    });
  });

  describe("verifyFileIntegrity", () => {
    it("returns ok when file matches stored hash", () => {
      const filePath = path.join(tmpDir, "config.json");
      fs.writeFileSync(filePath, '{"test": true}');
      const hash = computeFileIntegrityHash(filePath);

      const result = verifyFileIntegrity(filePath, hash);
      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.hash).toBe(hash);
      }
    });

    it("returns tampered when file has been modified", () => {
      const filePath = path.join(tmpDir, "config.json");
      fs.writeFileSync(filePath, '{"test": true}');
      const hash = computeFileIntegrityHash(filePath);

      fs.writeFileSync(filePath, '{"test": false}');
      const result = verifyFileIntegrity(filePath, hash);
      expect(result.status).toBe("tampered");
      if (result.status === "tampered") {
        expect(result.expectedHash).toBe(hash);
        expect(result.actualHash).not.toBe(hash);
      }
    });

    it("returns file-not-found when file is deleted", () => {
      const filePath = path.join(tmpDir, "missing.json");
      const result = verifyFileIntegrity(filePath, "sha256:abc");
      expect(result.status).toBe("file-not-found");
    });
  });

  describe("verifyAllIntegrity", () => {
    it("verifies all files in the store", () => {
      const configPath = path.join(tmpDir, "openclaw.json");
      fs.writeFileSync(configPath, '{"gateway": {}}');
      const hash = computeFileIntegrityHash(configPath);

      const store: ConfigIntegrityStore = {
        version: 1,
        entries: {
          "openclaw.json": {
            hash,
            updatedAt: Date.now(),
            updatedBy: "cli",
            fileSize: fs.statSync(configPath).size,
          },
        },
        auditLog: [],
      };

      const results = verifyAllIntegrity(store, tmpDir);
      expect(results.get("openclaw.json")?.status).toBe("ok");
    });

    it("detects missing-baseline for tracked files without entries", () => {
      const configPath = path.join(tmpDir, "openclaw.json");
      fs.writeFileSync(configPath, '{"gateway": {}}');

      const store: ConfigIntegrityStore = { version: 1, entries: {}, auditLog: [] };
      const results = verifyAllIntegrity(store, tmpDir);
      expect(results.get("openclaw.json")?.status).toBe("missing-baseline");
    });
  });

  describe("updateFileIntegrityHash", () => {
    it("creates entry for a new file", () => {
      const configPath = path.join(tmpDir, "openclaw.json");
      fs.writeFileSync(configPath, '{"test": true}');

      const store: ConfigIntegrityStore = { version: 1, entries: {}, auditLog: [] };
      const updated = updateFileIntegrityHash(store, "openclaw.json", "cli", tmpDir);

      expect(updated.entries["openclaw.json"]).toBeDefined();
      expect(updated.entries["openclaw.json"]?.hash).toMatch(/^sha256:/);
      expect(updated.entries["openclaw.json"]?.updatedBy).toBe("cli");
      expect(updated.auditLog).toHaveLength(1);
      expect(updated.auditLog[0]?.action).toBe("created");
    });

    it("updates entry for an existing file", () => {
      const configPath = path.join(tmpDir, "openclaw.json");
      fs.writeFileSync(configPath, '{"v": 1}');

      let store: ConfigIntegrityStore = { version: 1, entries: {}, auditLog: [] };
      store = updateFileIntegrityHash(store, "openclaw.json", "cli", tmpDir);

      fs.writeFileSync(configPath, '{"v": 2}');
      store = updateFileIntegrityHash(store, "openclaw.json", "gateway", tmpDir);

      expect(store.entries["openclaw.json"]?.updatedBy).toBe("gateway");
      expect(store.auditLog).toHaveLength(2);
      expect(store.auditLog[1]?.action).toBe("updated");
    });

    it("after update, verify succeeds", () => {
      const configPath = path.join(tmpDir, "openclaw.json");
      fs.writeFileSync(configPath, '{"test": true}');

      let store: ConfigIntegrityStore = { version: 1, entries: {}, auditLog: [] };
      store = updateFileIntegrityHash(store, "openclaw.json", "cli", tmpDir);

      const result = verifyFileIntegrity(configPath, store.entries["openclaw.json"].hash);
      expect(result.status).toBe("ok");
    });

    it("skips non-existent files without error", () => {
      const store: ConfigIntegrityStore = { version: 1, entries: {}, auditLog: [] };
      const updated = updateFileIntegrityHash(store, "missing.json", "cli", tmpDir);
      expect(updated.entries["missing.json"]).toBeUndefined();
    });
  });

  describe("verifyConfigIntegrityOnStartup", () => {
    it("creates initial baselines for existing files", () => {
      const configPath = path.join(tmpDir, "openclaw.json");
      fs.writeFileSync(configPath, '{"gateway": {}}');

      const missingBaselineCalls: string[] = [];
      const result = verifyConfigIntegrityOnStartup({
        config: {},
        stateDir: tmpDir,
        onMissingBaseline: (file) => missingBaselineCalls.push(file),
      });

      expect(result.allOk).toBe(true);
      expect(missingBaselineCalls).toContain("openclaw.json");

      // Store should be persisted
      const store = loadConfigIntegrityStore(tmpDir);
      expect(store.entries["openclaw.json"]).toBeDefined();
    });

    it("reports tampered files", () => {
      const configPath = path.join(tmpDir, "openclaw.json");
      fs.writeFileSync(configPath, '{"original": true}');

      // Create baseline
      let store: ConfigIntegrityStore = { version: 1, entries: {}, auditLog: [] };
      store = updateFileIntegrityHash(store, "openclaw.json", "cli", tmpDir);
      saveConfigIntegrityStore(store, tmpDir);

      // Tamper with file
      fs.writeFileSync(configPath, '{"tampered": true}');

      const tamperCalls: string[] = [];
      const result = verifyConfigIntegrityOnStartup({
        config: {},
        stateDir: tmpDir,
        onTampered: (file) => tamperCalls.push(file),
      });

      expect(result.allOk).toBe(false);
      expect(tamperCalls).toContain("openclaw.json");
    });

    it("blocks startup when blockOnTampering is true", () => {
      const configPath = path.join(tmpDir, "openclaw.json");
      fs.writeFileSync(configPath, '{"original": true}');

      let store: ConfigIntegrityStore = { version: 1, entries: {}, auditLog: [] };
      store = updateFileIntegrityHash(store, "openclaw.json", "cli", tmpDir);
      saveConfigIntegrityStore(store, tmpDir);

      fs.writeFileSync(configPath, '{"tampered": true}');

      expect(() =>
        verifyConfigIntegrityOnStartup({
          config: { security: { configIntegrity: { blockOnTampering: true } } },
          stateDir: tmpDir,
          onTampered: (_file, _result) => {
            throw new Error(
              "Config integrity violation detected in openclaw.json. Gateway startup blocked.",
            );
          },
        }),
      ).toThrow("Config integrity violation");
    });

    it("passes when all files match", () => {
      const configPath = path.join(tmpDir, "openclaw.json");
      fs.writeFileSync(configPath, '{"ok": true}');

      let store: ConfigIntegrityStore = { version: 1, entries: {}, auditLog: [] };
      store = updateFileIntegrityHash(store, "openclaw.json", "cli", tmpDir);
      saveConfigIntegrityStore(store, tmpDir);

      const result = verifyConfigIntegrityOnStartup({
        config: {},
        stateDir: tmpDir,
      });

      expect(result.allOk).toBe(true);
    });

    it("tracks additional files from config", () => {
      const configPath = path.join(tmpDir, "openclaw.json");
      fs.writeFileSync(configPath, "{}");
      const extraDir = path.join(tmpDir, "credentials");
      fs.mkdirSync(extraDir, { recursive: true });
      const extraFile = path.join(extraDir, "discord-allowFrom.json");
      fs.writeFileSync(extraFile, '["user1"]');

      const result = verifyConfigIntegrityOnStartup({
        config: {
          security: {
            configIntegrity: {
              trackedFiles: ["credentials/discord-allowFrom.json"],
            },
          },
        },
        stateDir: tmpDir,
      });

      expect(result.allOk).toBe(true);
      const store = loadConfigIntegrityStore(tmpDir);
      expect(store.entries["credentials/discord-allowFrom.json"]).toBeDefined();
    });
  });
});
