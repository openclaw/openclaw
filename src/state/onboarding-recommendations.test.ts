import fs from "node:fs";
import { afterEach, expect, it } from "vitest";
import { readConfigMachineStateWithMetadata } from "../test-utils/config-machine-state.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { writeConfigMachineState } from "./config-machine-state-write.js";
import {
  createOnboardingRecommendationsStore,
  type OnboardingRecommendationMatch,
} from "./onboarding-recommendations.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "./openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "./openclaw-state-worker-context.js";
import { executeOpenClawStateWorker } from "./openclaw-state-worker-store.js";

const matches: OnboardingRecommendationMatch[] = [
  {
    appLabel: "Chat",
    candidateId: "chat-plugin",
    tier: "recommended",
    reason: "Connects conversations",
    candidate: {
      id: "chat-plugin",
      displayName: "Chat plugin",
      summary: "Chat",
      source: "official-channel",
    },
  },
];

function storeFor(state: OpenClawTestState, workspaceDir = state.workspaceDir) {
  return createOnboardingRecommendationsStore({ workspaceDir, database: { env: state.env } });
}

function test(
  name: string,
  run: (store: ReturnType<typeof storeFor>, state: OpenClawTestState) => Promise<void>,
) {
  it(name, () =>
    withOpenClawTestState({ label: "onboarding-recommendations" }, (state) =>
      run(storeFor(state), state),
    ),
  );
}

function writeOffer(
  store: ReturnType<typeof storeFor>,
  overrides: Partial<Parameters<typeof store.writeOffer>[0]> = {},
) {
  return store.writeOffer({
    inventory: [{ label: "Chat" }],
    matches,
    answered: false,
    ...overrides,
  });
}

afterEach(() => closeOpenClawStateDatabaseForTest());

test("confines worker writes and deletion to the onboarding namespace", async (_store, state) => {
  const options = { env: state.env };
  const credentials = {
    version: 1,
    profiles: { synthetic: { type: "api_key", provider: "synthetic", key: "synthetic-key" } },
  };
  writeConfigMachineState("authProfiles.store", credentials, options);
  const context = captureOpenClawStateWorkerContext(options);
  const read = (key: string) => readConfigMachineStateWithMetadata(key, options)?.value;
  // A raw key from a retained caller must not override the worker's namespace.
  const input = {
    workspaceKey: "authProfiles.store",
    configKey: "authProfiles.store",
    params: { inventoryHash: "synthetic", matches: [], answered: false, nowMs: 1 },
  };
  await executeOpenClawStateWorker(context, {
    type: "onboardingRecommendations.writeOffer",
    input,
  });
  expect(read("authProfiles.store")).toEqual(credentials);
  expect(read("onboarding.recommendations.authProfiles.store")).toMatchObject({
    inventoryHash: "synthetic",
    offeredAt: 1,
  });
  expect(
    await executeOpenClawStateWorker(context, {
      type: "onboardingRecommendations.clear",
      input,
    }),
  ).toBe(true);
  expect(read("authProfiles.store")).toEqual(credentials);
});

test("captures the database and offer before asynchronous admission", async (_store, state) => {
  const originalPath = state.statePath("state", "openclaw.sqlite");
  const replacementPath = state.statePath("replacement.sqlite");
  const database = { env: state.env, path: originalPath };
  const store = createOnboardingRecommendationsStore({
    workspaceDir: state.workspaceDir,
    database,
  });
  const offer = {
    inventory: [{ label: "Chat" }],
    matches: structuredClone(matches),
    answered: false,
    nowMs: 1_234,
  };
  const writing = store.writeOffer(offer);
  database.path = replacementPath;
  offer.matches[0]!.reason = "Changed after admission";
  offer.nowMs = 5_678;
  const written = await writing;
  expect(written).toMatchObject({ matches, offeredAt: 1_234, updatedAt: 1_234 });
  expect(await store.read()).toBeNull();
  expect(fs.existsSync(replacementPath)).toBe(false);
  await closeOpenClawStateDatabaseAsync();
  const reopened = createOnboardingRecommendationsStore({
    workspaceDir: state.workspaceDir,
    database: { env: state.env, path: originalPath },
  });
  expect(await reopened.read()).toEqual(written);
});

test("isolates offers by workspace", async (_store, state) => {
  const workspaceA = storeFor(state, state.path("workspace-a"));
  const workspaceB = storeFor(state, state.path("workspace-b"));

  const written = await writeOffer(workspaceA, { nowMs: 1_234 });

  expect(await workspaceB.read()).toBeNull();
  expect(await workspaceB.acknowledge({ nowMs: 2_345 })).toBeNull();
  expect(await workspaceA.read()).toEqual(written);
});

test("round-trips the workspace offer and answer timestamps", async (store, state) => {
  const inventory = [{ label: "Chat", bundleId: "com.example.chat" }];
  expect(await store.read()).toBeNull();
  expect(fs.existsSync(state.statePath("state", "openclaw.sqlite"))).toBe(false);
  const written = await writeOffer(store, { inventory, answered: true, nowMs: 1_234 });
  expect(written).toEqual({
    inventoryHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
    matches,
    offeredAt: 1_234,
    acceptedAt: 1_234,
    updatedAt: 1_234,
  });
  expect(await store.read()).toEqual(written);
  const staleCompletion = await writeOffer(store, {
    inventory: [{ label: "Different" }],
    matches: [],
    nowMs: 2_000,
  });
  expect(staleCompletion).toEqual(written);
});

test("updates pending matches without changing the inventory identity", async (store) => {
  const record = await writeOffer(store, {
    inventory: [{ label: "Chat" }, { label: "Notes" }],
    nowMs: 2_000,
  });
  const retryMatch = { ...matches[0]!, reason: "Retry this install" };
  const updated = await store.updatePending({
    matches: [retryMatch],
    expected: record,
    nowMs: 3_000,
  });
  expect(updated).toEqual({ ...record, matches: [retryMatch], updatedAt: 3_000 });
});

test("does not overwrite a concurrently replaced pending offer", async (store) => {
  const original = await writeOffer(store, { nowMs: 2_000 });
  const replacement = await writeOffer(store, {
    inventory: [{ label: "Notes" }],
    matches: [],
    nowMs: 2_500,
  });
  expect(await store.updatePending({ matches, expected: original, nowMs: 3_000 })).toBeNull();
  expect(await store.acknowledge({ expected: original, nowMs: 3_000 })).toBeNull();
  expect(await store.read()).toEqual(replacement);
});

test("clears only pending offers", async (store) => {
  const pending = await writeOffer(store);
  expect(await store.clearPending({ expected: pending })).toBe(true);
  expect(await store.read()).toBeNull();
  const accepted = await writeOffer(store, { answered: true });
  expect(await store.clearPending({ expected: accepted })).toBe(false);
  expect((await store.read())?.acceptedAt).toBeTypeOf("number");
});

test("deletes the stored offer so recommendations can be scanned again", async (store) => {
  await writeOffer(store, { answered: true, nowMs: 4_567 });
  expect(await store.clear()).toBe(true);
  expect(await store.read()).toBeNull();
  expect(await store.clear()).toBe(false);
});
