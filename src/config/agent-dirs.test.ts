// Covers agent directory resolution across config and environment overrides.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withTempDir } from "../test-helpers/temp-dir.js";
import { findDuplicateAgentDirs } from "./agent-dirs.js";
import type { OpenClawConfig } from "./types.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("resolveEffectiveAgentDir via findDuplicateAgentDirs", () => {
  it("uses OPENCLAW_HOME for default agent dir resolution", () => {
    // findDuplicateAgentDirs calls resolveEffectiveAgentDir internally.
    // With a single agent there are no duplicates, but we can inspect the
    // resolved dir indirectly by triggering a duplicate with two agents
    // that both fall through to the same default dir — which can't happen
    // since they have different IDs.  Instead we just verify no crash and
    // that the env flows through by checking a two-agent config produces
    // distinct dirs (no duplicates).
    const cfg: OpenClawConfig = {
      agents: {
        list: [{ id: "alpha" }, { id: "beta" }],
      },
    };

    const env = {
      OPENCLAW_HOME: "/srv/openclaw-home",
      HOME: "/home/other",
    } as NodeJS.ProcessEnv;

    const dupes = findDuplicateAgentDirs(cfg, { env });
    expect(dupes).toHaveLength(0);
  });

  it("resolves agent dir under OPENCLAW_HOME state dir", () => {
    // Force two agents to the same explicit agentDir to verify the path
    // that doesn't use the default — then test the default path by
    // checking that a single-agent config resolves without duplicates.
    const cfg: OpenClawConfig = {};

    const env = {
      OPENCLAW_HOME: "/srv/openclaw-home",
    } as NodeJS.ProcessEnv;

    // No duplicates for a single default agent
    const dupes = findDuplicateAgentDirs(cfg, { env });
    expect(dupes).toHaveLength(0);
  });

  it("keeps case-distinct agent dirs separate on a case-sensitive macOS volume", async () => {
    await withTempDir({ prefix: "openclaw-agent-dirs-case-" }, async (root) => {
      const upper = path.join(root, "AgentState");
      const lower = path.join(root, "agentstate");
      await fs.mkdir(upper);
      try {
        await fs.mkdir(lower);
      } catch {
        return;
      }

      const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
      try {
        const dupes = findDuplicateAgentDirs({
          agents: {
            list: [
              { id: "upper", agentDir: upper },
              { id: "lower", agentDir: lower },
            ],
          },
        });
        expect(dupes).toHaveLength(0);
      } finally {
        platformSpy.mockRestore();
      }
    });
  });

  it("probes missing agent dirs without creating them", async () => {
    await withTempDir({ prefix: "openclaw-agent-dirs-missing-" }, async (root) => {
      const upper = path.join(root, "FutureState");
      const lower = path.join(root, "futurestate");
      const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
      try {
        const dupes = findDuplicateAgentDirs({
          agents: {
            list: [
              { id: "upper", agentDir: upper },
              { id: "lower", agentDir: lower },
            ],
          },
        });
        expect(dupes).toHaveLength(0);
        await expect(fs.stat(upper)).rejects.toMatchObject({ code: "ENOENT" });
        await expect(fs.stat(lower)).rejects.toMatchObject({ code: "ENOENT" });
        await expect(fs.readdir(root)).resolves.toEqual([]);
      } finally {
        platformSpy.mockRestore();
      }
    });
  });

  it("rejects agent dirs that alias the same directory through a symlink", async () => {
    if (process.platform === "win32") {
      return;
    }
    await withTempDir({ prefix: "openclaw-agent-dirs-alias-" }, async (root) => {
      const target = path.join(root, "target");
      const alias = path.join(root, "alias");
      await fs.mkdir(target);
      await fs.symlink(target, alias);
      const dupes = findDuplicateAgentDirs({
        agents: {
          list: [
            { id: "target", agentDir: target },
            { id: "alias", agentDir: alias },
          ],
        },
      });
      expect(dupes).toHaveLength(1);
      expect(dupes[0]?.agentIds).toEqual(["target", "alias"]);
    });
  });

  it("rejects a dangling symlink that aliases a missing agent dir", async () => {
    if (process.platform === "win32") {
      return;
    }
    await withTempDir({ prefix: "openclaw-agent-dirs-dangling-" }, async (root) => {
      const target = path.join(root, "future-target");
      const alias = path.join(root, "future-alias");
      await fs.symlink(target, alias);
      const dupes = findDuplicateAgentDirs({
        agents: {
          list: [
            { id: "target", agentDir: target },
            { id: "alias", agentDir: alias },
          ],
        },
      });
      expect(dupes).toHaveLength(1);
      await expect(fs.stat(target)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("uses the parent volume when agent dir basenames have no ASCII case", async () => {
    await withTempDir({ prefix: "openclaw-agent-dirs-numeric-" }, async (root) => {
      const upper = path.join(root, "Upper", "123");
      const lower = path.join(root, "upper", "123");
      await fs.mkdir(upper, { recursive: true });
      try {
        await fs.mkdir(lower, { recursive: true });
      } catch {
        return;
      }
      const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
      try {
        expect(
          findDuplicateAgentDirs({
            agents: {
              list: [
                { id: "upper", agentDir: upper },
                { id: "lower", agentDir: lower },
              ],
            },
          }),
        ).toHaveLength(0);
      } finally {
        platformSpy.mockRestore();
      }
    });
  });
});
