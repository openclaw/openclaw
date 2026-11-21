import { readFile } from "node:fs/promises";
import { beforeAll, expect, test } from "vitest";
import { resolveAgentDir } from "../agents/agent-scope.js";
import {
  loadAuthProfileStoreForRuntime,
  loadAuthProfileStoreWithoutExternalProfiles,
  saveAuthProfileStore,
} from "../agents/auth-profiles.js";
import { reloadSharedAuthStoreOwnership } from "../agents/auth-profiles/path-resolve.js";
import { loadPersistedAuthProfileStore } from "../agents/auth-profiles/persisted.js";
import { SHARED_AUTH_STORE_STATE_KEY } from "../agents/auth-profiles/sqlite-json.js";
import { getRuntimeConfig } from "../config/io.js";
import { resolveConfigPath } from "../config/paths.js";
import { writeConfigMachineState } from "../state/config-machine-state-write.js";
import type { ModelAuthStatusResult } from "./server-methods/models-auth-status.types.js";
import { startGatewayServerHarness } from "./server.e2e-ws-harness.js";
import { writeGatewayTestConfig } from "./test-helpers.config-runtime.js";
import { prepareGatewayReplyRuntimeForTest, rpcReq } from "./test-helpers.js";
import { setupGatewaySessionsHandlerTestHarness } from "./test/server-sessions.test-helpers.js";

const { createSelectedGlobalSessionStore } = setupGatewaySessionsHandlerTestHarness();

// This handler fixture starts a Gateway after selecting its shared auth owner.
beforeAll(async () => {
  await import("./server-start.js");
});

test("models.authOrderSet keeps main priority and Reset agent-owned", async () => {
  const agentId = "main";
  await createSelectedGlobalSessionStore();
  const cfg = getRuntimeConfig();
  const agentDir = resolveAgentDir(cfg, agentId);
  const siblingDir = resolveAgentDir(cfg, "work");
  // Select the shared owner before startup captures process-stable auth snapshots.
  writeConfigMachineState(SHARED_AUTH_STORE_STATE_KEY, { location: "state-db" });
  await reloadSharedAuthStoreOwnership(process.env);
  const provider = "fixture";
  const initialOrder = ["fixture:first"];
  const updatedOrder = ["fixture:second", "fixture:first"];
  saveAuthProfileStore({
    version: 1,
    profiles: {
      "fixture:first": { type: "api_key", provider, key: "fixture-first" },
      "fixture:second": { type: "api_key", provider, key: "fixture-second" },
    },
    order: { [provider]: initialOrder },
  });
  const harness = await startGatewayServerHarness();
  try {
    await prepareGatewayReplyRuntimeForTest();
    for (const scope of ["operator.read", "operator.write"]) {
      const { ws } = await harness.openClient({ scopes: [scope] });
      const denied = await rpcReq(ws, "models.authOrderSet", {
        provider,
        profileIds: updatedOrder,
        agentId,
      });
      expect(denied.error).toMatchObject({
        code: "FORBIDDEN",
        message: "missing scope: operator.admin",
      });
      expect(loadPersistedAuthProfileStore(agentDir)?.order?.[provider]).toBeUndefined();
    }

    const { ws } = await harness.openClient({ scopes: ["operator.admin", "operator.read"] });
    const readStatus = async () => {
      const status = await rpcReq<ModelAuthStatusResult>(ws, "models.authStatus", { agentId });
      expect(status.ok, JSON.stringify(status)).toBe(true);
      return status.payload?.providers.find((entry) => entry.provider === provider);
    };
    const inheritedStatus = await readStatus();
    expect(inheritedStatus).toMatchObject({ profileOrder: initialOrder });
    expect(inheritedStatus?.profileOrderStored).not.toBe(true);
    const allowed = await rpcReq(ws, "models.authOrderSet", {
      provider,
      profileIds: updatedOrder,
      agentId,
    });
    expect(allowed.ok, JSON.stringify(allowed)).toBe(true);
    // The first status after acknowledgement must already reflect the committed owner.
    expect(await readStatus()).toMatchObject({
      profileOrder: updatedOrder,
      profileOrderStored: true,
    });
    expect(loadPersistedAuthProfileStore(agentDir)?.order?.[provider]).toEqual(updatedOrder);
    expect(loadAuthProfileStoreWithoutExternalProfiles().order?.[provider]).toEqual(initialOrder);
    expect(loadAuthProfileStoreForRuntime(siblingDir).order?.[provider]).toEqual(initialOrder);
    const reset = await rpcReq(ws, "models.authOrderSet", { provider, agentId });
    expect(reset.ok, JSON.stringify(reset)).toBe(true);
    const afterReset = await readStatus();
    expect(afterReset?.profileOrder).toEqual(initialOrder);
    expect(afterReset?.profileOrderStored).not.toBe(true);
    expect(loadPersistedAuthProfileStore(agentDir)?.order?.[provider]).toBeUndefined();
    expect(loadAuthProfileStoreWithoutExternalProfiles().order?.[provider]).toEqual(initialOrder);
    expect(loadAuthProfileStoreForRuntime(siblingDir).order?.[provider]).toEqual(initialOrder);
  } finally {
    await harness.close();
  }
});

