import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTempDir } from "../test-helpers/temp-dir.js";
import { repairNestedOpenClawHomeStateDir } from "./openclaw-home-state-migration.js";

describe("nested OPENCLAW_HOME state repair", () => {
  it("moves a nested state tree into an explicit .openclaw home", async () => {
    await withTempDir({ prefix: "openclaw-nested-home-" }, async (root) => {
      const stateDir = path.join(root, ".openclaw");
      const nestedDir = path.join(stateDir, ".openclaw");
      fs.mkdirSync(path.join(nestedDir, "agents", "main"), { recursive: true });
      fs.writeFileSync(path.join(nestedDir, "openclaw.json"), "{}\n", "utf8");
      fs.writeFileSync(path.join(nestedDir, "agents", "main", "sessions.json"), "{}\n", "utf8");

      const result = await repairNestedOpenClawHomeStateDir({
        env: { OPENCLAW_HOME: stateDir } as NodeJS.ProcessEnv,
        homedir: () => root,
      });

      expect(result.warnings).toEqual([]);
      expect(result.changes).toEqual([
        `Recovered 2 nested state entries: ${nestedDir} → ${stateDir}`,
      ]);
      expect(fs.readFileSync(path.join(stateDir, "openclaw.json"), "utf8")).toBe("{}\n");
      expect(fs.readFileSync(path.join(stateDir, "agents", "main", "sessions.json"), "utf8")).toBe(
        "{}\n",
      );
      expect(fs.existsSync(nestedDir)).toBe(false);
    });
  });

  it("moves non-conflicting entries while preserving nested conflicts", async () => {
    await withTempDir({ prefix: "openclaw-nested-home-conflict-" }, async (root) => {
      const stateDir = path.join(root, ".openclaw");
      const nestedDir = path.join(stateDir, ".openclaw");
      fs.mkdirSync(path.join(nestedDir, "credentials"), { recursive: true });
      fs.writeFileSync(path.join(stateDir, "openclaw.json"), "current\n", "utf8");
      fs.writeFileSync(path.join(nestedDir, "openclaw.json"), "nested\n", "utf8");
      fs.writeFileSync(path.join(nestedDir, "credentials", "oauth.json"), "nested-auth\n", "utf8");

      const result = await repairNestedOpenClawHomeStateDir({
        env: { OPENCLAW_HOME: stateDir } as NodeJS.ProcessEnv,
        homedir: () => root,
      });

      expect(result.changes).toEqual([
        `Recovered 1 nested state entry: ${nestedDir} → ${stateDir}`,
      ]);
      expect(result.warnings).toEqual([
        `Nested state conflicts left unchanged in ${nestedDir}: openclaw.json`,
      ]);
      expect(fs.readFileSync(path.join(stateDir, "openclaw.json"), "utf8")).toBe("current\n");
      expect(fs.readFileSync(path.join(nestedDir, "openclaw.json"), "utf8")).toBe("nested\n");
      expect(fs.readFileSync(path.join(stateDir, "credentials", "oauth.json"), "utf8")).toBe(
        "nested-auth\n",
      );
    });
  });

  it("recovers nested files inside existing state directories", async () => {
    await withTempDir({ prefix: "openclaw-nested-home-merge-" }, async (root) => {
      const stateDir = path.join(root, ".openclaw");
      const nestedDir = path.join(stateDir, ".openclaw");
      fs.mkdirSync(path.join(stateDir, "agents", "main"), { recursive: true });
      fs.mkdirSync(path.join(nestedDir, "agents", "main"), { recursive: true });
      fs.writeFileSync(path.join(stateDir, "agents", "main", "settings.json"), "current\n", "utf8");
      fs.writeFileSync(path.join(nestedDir, "agents", "main", "sessions.json"), "{}\n", "utf8");

      const result = await repairNestedOpenClawHomeStateDir({
        env: { OPENCLAW_HOME: stateDir } as NodeJS.ProcessEnv,
        homedir: () => root,
      });

      expect(result.warnings).toEqual([]);
      expect(result.changes).toEqual([
        `Recovered 1 nested state entry: ${nestedDir} → ${stateDir}`,
      ]);
      expect(fs.readFileSync(path.join(stateDir, "agents", "main", "settings.json"), "utf8")).toBe(
        "current\n",
      );
      expect(fs.readFileSync(path.join(stateDir, "agents", "main", "sessions.json"), "utf8")).toBe(
        "{}\n",
      );
      expect(fs.existsSync(nestedDir)).toBe(false);
    });
  });
});
