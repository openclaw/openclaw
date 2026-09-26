import fs from "node:fs/promises";
import path from "node:path";
import { expect, test } from "vitest";
import { managedWorktrees } from "../agents/worktrees/service.js";
import { rpcReq } from "./test-helpers.js";
import {
  getGatewayConfigModule,
  setupGatewaySessionsTestHarness,
} from "./test/server-sessions.test-helpers.js";

const { createSessionStoreDir, openClient } = setupGatewaySessionsTestHarness();

// Real isolated Gateway and authenticated WebSocket RPC. No provider credentials,
// remote worker, or model turn: an unavailable required profile must retain the
// published session, and a later request must still be able to read its identity.
test("public required sessions.create publishes an owned non-main session before a later read", async () => {
  const { dir } = await createSessionStoreDir();
  const config = await getGatewayConfigModule();
  await config.writeConfigFile({ cloudWorkers: { requiredProfile: "unavailable-native" } });
  const key = "agent:main:dashboard:required-publication";
  const { ws } = await openClient({
    scopes: ["operator.write", "operator.read"],
    deviceIdentityPath: path.join(dir, "required-writer.json"),
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
    const workspace = managedWorktrees.findLiveByOwner("session", key);
    expect(workspace).toBeDefined();
    expect(await fs.readdir(workspace!.path)).toEqual([".git"]);
    const described = await rpcReq(ws, "sessions.describe", { key });
    expect(described.ok, JSON.stringify(described.error)).toBe(true);
    expect(described.payload).toMatchObject({
      session: { key, sessionId: created.payload!.sessionId },
    });
    expect(managedWorktrees.findLiveByOwner("session", key)?.id).toBe(workspace!.id);
  } finally {
    ws.close();
    const workspace = managedWorktrees.findLiveByOwner("session", key);
    if (workspace) {
      await managedWorktrees.remove({
        id: workspace.id,
        reason: "test-cleanup",
        allowSnapshotLoss: true,
      });
    }
  }
});
