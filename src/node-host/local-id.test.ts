import fs from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";
import * as identityReader from "../infra/device-identity-async.js";
import {
  loadDeviceIdentityIfPresent,
  loadOrCreateDeviceIdentity,
} from "../infra/device-identity.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { configureNodeHost } from "./config.js";
import { resolveLocalNodeId } from "./local-id.js";

const states: OpenClawTestState[] = [];

async function createState(label: string) {
  const state = await createOpenClawTestState({ label, layout: "state-only", applyEnv: false });
  states.push(state);
  return state;
}

const configure = (state: OpenClawTestState, nodeId?: string) =>
  configureNodeHost({ fallbackDisplayName: "Gateway node", gateway: {}, env: state.env, nodeId });
const concurrentReads = (state: OpenClawTestState) =>
  Promise.all(Array.from({ length: 6 }, () => resolveLocalNodeId(state.env)));
const closeDatabase = async () => {
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
};

afterEach(async () => {
  vi.restoreAllMocks();
  await closeDatabase();
  while (states.length > 0) {
    await states.pop()?.cleanup();
  }
});

it("uses the primary device identity, not the default runner UUID or instance override", async () => {
  const state = await createState("local-node-id");
  const config = await configure(state);
  const identity = loadOrCreateDeviceIdentity({ env: state.env });
  expect(config.nodeId).not.toBe(identity.deviceId);
  const read = vi.spyOn(identityReader, "loadDeviceIdentityIfPresentAsync");
  await expect(concurrentReads(state)).resolves.toEqual(Array(6).fill(identity.deviceId));
  expect(read).toHaveBeenCalledOnce();

  await configure(state, "replacement-instance");
  await expect(resolveLocalNodeId(state.env)).resolves.toBe(identity.deviceId);

  // Once discovered, the same-install identity stays stable until process restart.
  await closeDatabase();
  await fs.rm(state.stateDir, { recursive: true });
  expect(loadDeviceIdentityIfPresent({ env: state.env })).toBeNull();
  await expect(resolveLocalNodeId(state.env)).resolves.toBe(identity.deviceId);

  const independent = await createState("local-node-id-independent");
  const independentIdentity = loadOrCreateDeviceIdentity({ env: independent.env });
  expect(independentIdentity.deviceId).not.toBe(identity.deviceId);
  await expect(resolveLocalNodeId(independent.env)).resolves.toBe(independentIdentity.deviceId);
  await expect(resolveLocalNodeId(state.env)).resolves.toBe(identity.deviceId);
});

it("does not create credentials on a miss and discovers an identity created later", async () => {
  const state = await createState("local-node-id-missing");
  const read = vi.spyOn(identityReader, "loadDeviceIdentityIfPresentAsync");
  await expect(concurrentReads(state)).resolves.toEqual(Array(6).fill(null));
  expect(read).toHaveBeenCalledOnce();
  expect(await fs.readdir(state.stateDir)).toEqual([]);

  await configure(state);
  await expect(resolveLocalNodeId(state.env)).resolves.toBeNull();
  expect(loadDeviceIdentityIfPresent({ env: state.env })).toBeNull();
  expect(read).toHaveBeenCalledTimes(2);

  const identity = loadOrCreateDeviceIdentity({ env: state.env });
  await expect(resolveLocalNodeId(state.env)).resolves.toBe(identity.deviceId);
});

it("retries after a failed canonical identity read", async () => {
  const state = await createState("local-node-id-retry");
  const legacyPath = await state.writeText("identity/device.json", "{}\n");
  const read = vi.spyOn(identityReader, "loadDeviceIdentityIfPresentAsync");
  const results = await Promise.allSettled(
    Array.from({ length: 6 }, () => resolveLocalNodeId(state.env)),
  );
  for (const result of results) {
    expect(result).toMatchObject({
      status: "rejected",
      reason: expect.objectContaining({
        message: expect.stringContaining("openclaw doctor --fix"),
      }),
    });
  }
  expect(read).toHaveBeenCalledOnce();

  await fs.rm(legacyPath);
  const identity = loadOrCreateDeviceIdentity({ env: state.env });
  await expect(resolveLocalNodeId(state.env)).resolves.toBe(identity.deviceId);
});
