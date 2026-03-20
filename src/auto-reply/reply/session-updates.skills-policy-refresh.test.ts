import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as SkillsModule from "../../agents/skills.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { ensureSkillSnapshot } from "./session-updates.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  vi.restoreAllMocks();
});

async function makeWorkspaceDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makePolicySnapshot(
  globalEnabled: string[],
): NonNullable<SessionEntry["skillsSnapshot"]>["policy"] {
  return {
    agentId: "ops",
    globalEnabled,
    agentEnabled: [],
    agentDisabled: [],
    effective: globalEnabled,
  };
}

describe("ensureSkillSnapshot policy refresh", () => {
  it("refreshes cached snapshots when skills.policy changes", async () => {
    const workspaceDir = await makeWorkspaceDir("openclaw-session-policy-refresh-");
    const sessionKey = "agent:ops:main";
    const existingEntry: SessionEntry = {
      sessionId: "session-1",
      updatedAt: 1,
      systemSent: false,
      skillsSnapshot: {
        prompt: "cached",
        skills: [],
        skillFilter: ["weather"],
        policy: makePolicySnapshot(["weather"]),
        version: 0,
      },
    };
    const sessionStore: Record<string, SessionEntry> = {
      [sessionKey]: existingEntry,
    };
    const cfg: OpenClawConfig = {
      agents: { list: [{ id: "ops", skills: ["weather"] }] },
      skills: {
        policy: {
          globalEnabled: ["meme-factory"],
        },
      },
    };

    const result = await withEnvAsync({ OPENCLAW_TEST_FAST: "0" }, () =>
      ensureSkillSnapshot({
        sessionEntry: existingEntry,
        sessionStore,
        sessionKey,
        isFirstTurnInSession: false,
        workspaceDir,
        cfg,
        skillFilter: ["weather"],
      }),
    );

    expect(result.skillsSnapshot?.policy?.globalEnabled).toEqual(["meme-factory"]);
    expect(result.skillsSnapshot?.policy?.effective).toEqual(["meme-factory"]);
    expect(sessionStore[sessionKey]?.skillsSnapshot?.policy?.globalEnabled).toEqual([
      "meme-factory",
    ]);
  });

  it("keeps cached snapshots when version/filter/policy are unchanged", async () => {
    const workspaceDir = await makeWorkspaceDir("openclaw-session-policy-stable-");
    const sessionKey = "agent:ops:main";
    const existingSnapshot: SessionEntry["skillsSnapshot"] = {
      prompt: "cached",
      skills: [],
      policy: makePolicySnapshot(["weather"]),
      version: 0,
    };
    const existingEntry: SessionEntry = {
      sessionId: "session-2",
      updatedAt: 2,
      systemSent: false,
      skillsSnapshot: existingSnapshot,
    };
    const cfg: OpenClawConfig = {
      agents: { list: [{ id: "ops" }] },
      skills: {
        policy: {
          globalEnabled: ["weather"],
        },
      },
    };

    const result = await withEnvAsync({ OPENCLAW_TEST_FAST: "0" }, () =>
      ensureSkillSnapshot({
        sessionEntry: existingEntry,
        sessionStore: {
          [sessionKey]: existingEntry,
        },
        sessionKey,
        isFirstTurnInSession: false,
        workspaceDir,
        cfg,
      }),
    );

    expect(result.skillsSnapshot).toBe(existingSnapshot);
    expect(result.skillsSnapshot?.prompt).toBe("cached");
  });

  it("builds a snapshot on first turn even without sessionStore/sessionKey", async () => {
    const workspaceDir = await makeWorkspaceDir("openclaw-session-policy-fallback-");
    const result = await withEnvAsync({ OPENCLAW_TEST_FAST: "0" }, () =>
      ensureSkillSnapshot({
        isFirstTurnInSession: true,
        workspaceDir,
        cfg: {},
      }),
    );

    expect(result.skillsSnapshot).toBeDefined();
    expect(Array.isArray(result.skillsSnapshot?.skills)).toBe(true);
  });

  it("builds at most once on first turn when refresh is needed", async () => {
    const workspaceDir = await makeWorkspaceDir("openclaw-session-policy-single-build-");
    const sessionKey = "agent:ops:main";
    const existingEntry: SessionEntry = {
      sessionId: "session-3",
      updatedAt: 3,
      systemSent: false,
      skillsSnapshot: {
        prompt: "cached",
        skills: [],
        skillFilter: ["weather"],
        policy: makePolicySnapshot(["weather"]),
        version: 0,
      },
    };
    const sessionStore: Record<string, SessionEntry> = {
      [sessionKey]: existingEntry,
    };
    const cfg: OpenClawConfig = {
      agents: { list: [{ id: "ops", skills: ["weather"] }] },
      skills: {
        policy: {
          globalEnabled: ["meme-factory"],
        },
      },
    };
    const buildSpy = vi.spyOn(SkillsModule, "buildWorkspaceSkillSnapshot");

    const result = await withEnvAsync({ OPENCLAW_TEST_FAST: "0" }, () =>
      ensureSkillSnapshot({
        sessionEntry: existingEntry,
        sessionStore,
        sessionKey,
        isFirstTurnInSession: true,
        workspaceDir,
        cfg,
        skillFilter: ["weather"],
      }),
    );

    expect(buildSpy).toHaveBeenCalledTimes(1);
    expect(result.skillsSnapshot?.policy?.globalEnabled).toEqual(["meme-factory"]);
  });
});
