import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { findDuplicateAgentDirs } from "./agent-dirs.js";

describe("agent directory filesystem identity", () => {
  it("keeps case-distinct directories separate on a case-sensitive volume", async () => {
    await withTestDir({ prefix: "openclaw-agent-dirs-case-" }, async (root) => {
      const upper = path.join(root, "AgentState");
      const lower = path.join(root, "agentstate");
      await fs.mkdir(upper);
      try {
        await fs.mkdir(lower);
      } catch {
        return;
      }

      expect(
        findDuplicateAgentDirs({
          agents: {
            entries: { upper: { agentDir: upper }, lower: { agentDir: lower } },
          },
        }),
      ).toHaveLength(0);
    });
  });

  it.each(["existing", "missing-child", "dangling"])(
    "rejects aliases that resolve to the same %s directory",
    async (kind) => {
      if (process.platform === "win32") {
        return;
      }
      await withTestDir({ prefix: "openclaw-agent-dirs-alias-" }, async (root) => {
        const target = path.join(root, "target [literal]");
        const alias = path.join(root, "alias");
        if (kind !== "dangling") {
          await fs.mkdir(target);
        }
        await fs.symlink(path.basename(target), alias);
        const suffix = kind === "missing-child" ? "future\\state" : "";
        const targetDir = path.join(target, suffix);
        const aliasDir = path.join(alias, suffix);

        expect(
          findDuplicateAgentDirs({
            agents: {
              entries: { target: { agentDir: targetDir }, alias: { agentDir: aliasDir } },
            },
          }),
        ).toEqual([{ agentDir: targetDir, agentIds: ["target", "alias"] }]);
        if (kind !== "existing") {
          await expect(fs.stat(targetDir)).rejects.toMatchObject({ code: "ENOENT" });
        }
      });
    },
  );

  it("does not create configured missing directories or leave probe entries", async () => {
    await withTestDir({ prefix: "openclaw-agent-dirs-missing-" }, async (root) => {
      const upper = path.join(root, "FutureState");
      const lower = path.join(root, "futurestate");

      findDuplicateAgentDirs({
        agents: {
          entries: { upper: { agentDir: upper }, lower: { agentDir: lower } },
        },
      });

      await expect(fs.stat(upper)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.stat(lower)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.readdir(root)).resolves.toEqual([]);
    });
  });
});
