import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSyntheticSourceInfo } from "../../agents/sessions/source-info.js";
import { resetLogger, setLoggerOverride } from "../../logging/logger.js";
import { loggingState } from "../../logging/state.js";
import { buildWorkspaceSkillCommandSpecs } from "../discovery/command-specs.js";
import { buildWorkspaceSkillStatus } from "../discovery/status.js";
import { captureWarningLogger } from "../loading/loading.test-support.js";
import { loadWorkspaceSkills } from "../loading/workspace-skill-loader.js";
import { buildSkillSnapshot } from "../loading/workspace-skill-prompt.js";
import type { SkillEntry } from "../types.js";
import { getSkillsSnapshotVersion } from "./refresh-state.js";
import {
  mergeRemoteNodeSkillEntries,
  recordRemoteSkillNodeInfo,
  removeRemoteNodeSkills,
  replaceRemoteNodeSkills,
} from "./remote-skills.js";
import { resetRemoteNodeSkillsForTests } from "./remote-skills.test-support.js";

function content(name: string, description: string, body = "# Instructions"): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;
}

function connect(
  nodeId = "node-1",
  info: Omit<Parameters<typeof recordRemoteSkillNodeInfo>[0], "nodeId"> = {},
) {
  recordRemoteSkillNodeInfo({ nodeId, connId: "conn-1", commands: ["system.run"], ...info });
}
function publish(name: string, description: string, body?: string) {
  replaceRemoteNodeSkills({ nodeId: "node-1", skills: [nodeSkill(name, description, body)] });
}
function nodeSkill(name: string, description: string, body?: string) {
  return { name, description, content: content(name, description, body) };
}
const remoteEntries = () => mergeRemoteNodeSkillEntries([], { canExec: true });

function localEntry(name: string): SkillEntry {
  const filePath = `/local/${name}/SKILL.md`;
  return {
    skill: {
      name,
      description: `Local ${name}`,
      filePath,
      baseDir: `/local/${name}`,
      source: "test",
      sourceInfo: createSyntheticSourceInfo(filePath, { source: "test" }),
      disableModelInvocation: false,
    },
    frontmatter: { name, description: `Local ${name}` },
  };
}

beforeEach(resetRemoteNodeSkillsForTests);

afterEach(() => {
  setLoggerOverride(null);
  loggingState.rawConsole = null;
  resetLogger();
});

