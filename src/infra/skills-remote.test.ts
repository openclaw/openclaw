import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getSkillsSnapshotVersion, resetSkillsRefreshForTest } from "../agents/skills/refresh.js";
import {
  getRemoteSkillEligibility,
  recordRemoteNodeBins,
  recordRemoteNodeInfo,
  refreshRemoteBinsForConnectedNodes,
  refreshRemoteNodeBins,
  removeRemoteNodeInfo,
  setSkillsRemoteRegistry,
} from "./skills-remote.js";

afterEach(() => {
  setSkillsRemoteRegistry(null);
});

async function createWorkspaceWithRequiredBin(bin: string): Promise<string> {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "skills-remote-"));
  const skillDir = path.join(workspaceDir, "skills", "remote-mac-skill");
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(
    path.join(skillDir, "SKILL.md"),
    `---
name: remote-mac-skill
description: Remote mac skill probe fixture
metadata:
  openclaw:
    requires:
      bins:
        - ${bin}
---
# Remote mac skill
`,
    "utf8",
  );
  return workspaceDir;
}

describe("skills-remote", () => {
  it("removes disconnected nodes from remote skill eligibility", () => {
    const nodeId = `node-${randomUUID()}`;
    const bin = `bin-${randomUUID()}`;
    recordRemoteNodeInfo({
      nodeId,
      displayName: "Remote Mac",
      platform: "darwin",
      commands: ["system.run"],
    });
    recordRemoteNodeBins(nodeId, [bin]);

    expect(getRemoteSkillEligibility()?.hasBin(bin)).toBe(true);

    removeRemoteNodeInfo(nodeId);

    expect(getRemoteSkillEligibility()?.hasBin(bin) ?? false).toBe(false);
  });

  it("supports idempotent remote node removal", () => {
    const nodeId = `node-${randomUUID()}`;
    expect(() => {
      removeRemoteNodeInfo(nodeId);
      removeRemoteNodeInfo(nodeId);
    }).not.toThrow();
  });

  it("bumps the skills snapshot version when an eligible remote node disconnects", async () => {
    await resetSkillsRefreshForTest();
    const workspaceDir = `/tmp/ws-${randomUUID()}`;
    const nodeId = `node-${randomUUID()}`;
    recordRemoteNodeInfo({
      nodeId,
      displayName: "Remote Mac",
      platform: "darwin",
      commands: ["system.run"],
    });

    const before = getSkillsSnapshotVersion(workspaceDir);
    removeRemoteNodeInfo(nodeId);
    const after = getSkillsSnapshotVersion(workspaceDir);

    expect(after).toBeGreaterThan(before);
  });

  it("ignores non-mac and non-system.run nodes for eligibility", () => {
    const linuxNodeId = `node-${randomUUID()}`;
    const noRunNodeId = `node-${randomUUID()}`;
    const bin = `bin-${randomUUID()}`;
    try {
      recordRemoteNodeInfo({
        nodeId: linuxNodeId,
        displayName: "Linux Box",
        platform: "linux",
        commands: ["system.run"],
      });
      recordRemoteNodeBins(linuxNodeId, [bin]);

      recordRemoteNodeInfo({
        nodeId: noRunNodeId,
        displayName: "Remote Mac",
        platform: "darwin",
        commands: ["system.which"],
      });
      recordRemoteNodeBins(noRunNodeId, [bin]);

      expect(getRemoteSkillEligibility()).toBeUndefined();
    } finally {
      removeRemoteNodeInfo(linuxNodeId);
      removeRemoteNodeInfo(noRunNodeId);
    }
  });

  it("aggregates bins and note labels across eligible mac nodes", () => {
    const nodeA = `node-${randomUUID()}`;
    const nodeB = `node-${randomUUID()}`;
    const binA = `bin-${randomUUID()}`;
    const binB = `bin-${randomUUID()}`;
    try {
      recordRemoteNodeInfo({
        nodeId: nodeA,
        displayName: "Mac Studio",
        platform: "darwin",
        commands: ["system.run"],
      });
      recordRemoteNodeBins(nodeA, [binA]);

      recordRemoteNodeInfo({
        nodeId: nodeB,
        platform: "macOS",
        commands: ["system.run"],
      });
      recordRemoteNodeBins(nodeB, [binB]);

      const eligibility = getRemoteSkillEligibility();
      expect(eligibility?.platforms).toEqual(["darwin"]);
      expect(eligibility?.hasBin(binA)).toBe(true);
      expect(eligibility?.hasAnyBin([`missing-${randomUUID()}`, binB])).toBe(true);
      expect(eligibility?.note).toContain("Mac Studio");
      expect(eligibility?.note).toContain(nodeB);
    } finally {
      removeRemoteNodeInfo(nodeA);
      removeRemoteNodeInfo(nodeB);
    }
  });

  it("suppresses the exec host=node note when routing is not allowed", () => {
    const nodeId = `node-${randomUUID()}`;
    const bin = `bin-${randomUUID()}`;
    try {
      recordRemoteNodeInfo({
        nodeId,
        displayName: "Mac Studio",
        platform: "darwin",
        commands: ["system.run"],
      });
      recordRemoteNodeBins(nodeId, [bin]);

      const eligibility = getRemoteSkillEligibility({ advertiseExecNode: false });

      expect(eligibility?.hasBin(bin)).toBe(true);
      expect(eligibility?.note).toBeUndefined();
    } finally {
      removeRemoteNodeInfo(nodeId);
    }
  });

  it("limits eligibility to the configured exec node id", () => {
    const nodeA = `node-${randomUUID()}`;
    const nodeB = `node-${randomUUID()}`;
    const binA = `bin-${randomUUID()}`;
    const binB = `bin-${randomUUID()}`;
    try {
      recordRemoteNodeInfo({
        nodeId: nodeA,
        displayName: "Headless Mac",
        platform: "darwin",
        commands: ["system.run"],
      });
      recordRemoteNodeBins(nodeA, [binA]);

      recordRemoteNodeInfo({
        nodeId: nodeB,
        displayName: "OpenClaw App",
        platform: "darwin",
        commands: ["system.run"],
      });
      recordRemoteNodeBins(nodeB, [binB]);

      const eligibility = getRemoteSkillEligibility({
        cfg: {
          tools: {
            exec: {
              node: nodeA,
            },
          },
        },
      });

      expect(eligibility?.hasBin(binA)).toBe(true);
      expect(eligibility?.hasBin(binB)).toBe(false);
      expect(eligibility?.note).toContain("Headless Mac");
      expect(eligibility?.note).not.toContain("OpenClaw App");
    } finally {
      removeRemoteNodeInfo(nodeA);
      removeRemoteNodeInfo(nodeB);
    }
  });

  it("limits eligibility to the configured exec node display name", () => {
    const nodeA = `node-${randomUUID()}`;
    const nodeB = `node-${randomUUID()}`;
    const binA = `bin-${randomUUID()}`;
    const binB = `bin-${randomUUID()}`;
    try {
      recordRemoteNodeInfo({
        nodeId: nodeA,
        displayName: "Headless Mac",
        platform: "darwin",
        commands: ["system.run"],
      });
      recordRemoteNodeBins(nodeA, [binA]);

      recordRemoteNodeInfo({
        nodeId: nodeB,
        displayName: "OpenClaw App",
        platform: "darwin",
        commands: ["system.run"],
      });
      recordRemoteNodeBins(nodeB, [binB]);

      const eligibility = getRemoteSkillEligibility({
        cfg: {
          tools: {
            exec: {
              node: "OpenClaw App",
            },
          },
        },
      });

      expect(eligibility?.hasBin(binA)).toBe(false);
      expect(eligibility?.hasBin(binB)).toBe(true);
      expect(eligibility?.note).toContain("OpenClaw App");
      expect(eligibility?.note).not.toContain("Headless Mac");
    } finally {
      removeRemoteNodeInfo(nodeA);
      removeRemoteNodeInfo(nodeB);
    }
  });

  it("does not advertise remote mac skills when the configured exec node is unavailable", () => {
    const nodeId = `node-${randomUUID()}`;
    try {
      recordRemoteNodeInfo({
        nodeId,
        displayName: "Headless Mac",
        platform: "darwin",
        commands: ["system.run"],
      });

      expect(
        getRemoteSkillEligibility({
          cfg: {
            tools: {
              exec: {
                node: "missing-node",
              },
            },
          },
        }),
      ).toBeUndefined();
    } finally {
      removeRemoteNodeInfo(nodeId);
    }
  });

  it("refreshes remote bins only for the configured exec node", async () => {
    const nodeA = `node-${randomUUID()}`;
    const nodeB = `node-${randomUUID()}`;
    const requiredBin = `bin-${randomUUID()}`;
    const workspaceDir = await createWorkspaceWithRequiredBin(requiredBin);
    const invoked: string[] = [];
    try {
      recordRemoteNodeInfo({
        nodeId: nodeA,
        displayName: "Headless Mac",
        platform: "darwin",
        commands: ["system.run"],
      });
      recordRemoteNodeBins(nodeA, []);

      recordRemoteNodeInfo({
        nodeId: nodeB,
        displayName: "OpenClaw App",
        platform: "darwin",
        commands: ["system.run"],
      });
      recordRemoteNodeBins(nodeB, []);

      setSkillsRemoteRegistry({
        listConnected: () =>
          [
            {
              nodeId: nodeA,
              displayName: "Headless Mac",
              platform: "darwin",
              commands: ["system.run"],
            },
            {
              nodeId: nodeB,
              displayName: "OpenClaw App",
              platform: "darwin",
              commands: ["system.run"],
            },
          ] as never[],
        invoke: async ({ nodeId }: { nodeId: string }) => {
          invoked.push(nodeId);
          return {
            ok: true,
            payload: { bins: [] },
          };
        },
      } as unknown as Parameters<typeof setSkillsRemoteRegistry>[0]);

      await refreshRemoteBinsForConnectedNodes({
        tools: {
          exec: {
            node: nodeA,
          },
        },
        agents: {
          list: [
            {
              id: "main",
              default: true,
              workspace: workspaceDir,
            },
          ],
        },
      });

      expect(invoked).toEqual([nodeA]);
    } finally {
      setSkillsRemoteRegistry(null);
      removeRemoteNodeInfo(nodeA);
      removeRemoteNodeInfo(nodeB);
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("skips direct remote bin probes for non-selected connected nodes", async () => {
    const nodeA = `node-${randomUUID()}`;
    const nodeB = `node-${randomUUID()}`;
    const requiredBin = `bin-${randomUUID()}`;
    const workspaceDir = await createWorkspaceWithRequiredBin(requiredBin);
    const invoked: string[] = [];
    try {
      recordRemoteNodeInfo({
        nodeId: nodeA,
        displayName: "Headless Mac",
        platform: "darwin",
        commands: ["system.run"],
      });
      recordRemoteNodeBins(nodeA, []);

      recordRemoteNodeInfo({
        nodeId: nodeB,
        displayName: "OpenClaw App",
        platform: "darwin",
        commands: ["system.run"],
      });
      recordRemoteNodeBins(nodeB, []);

      setSkillsRemoteRegistry({
        listConnected: () =>
          [
            {
              nodeId: nodeA,
              displayName: "Headless Mac",
              platform: "darwin",
              commands: ["system.run"],
            },
            {
              nodeId: nodeB,
              displayName: "OpenClaw App",
              platform: "darwin",
              commands: ["system.run"],
            },
          ] as never[],
        invoke: async ({ nodeId }: { nodeId: string }) => {
          invoked.push(nodeId);
          return {
            ok: true,
            payload: { bins: [] },
          };
        },
      } as unknown as Parameters<typeof setSkillsRemoteRegistry>[0]);

      await refreshRemoteNodeBins({
        nodeId: nodeB,
        platform: "darwin",
        commands: ["system.run"],
        cfg: {
          tools: {
            exec: {
              node: nodeA,
            },
          },
          agents: {
            list: [
              {
                id: "main",
                default: true,
                workspace: workspaceDir,
              },
            ],
          },
        },
      });

      expect(invoked).toEqual([]);
    } finally {
      setSkillsRemoteRegistry(null);
      removeRemoteNodeInfo(nodeA);
      removeRemoteNodeInfo(nodeB);
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });
});
