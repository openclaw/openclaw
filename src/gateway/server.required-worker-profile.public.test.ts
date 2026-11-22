import fs from "node:fs/promises";
import path from "node:path";
import { expect, test } from "vitest";
import { managedWorktrees } from "../agents/worktrees/service.js";
import { registerProjectRegistry } from "../projects/project-registry.js";
import { initializeRepository } from "./server.sessions.create.projects.test-support.js";
import { rpcReq } from "./test-helpers.js";
import {
  getGatewayConfigModule,
  setupGatewaySessionsTestHarness,
} from "./test/server-sessions.test-helpers.js";

const { createSessionStoreDir, openClient } = setupGatewaySessionsTestHarness(async () => {
  // Keep cold creation-family loading outside the public RPC response deadline.
  await import("./server-methods/sessions-create.js");
});

// Real isolated Gateway and authenticated WebSocket RPC. No provider credentials,
// remote worker, or model turn: an unavailable required profile must retain the
// published session, and a later request must still be able to read its identity.
test.each([false, true])(
  "public required sessions.create preserves its source (default project: %s)",
  async (withDefault) => {
    const { dir } = await createSessionStoreDir();
    const config = await getGatewayConfigModule();
    const repoRoot = withDefault ? await initializeRepository(dir, "default-project") : undefined;
    const project = repoRoot ? await registerProjectRegistry({ path: repoRoot }) : undefined;
    await config.writeConfigFile({
      cloudWorkers: { requiredProfile: "unavailable-native" },
      ...(project ? { gateway: { projects: { defaultProjectId: project.id } } } : {}),
    });
    const key = "agent:main:dashboard:required-publication";
    const { ws } = await openClient({
      scopes: ["operator.write", "operator.read"],
      deviceIdentityPath: path.join(dir, "required-writer", "client", "credentials.sqlite"),
    });
    try {
      const created = await rpcReq<{
        key: string;
        sessionId: string;
        runStarted: boolean;
        runError?: { message: string };
      }>(ws, "sessions.create", { key, agentId: "main", message: "" });
      expect(created.ok, JSON.stringify(created.error)).toBe(true);
      expect(created.payload).toMatchObject({ key, runStarted: false });
      expect(created.payload?.runError?.message).toBeTruthy();
      const workspace = await managedWorktrees.findLiveByOwner("session", key);
      expect(workspace).toBeDefined();
      if (project) {
        expect(workspace?.repoRoot).toBe(repoRoot);
        expect(workspace?.path).not.toBe(repoRoot);
        expect(await fs.readFile(path.join(workspace!.path, "README.md"), "utf8")).toBe(
          "default-project\n",
        );
        const emptyKey = "agent:main:dashboard:explicit-empty";
        const empty = await rpcReq(ws, "sessions.create", {
          key: emptyKey,
          agentId: "main",
          worktree: true,
          worktreeSource: "empty",
        });
        expect(empty.ok, JSON.stringify(empty.error)).toBe(true);
        const emptyWorkspace = await managedWorktrees.findLiveByOwner("session", emptyKey);
        expect(await fs.readdir(emptyWorkspace!.path)).toEqual([".git"]);
        await managedWorktrees.remove({
          id: emptyWorkspace!.id,
          reason: "test-cleanup",
          allowSnapshotLoss: true,
        });
      } else {
        expect(await fs.readdir(workspace!.path)).toEqual([".git"]);
      }
      const described = await rpcReq(ws, "sessions.describe", { key });
      expect(described.ok, JSON.stringify(described.error)).toBe(true);
      expect(described.payload).toMatchObject({
        session: { key, sessionId: created.payload!.sessionId },
      });
      expect((await managedWorktrees.findLiveByOwner("session", key))?.id).toBe(workspace!.id);
    } finally {
      ws.close();
      const workspace = await managedWorktrees.findLiveByOwner("session", key);
      if (workspace) {
        await managedWorktrees.remove({
          id: workspace.id,
          reason: "test-cleanup",
          allowSnapshotLoss: true,
        });
      }
    }
  },
);
