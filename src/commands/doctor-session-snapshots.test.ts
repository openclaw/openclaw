import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../config/sessions/types.js";

const note = vi.hoisted(() => vi.fn());

vi.mock("../terminal/note.js", () => ({
  note,
}));

import {
  noteSessionSnapshotHealth,
  scanSessionStoreForStaleRuntimeSnapshotPaths,
} from "./doctor-session-snapshots.js";

function sessionEntry(patch: Partial<SessionEntry>): SessionEntry {
  return {
    sessionId: "session-1",
    updatedAt: Date.now(),
    ...patch,
  };
}

function skillPrompt(location: string): string {
  return [
    "<available_skills>",
    "  <skill>",
    "    <name>doctor</name>",
    "    <description>Doctor skill</description>",
    `    <location>${location}</location>`,
    "  </skill>",
    "</available_skills>",
  ].join("\n");
}

describe("doctor session snapshot stale runtime metadata", () => {
  let root = "";
  let bundledSkillsDir = "";

  beforeEach(async () => {
    note.mockClear();
    root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-doctor-session-snapshots-"));
    bundledSkillsDir = path.join(root, "current", "skills");
    await fs.mkdir(path.join(bundledSkillsDir, "doctor"), { recursive: true });
    await fs.writeFile(path.join(bundledSkillsDir, "doctor", "SKILL.md"), "# Doctor\n");
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("flags cached bundled skill locations from inactive and temp-backed runtime roots", () => {
    const stalePath = path.join(
      root,
      "old-runtime",
      "node_modules",
      "openclaw",
      "skills",
      "doctor",
      "SKILL.md",
    );
    const tempBackedPath = path.join(
      path.sep,
      "private",
      "tmp",
      "openclaw",
      "skills",
      "doctor",
      "SKILL.md",
    );
    const findings = scanSessionStoreForStaleRuntimeSnapshotPaths({
      bundledSkillsDir,
      store: {
        "agent:main": sessionEntry({
          skillsSnapshot: {
            prompt: skillPrompt(stalePath),
            skills: [{ name: "doctor" }],
          },
        }),
        "agent:temp": sessionEntry({
          skillsSnapshot: {
            prompt: skillPrompt(tempBackedPath),
            skills: [{ name: "doctor" }],
          },
        }),
      },
    });

    expect(findings).toEqual([
      {
        sessionKey: "agent:main",
        field: "skillsSnapshot.prompt",
        cachedPath: stalePath,
        expectedPath: path.join(bundledSkillsDir, "doctor", "SKILL.md"),
      },
      {
        sessionKey: "agent:temp",
        field: "skillsSnapshot.prompt",
        cachedPath: tempBackedPath,
        expectedPath: path.join(bundledSkillsDir, "doctor", "SKILL.md"),
      },
    ]);
  });

  it("ignores current bundled locations and unrelated workspace skill locations", () => {
    const currentPath = path.join(bundledSkillsDir, "doctor", "SKILL.md");
    const workspacePath = path.join(root, "workspace", "skills", "doctor", "SKILL.md");
    const openClawWorkspacePath = path.join(
      root,
      "projects",
      "openclaw",
      "skills",
      "doctor",
      "SKILL.md",
    );
    const findings = scanSessionStoreForStaleRuntimeSnapshotPaths({
      bundledSkillsDir,
      store: {
        "agent:current": sessionEntry({
          skillsSnapshot: { prompt: skillPrompt(currentPath), skills: [{ name: "doctor" }] },
        }),
        "agent:workspace": sessionEntry({
          skillsSnapshot: { prompt: skillPrompt(workspacePath), skills: [{ name: "doctor" }] },
        }),
        "agent:openclaw-workspace": sessionEntry({
          skillsSnapshot: {
            prompt: skillPrompt(openClawWorkspacePath),
            skills: [{ name: "doctor" }],
          },
        }),
      },
      pathExists: (filePath) => filePath === currentPath,
    });

    expect(findings).toEqual([]);
  });

  it("handles Windows current and stale bundled skill paths without false positives", () => {
    const windowsBundledSkillsDir = path.win32.join(
      "C:\\",
      "Users",
      "alice",
      ".openclaw",
      "lib",
      "node_modules",
      "openclaw",
      "skills",
    );
    const currentPath = path.win32.join(windowsBundledSkillsDir, "doctor", "SKILL.md");
    const stalePath = path.win32.join(
      "C:\\",
      "opt",
      "node_modules",
      "openclaw",
      "skills",
      "doctor",
      "SKILL.md",
    );

    const findings = scanSessionStoreForStaleRuntimeSnapshotPaths({
      bundledSkillsDir: windowsBundledSkillsDir,
      store: {
        "agent:current": sessionEntry({
          skillsSnapshot: { prompt: skillPrompt(currentPath), skills: [{ name: "doctor" }] },
        }),
        "agent:stale": sessionEntry({
          skillsSnapshot: { prompt: skillPrompt(stalePath), skills: [{ name: "doctor" }] },
        }),
      },
      pathExists: (filePath) => filePath === currentPath,
    });

    expect(findings).toEqual([
      {
        sessionKey: "agent:stale",
        field: "skillsSnapshot.prompt",
        cachedPath: stalePath,
        expectedPath: currentPath,
      },
    ]);
  });

  it("reports stale cached metadata while distinguishing the live runtime root", async () => {
    const stalePath = path.join(
      root,
      "old-runtime",
      "node_modules",
      "openclaw",
      "skills",
      "doctor",
      "SKILL.md",
    );
    const storePath = path.join(root, "state", "agents", "main", "sessions", "sessions.json");
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await fs.writeFile(
      storePath,
      JSON.stringify(
        {
          "agent:main": sessionEntry({
            skillsSnapshot: {
              prompt: skillPrompt(stalePath),
              skills: [{ name: "doctor" }],
            },
          }),
        },
        null,
        2,
      ),
    );

    await noteSessionSnapshotHealth({ storePaths: [storePath], bundledSkillsDir });

    expect(note).toHaveBeenCalledTimes(1);
    const [message, title] = note.mock.calls[0] as [string, string];
    expect(title).toBe("Session snapshots");
    expect(message).toContain("stale cached session metadata paths");
    expect(message).toContain("Live bundled skills root is healthy");
    expect(message).toContain("inactive runtime root");
    expect(message).toContain(stalePath);
    expect(message).toContain(path.join(bundledSkillsDir, "doctor", "SKILL.md"));
  });
});