test("an admin can rename and clear one owned account without changing credentials or priority", async () => {
  await createSelectedGlobalSessionStore();
  const provider = "fixture";
  const profileId = "fixture:one";
  const peerId = "fixture:two";
  const cfg = getRuntimeConfig();
  const agentDir = resolveAgentDir(cfg, "main");
  const credential = {
    type: "oauth" as const,
    provider,
    email: "alex@example.test",
    access: "synthetic-access",
    refresh: "synthetic-refresh",
    expires: Date.now() + 60 * 60_000,
    chatgptPlanType: "pro",
  };
  const peer = { ...credential, refresh: "synthetic-peer-refresh", chatgptPlanType: "team" };
  const order = { [provider]: [peerId, profileId] };
  await writeGatewayTestConfig(resolveConfigPath(), {
    auth: {
      profiles: {
        [profileId]: { provider, mode: "oauth" },
        [peerId]: { provider, mode: "oauth", displayName: "Managed label" },
      },
    },
  });
  writeConfigMachineState(SHARED_AUTH_STORE_STATE_KEY, { location: "state-db" });
  await reloadSharedAuthStoreOwnership(process.env);
  saveAuthProfileStore({
    version: 1,
    profiles: { [profileId]: credential, [peerId]: peer },
    order,
  });
  const harness = await startGatewayServerHarness();
  try {
    await prepareGatewayReplyRuntimeForTest();
    const { ws: reader } = await harness.openClient({ scopes: ["operator.read"] });
    const { ws: admin } = await harness.openClient({ scopes: ["operator.admin", "operator.read"] });
    const rename = (ws: typeof admin, agentId: string, displayName: string) =>
      rpcReq(ws, "models.authProfileRename", { agentId, profileId, displayName });
    const status = async (ws: typeof admin) => {
      const reply = await rpcReq<ModelAuthStatusResult>(ws, "models.authStatus", {
        agentId: "main",
      });
      expect(reply.ok, JSON.stringify(reply.error)).toBe(true);
      return reply.payload?.providers.find((entry) => entry.provider === provider);
    };
    const readAccount = async (ws: typeof admin) =>
      (await status(ws))?.profiles.find((profile) => profile.profileId === profileId);
    // The first request synchronizes the test harness's session config.
    expect(await readAccount(admin)).toMatchObject({ renameSupported: true, planLabel: "Pro" });
    const configBeforeRename = await readFile(resolveConfigPath());
    expect((await rename(reader, "main", "Not allowed")).error).toMatchObject({
      code: "FORBIDDEN",
      message: "missing scope: operator.admin",
    });
    expect((await rename(admin, "work", "Wrong owner")).error?.code).toBe("INVALID_REQUEST");
    expect(
      await rpcReq(admin, "models.authProfileRename", {
        agentId: "main",
        profileId: peerId,
        displayName: "Not allowed",
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST", message: "Account name is managed in configuration" },
    });
    expect(
      (await status(admin))?.profiles.find((profile) => profile.profileId === peerId),
    ).toMatchObject({
      displayName: "Managed label",
      nameManagedByConfig: true,
      planLabel: "Business",
    });
    for (const key of ["email", "displayName", "renameSupported", "planLabel"]) {
      expect(await readAccount(reader)).not.toHaveProperty(key);
    }
    expect(await rename(admin, "main", "  Personal  ")).toMatchObject({
      ok: true,
      payload: { profileId, displayName: "Personal" },
    });
    expect(await readAccount(admin)).toMatchObject({ displayName: "Personal" });
    expect(loadAuthProfileStoreWithoutExternalProfiles()).toMatchObject({
      profiles: { [profileId]: { ...credential, displayName: "Personal" }, [peerId]: peer },
      order,
    });
    expect(loadPersistedAuthProfileStore(agentDir)?.profiles[profileId]).toBeUndefined();
    expect(await rename(admin, "main", " ")).toMatchObject({
      ok: true,
      payload: { profileId, displayName: null },
    });
    expect(await readAccount(admin)).not.toHaveProperty("displayName");
    expect(loadAuthProfileStoreWithoutExternalProfiles().profiles[profileId]).toEqual(credential);
    expect((await status(admin))?.profileOrder).toEqual(order[provider]);
    expect(await readFile(resolveConfigPath())).toEqual(configBeforeRename);
  } finally {
    await harness.close();
  }
});
