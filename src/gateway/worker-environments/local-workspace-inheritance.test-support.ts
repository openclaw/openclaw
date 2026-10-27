import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { expect } from "vitest";
import { withLocalWorkspaceProjection } from "./local-workspace-projection.js";
import { readLocalWorkspaceProjection } from "./local-workspace-store.test-support.js";
import type { LocalWorkspaceOwner } from "./local-workspace-types.js";

const writeText = (root: string, file: string, content: string) =>
  fs.writeFile(path.join(root, file), content);
const expectText = async (root: string, file: string, content: string) =>
  expect(await fs.readFile(path.join(root, file), "utf8")).toBe(content);
const expectMissing = async (root: string, file: string) =>
  expect(fs.stat(path.join(root, file))).rejects.toMatchObject({ code: "ENOENT" });

export async function proveInheritedLocalWorkspace(owner: LocalWorkspaceOwner, canonical: string) {
  const { resolveSandboxConfigForAgent } = await import("../../agents/sandbox/config.js");
  const { prepareLocalSandboxWorkspace } = await import("../../agents/sandbox/local-workspace.js");
  const { createInitialSubagentSession } =
    await import("../../agents/subagents/spawn/subagent-spawn-session-patch.js");
  const { replaceSessionEntry } = await import("../../config/sessions/session-accessor.js");
  const { resolveSessionStorePathCore } = await import("../../config/sessions/paths.js");
  const { resolveGatewaySessionStoreTargetInWorker } =
    await import("../session-utils-store-worker.js");
  const { resolveLocalWorkspaceOwner } = await import("./local-workspace-projection.js");
  const cfg = { worktreeAcceleration: false };
  const storePath = resolveSessionStorePathCore(undefined, { agentId: owner.agentId });
  const parentTarget = { agentId: owner.agentId, sessionKey: owner.sessionKey, storePath };
  const parentEntry = {
    sessionId: owner.sessionId,
    updatedAt: 1,
    lifecycleRevision: "parent-generation",
    worktree: {
      id: owner.worktree.id,
      branch: owner.worktree.branch,
      repoRoot: owner.worktree.repoRoot,
    },
  };
  owner.lifecycleRevision = parentEntry.lifecycleRevision;
  await replaceSessionEntry(parentTarget, parentEntry);
  const projection = await withLocalWorkspaceProjection(owner, (state) => state.prepare());
  await writeText(projection, "accepted.txt", "parent accepted result\n");
  await withLocalWorkspaceProjection(owner, (state) => state.synchronize("canonical"));
  const childSessionKey = `agent:main:subagent:${randomUUID()}`;
  const child = await createInitialSubagentSession({
    cfg,
    requesterAgentId: owner.agentId,
    targetAgentId: owner.agentId,
    childSessionKey,
    incognito: false,
    requesterInternalKey: owner.sessionKey,
    parentTarget: await resolveGatewaySessionStoreTargetInWorker({
      cfg,
      key: owner.sessionKey,
      agentId: owner.agentId,
      projection: "full",
    }),
    expectedParentSessionId: owner.sessionId,
    creationPolicy: { actor: { type: "agent", id: owner.agentId }, sandbox: "required" },
    completionOwnerSessionKey: owner.sessionKey,
    spawnedWorkspaceDir: projection,
    sessionPermissionPolicy: { mode: "workspace", root: projection },
    modelPatch: {},
    collect: false,
  });
  expect(child.status).toBe("ok");
  // Publication/removal still require a directly owned worktree, never a borrowed binding.
  expect(
    await resolveLocalWorkspaceOwner({
      cfg,
      agentId: owner.agentId,
      sessionKey: childSessionKey,
      workspaceDir: projection,
    }),
  ).toBeUndefined();
  using workspace = await prepareLocalSandboxWorkspace({
    cfg,
    agentId: owner.agentId,
    sessionKey: childSessionKey,
    workspaceDir: projection,
    sandbox: resolveSandboxConfigForAgent(cfg, owner.agentId),
  });
  expect(workspace).toBeDefined();
  expect(workspace!.workspaceDir).toBe(projection);
  expect(workspace!.workspaceCwd).toBe(projection);
  await expectText(workspace!.workspaceCwd, "accepted.txt", "parent accepted result\n");
  await workspace!.provision(() =>
    writeText(workspace!.workspaceCwd, "child.txt", "child result\n"),
  );
  await workspace!.checkpoint();
  await expectText(canonical, "child.txt", "child result\n");
  expect((await readLocalWorkspaceProjection(owner.worktree.id))?.session_key).toBe(
    owner.sessionKey,
  );
  expect((await readLocalWorkspaceProjection(owner.worktree.id))?.session_id).toBe(owner.sessionId);
  await replaceSessionEntry(parentTarget, { ...parentEntry, lifecycleRevision: "reset-parent" });
  await expect(workspace!.provision(() => writeText(projection, "late.txt", "no"))).rejects.toThrow(
    "workspace authority changed",
  );
  await expectMissing(projection, "late.txt");
}
