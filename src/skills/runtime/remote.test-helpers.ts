import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { NodeRegistry } from "../../gateway/node-registry.js";
import { recordRemoteNodeInfo, setSkillsRemoteRegistry } from "./remote.js";

export const TEST_PAIRING_GENERATION = "generation-test";

export function testRemoteSession(
  nodeId: string,
  overrides?: Partial<NonNullable<ReturnType<NodeRegistry["get"]>>>,
): NonNullable<ReturnType<NodeRegistry["get"]>> {
  return {
    nodeId,
    connId: `conn-${nodeId}`,
    pairingGeneration: TEST_PAIRING_GENERATION,
    platform: "darwin",
    commands: ["system.run", "system.which"],
    ...overrides,
  } as NonNullable<ReturnType<NodeRegistry["get"]>>;
}

export function setTestSkillsRemoteRegistry(
  nodeIds: string | readonly string[],
  registry: Partial<NodeRegistry> & Pick<NodeRegistry, "get">,
): void {
  const ids = typeof nodeIds === "string" ? [nodeIds] : nodeIds;
  setSkillsRemoteRegistry({
    ...registry,
    listCurrentConnectedSync:
      registry.listCurrentConnectedSync ??
      (() => ids.flatMap((nodeId) => (registry.get(nodeId) ? [registry.get(nodeId)!] : []))),
  } as unknown as NodeRegistry);
}

export function createRemoteSkillWorkspace(bin: string): {
  cfg: OpenClawConfig;
  workspaceDir: string;
} {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-remote-skills-"));
  const skillDir = path.join(workspaceDir, "skills", "remote-skill");
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, "SKILL.md"),
    [
      "---",
      "name: remote-skill",
      "description: Needs a remote bin",
      `metadata: { "openclaw": { "os": ["darwin"], "requires": { "bins": ["${bin}"] } } }`,
      "---",
      "# Remote Skill",
      "",
    ].join("\n"),
  );
  return {
    workspaceDir,
    cfg: {
      agents: {
        defaults: {
          workspace: workspaceDir,
        },
      },
    } satisfies OpenClawConfig,
  };
}

export function recordRemoteMacWithSystemWhich(nodeId: string): void {
  recordRemoteNodeInfo({
    nodeId,
    connId: `conn-${nodeId}`,
    pairingGeneration: TEST_PAIRING_GENERATION,
    displayName: "Remote Mac",
    platform: "darwin",
    commands: ["system.run", "system.which"],
  });
}
