import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createChatRunRegistry } from "./server-chat-state.js";
import {
  deleteDrainManifest,
  readDrainManifest,
  writeDrainManifest,
} from "./server-drain-manifest.js";

const ORIGINAL_ENV = { ...process.env };

describe("server-drain-manifest", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-drain-test-"));
    process.env.OPENCLAW_STATE_DIR = tmpDir;
    // Ensure state subdirectory tests work with the override
    process.env.OPENCLAW_TEST_FAST = "1";
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  describe("writeDrainManifest", () => {
    it("skips write when registry is empty", () => {
      const registry = createChatRunRegistry();
      writeDrainManifest(registry);
      const manifest = readDrainManifest();
      expect(manifest).toBeNull();
    });

    it("writes manifest with active runs and session keys", () => {
      const registry = createChatRunRegistry();
      registry.add("run-1", { sessionKey: "linear-AI-587-charles", clientRunId: "run-1" });
      registry.add("run-1", { sessionKey: "linear-ai-588-charles", clientRunId: "run-2" });
      registry.add("run-3", { sessionKey: "agent:noah", clientRunId: "run-3" });

      expect(writeDrainManifest(registry)).toBe(3);

      const manifest = readDrainManifest();
      expect(manifest).not.toBeNull();
      expect(manifest!.version).toBe(1);
      expect(manifest!.sessions).toHaveLength(3);
      expect(manifest!.writtenAt).toBeTruthy();

      const sessionKeys = manifest!.sessions.map((s) => s.sessionKey);
      expect(sessionKeys).toContain("linear-AI-587-charles");
      expect(sessionKeys).toContain("agent:noah");

      const runIds = manifest!.sessions.map((s) => s.runId);
      expect(runIds.filter((id) => id === "run-1")).toHaveLength(2);
      expect(runIds.filter((id) => id === "run-3")).toHaveLength(1);
      expect(manifest!.sessions.every((s) => !("linearTicketId" in s))).toBe(true);
    });

    it("creates state directory if it does not exist", () => {
      const registry = createChatRunRegistry();
      registry.add("s1", { sessionKey: "test", clientRunId: "r1" });

      // State dir subdirectory should be created
      writeDrainManifest(registry);
      const manifest = readDrainManifest();
      expect(manifest).not.toBeNull();
    });

    it("writes manifest with owner-only permissions", () => {
      const registry = createChatRunRegistry();
      registry.add("r1", { sessionKey: "test", clientRunId: "r1" });

      writeDrainManifest(registry);

      const manifestPath = path.join(tmpDir, "state", "draining-sessions.json");
      expect(fs.statSync(manifestPath).mode & 0o777).toBe(0o600);
    });

    it("propagates manifest write failures", () => {
      const registry = createChatRunRegistry();
      registry.add("s1", { sessionKey: "linear-AI-587", clientRunId: "r1" });
      fs.writeFileSync(path.join(tmpDir, "state"), "not a directory");

      expect(() => writeDrainManifest(registry)).toThrow();
    });
  });

  describe("deleteDrainManifest", () => {
    it("deletes existing manifest", () => {
      const registry = createChatRunRegistry();
      registry.add("s1", { sessionKey: "test", clientRunId: "r1" });
      writeDrainManifest(registry);
      expect(readDrainManifest()).not.toBeNull();

      deleteDrainManifest();
      expect(readDrainManifest()).toBeNull();
    });

    it("is a no-op when no manifest exists", () => {
      expect(() => deleteDrainManifest()).not.toThrow();
    });
  });

  describe("readDrainManifest", () => {
    it("returns null when no manifest exists", () => {
      expect(readDrainManifest()).toBeNull();
    });

    it("returns null for invalid JSON", () => {
      const manifestPath = path.join(tmpDir, "state", "draining-sessions.json");
      fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
      fs.writeFileSync(manifestPath, "not json", "utf-8");
      expect(readDrainManifest()).toBeNull();
    });

    it("returns null for wrong version", () => {
      const manifestPath = path.join(tmpDir, "state", "draining-sessions.json");
      fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
      fs.writeFileSync(manifestPath, JSON.stringify({ version: 2, sessions: [] }), "utf-8");
      expect(readDrainManifest()).toBeNull();
    });
  });

  describe("ChatRunRegistry.entries()", () => {
    it("returns empty array for empty registry", () => {
      const registry = createChatRunRegistry();
      expect(registry.entries()).toEqual([]);
    });

    it("returns active entries", () => {
      const registry = createChatRunRegistry();
      registry.add("s1", { sessionKey: "k1", clientRunId: "r1" });
      registry.add("s1", { sessionKey: "k2", clientRunId: "r2" });
      registry.add("s2", { sessionKey: "k3", clientRunId: "r3" });

      const entries = registry.entries();
      expect(entries).toHaveLength(2); // two active run IDs

      const s1 = entries.find((e) => e.runId === "s1");
      expect(s1?.runs).toHaveLength(2);

      const s2 = entries.find((e) => e.runId === "s2");
      expect(s2?.runs).toHaveLength(1);
    });

    it("excludes sessions with empty queues", () => {
      const registry = createChatRunRegistry();
      registry.add("s1", { sessionKey: "k1", clientRunId: "r1" });
      registry.shift("s1"); // drain the queue

      expect(registry.entries()).toEqual([]);
    });
  });
});