describe("node-hosted skill snapshots", () => {
  it("appears while connected, includes the locator note, and disappears on disconnect", async () => {
    const before = getSkillsSnapshotVersion();
    connect("node-1", { displayName: "Build Mac" });
    publish("release-helper", "Prepare a release");

    const entries = loadWorkspaceSkills("/workspace", {
      workspaceOnly: true,
      eligibility: { nodeSkills: { canExec: true } },
    });
    const snapshot = await buildSkillSnapshot("/workspace", { entries });
    expect(snapshot.skills.map((skill) => skill.name)).toEqual(["release-helper"]);
    expect(snapshot.prompt).toContain("Build Mac (node-1)");
    expect(snapshot.prompt).toContain(
      "Read this SKILL.md with the normal read tool at its exact node:// location",
    );
    expect(snapshot.prompt).toContain("do not use file_fetch");
    expect(snapshot.prompt).toContain("to run cat SKILL.md");
    expect(snapshot.prompt).toContain("exec host=node node=node-1");
    expect(snapshot.prompt).toContain("workdir=node://node-1/skills/release-helper");
    expect(snapshot.prompt).toContain("node host resolves that locator");
    expect(snapshot.prompt).toContain("node://node-1/skills/release-helper/SKILL.md");
    expect(snapshot.resolvedSkills?.[0]?.readContent).toBe(
      content("release-helper", "Prepare a release"),
    );
    expect(getSkillsSnapshotVersion()).toBeGreaterThan(before);

    const connectedVersion = getSkillsSnapshotVersion();
    removeRemoteNodeSkills("node-1");
    expect(mergeRemoteNodeSkillEntries([])).toEqual([]);
    expect(getSkillsSnapshotVersion()).toBeGreaterThan(connectedVersion);
  });

  it("prefixes node skills on local and cross-node collisions", () => {
    for (const nodeId of ["node-a", "node-b"]) {
      connect(nodeId, { connId: nodeId.slice(-1) });
      replaceRemoteNodeSkills({
        nodeId,
        skills: [nodeSkill("deploy", "Deploy"), nodeSkill("local-only", "Remote collision")],
      });
    }

    const names = mergeRemoteNodeSkillEntries([localEntry("local-only")], {
      canExec: true,
    }).map((entry) => entry.skill.name);
    expect(names).toEqual([
      "local-only",
      "node-a-deploy",
      "node-a-local-only",
      "node-b-deploy",
      "node-b-local-only",
    ]);
  });

  it("limits node skills to the effective exec node binding", () => {
    for (const [nodeId, displayName] of [
      ["node-a-123456", "Build A"],
      ["node-b-123456", "Build B"],
    ] as const) {
      connect(nodeId, { displayName, connId: nodeId });
      replaceRemoteNodeSkills({
        nodeId,
        displayName,
        skills: [nodeSkill(`${nodeId.slice(0, 6)}-skill`, `Skill from ${displayName}`)],
      });
    }

    expect(
      mergeRemoteNodeSkillEntries([], { canExec: true, node: "Build A" }).map(
        (entry) => entry.skill.name,
      ),
    ).toEqual(["node-a-skill"]);
    expect(mergeRemoteNodeSkillEntries([], { canExec: true, node: "missing" })).toEqual([]);
  });

  it("includes connected node skills in workspace status", () => {
    connect();
    publish("status-skill", "Visible in status");

    const report = buildWorkspaceSkillStatus("/workspace", {
      eligibility: { nodeSkills: { canExec: true } },
    });
    expect(report.skills.map((skill) => skill.name)).toContain("status-skill");
  });

  it("suppresses direct tool dispatch from node skill frontmatter", () => {
    connect();
    replaceRemoteNodeSkills({
      nodeId: "node-1",
      skills: [
        {
          name: "dispatch-skill",
          description: "Must run on its node",
          content:
            "---\nname: dispatch-skill\ndescription: Must run on its node\ncommand-dispatch: tool\ncommand-tool: exec\n---\n",
        },
      ],
    });
    const entries = remoteEntries();

    const [command] = buildWorkspaceSkillCommandSpecs("/workspace", { entries });
    expect([command?.skillName, command?.dispatch]).toEqual(["dispatch-skill", undefined]);
  });

  it("drops content that fails existing frontmatter parsing", () => {
    const warn = captureWarningLogger();
    connect();
    replaceRemoteNodeSkills({
      nodeId: "node-1",
      skills: [
        {
          name: "broken-skill",
          description: "Broken",
          content: "---\nname: [broken\ndescription: Broken\n---\n",
        },
      ],
    });

    expect(remoteEntries()).toEqual([]);
    const warningText = warn.mock.calls.flat().map(String).join("\n");
    expect(warningText).toContain("node://node-1/skills/broken-skill/SKILL.md");
    expect(warningText).toContain("BAD_INDENT");
  });

  it("replaces a changed node catalog without invalidating an identical catalog", () => {
    connect("node-1", { displayName: "Build Mac" });
    publish("first", "First");
    const firstVersion = getSkillsSnapshotVersion();
    const firstSkill = remoteEntries()[0]!.skill;
    expect(firstSkill.contentHash).toEqual(expect.any(String));
    expect(firstSkill.locationNote).toContain("Build Mac (node-1)");

    publish("first", "First");
    expect(getSkillsSnapshotVersion()).toBe(firstVersion);
    expect(remoteEntries()[0]!.skill.contentHash).toBe(firstSkill.contentHash);

    publish("first", "First", "# Changed instructions");
    const changedSkill = remoteEntries()[0]!.skill;
    expect(changedSkill).toMatchObject({
      name: firstSkill.name,
      description: firstSkill.description,
      filePath: firstSkill.filePath,
    });
    expect(changedSkill.contentHash).not.toBe(firstSkill.contentHash);
    expect(getSkillsSnapshotVersion()).toBeGreaterThan(firstVersion);

    publish("second", "Second");

    expect(remoteEntries().map((entry) => entry.skill.name)).toEqual(["second"]);
    expect(getSkillsSnapshotVersion()).toBeGreaterThan(firstVersion);
  });

  it("hides skills when the session or publishing node cannot execute on the node", () => {
    connect("node-1", { commands: [] });
    publish("remote", "Remote");

    expect(remoteEntries()).toEqual([]);
    connect();
    expect(mergeRemoteNodeSkillEntries([], { canExec: false })).toEqual([]);
    expect(remoteEntries()).toHaveLength(1);
  });
});
