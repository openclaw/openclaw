import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { generateExistenceSnapshot, updateExistenceSection } from "./existence-updater.js";
import { ExperientialStore } from "./store.js";

describe("existence-updater", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "existence-updater-test-"));
  });

  describe("updateExistenceSection", () => {
    it("creates file with section when file does not exist", async () => {
      const filePath = path.join(tmpDir, "EXISTENCE.md");

      await updateExistenceSection({
        filePath,
        sectionName: "Current State",
        content: "Active and learning.",
      });

      const result = await fs.readFile(filePath, "utf-8");
      expect(result).toContain("## Current State");
      expect(result).toContain("Active and learning.");
    });

    it("appends section to existing file", async () => {
      const filePath = path.join(tmpDir, "EXISTENCE.md");
      await fs.writeFile(filePath, "# Existence\n\nSome intro.\n", "utf-8");

      await updateExistenceSection({
        filePath,
        sectionName: "Recent Activity",
        content: "Worked on API design.",
      });

      const result = await fs.readFile(filePath, "utf-8");
      expect(result).toContain("# Existence");
      expect(result).toContain("Some intro.");
      expect(result).toContain("## Recent Activity");
      expect(result).toContain("Worked on API design.");
    });

    it("replaces existing section", async () => {
      const filePath = path.join(tmpDir, "EXISTENCE.md");
      await fs.writeFile(
        filePath,
        "# Existence\n\n## Status\n\nOld status.\n\n## Other\n\nOther content.\n",
        "utf-8",
      );

      await updateExistenceSection({
        filePath,
        sectionName: "Status",
        content: "New status.",
      });

      const result = await fs.readFile(filePath, "utf-8");
      expect(result).toContain("New status.");
      expect(result).not.toContain("Old status.");
      // Other section preserved
      expect(result).toContain("## Other");
      expect(result).toContain("Other content.");
    });

    it("replaces last section without losing trailing content", async () => {
      const filePath = path.join(tmpDir, "EXISTENCE.md");
      await fs.writeFile(filePath, "# Existence\n\n## LastSection\n\nOld last.\n", "utf-8");

      await updateExistenceSection({
        filePath,
        sectionName: "LastSection",
        content: "Updated last.",
      });

      const result = await fs.readFile(filePath, "utf-8");
      expect(result).toContain("Updated last.");
      expect(result).not.toContain("Old last.");
    });
  });

  describe("generateExistenceSnapshot", () => {
    it("returns empty state for empty store", async () => {
      const dbPath = path.join(tmpDir, "test.db");
      const store = new ExperientialStore(dbPath);
      try {
        const result = await generateExistenceSnapshot(store);
        expect(result).toContain("No experiential data recorded yet");
      } finally {
        store.close();
      }
    });

    it("includes session topics from store", async () => {
      const dbPath = path.join(tmpDir, "test.db");
      const store = new ExperientialStore(dbPath);
      try {
        store.saveSessionSummary({
          id: "s1",
          version: 1,
          sessionKey: "agent:main:main",
          startedAt: Date.now() - 3600000,
          endedAt: Date.now(),
          topics: ["testing", "deployment"],
          momentCount: 2,
          keyAnchors: [],
          openUncertainties: [],
          reconstitutionHints: [],
        });

        const result = await generateExistenceSnapshot(store);
        expect(result).toContain("Recent Session Topics");
        expect(result).toContain("testing, deployment");
      } finally {
        store.close();
      }
    });

    it("includes checkpoint data from store", async () => {
      const dbPath = path.join(tmpDir, "test.db");
      const store = new ExperientialStore(dbPath);
      try {
        store.saveCheckpoint({
          id: "cp1",
          version: 1,
          timestamp: Date.now(),
          sessionKey: "agent:main:main",
          trigger: "auto",
          activeTopics: ["caching strategy"],
          keyContextSummary: "discussed caching",
          openUncertainties: [],
          conversationAnchors: ["use Redis"],
        });

        const result = await generateExistenceSnapshot(store);
        expect(result).toContain("Last Context Checkpoint");
        expect(result).toContain("caching strategy");
        expect(result).toContain("use Redis");
      } finally {
        store.close();
      }
    });
  });
});
