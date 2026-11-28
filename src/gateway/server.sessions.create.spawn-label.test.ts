import { expect, test } from "vitest";
import type { SessionEntry } from "../config/sessions.js";
import { createSyntheticPluginRuntimeClient } from "./server-plugin-runtime-client.js";
import { setupSessionCreateHandlerTestHarness } from "./server.sessions.create.test-support.js";
import type { TrustedSessionCreation } from "./session-creation-provenance.js";
import { writeSessionStore } from "./test-helpers.js";
import { directSessionReq, sessionStoreEntry } from "./test/server-sessions.test-helpers.js";

const { createSessionStoreDir } = setupSessionCreateHandlerTestHarness();

type CreatedSessionPayload = { key?: string; entry?: SessionEntry };
const parents = [
  "agent:main:dashboard:first-coordinator",
  "agent:main:dashboard:second-coordinator",
];

async function seedParents() {
  await createSessionStoreDir();
  await writeSessionStore({
    entries: Object.fromEntries(
      parents.map((key, index) => [key, sessionStoreEntry(`sess-coordinator-${index}`)]),
    ),
  });
}

function spawnChild(parentSessionKey: string, creation: Partial<TrustedSessionCreation> = {}) {
  return directSessionReq<CreatedSessionPayload>(
    "sessions.create",
    { agentId: "main", label: "r1", parentSessionKey, spawnDepth: 1 },
    {
      client: createSyntheticPluginRuntimeClient({
        scopes: ["operator.write"],
        operatorRoleActor: { kind: "system" },
        sessionCreation: {
          via: "spawn",
          actor: { type: "agent", id: "main" },
          requesterSessionKey: parentSessionKey,
          inheritedToolPolicy: { version: 1, allow: ["read"], deny: [] },
          ...creation,
        },
      }),
    },
  );
}

test("sessions.create stores trusted unclaimed spawn labels that each parent resolves", async () => {
  await seedParents();
  const childKeys: string[] = [];
  for (const parentSessionKey of parents) {
    const created = await spawnChild(parentSessionKey, { unclaimedLabel: true });
    expect(created.ok, JSON.stringify(created.error)).toBe(true);
    expect(created.payload?.entry).toMatchObject({ label: "r1", spawnedBy: parentSessionKey });
    childKeys.push(String(created.payload?.key));
  }
  for (const [index, parentSessionKey] of parents.entries()) {
    const resolved = await directSessionReq("sessions.resolve", {
      label: "r1",
      spawnedBy: parentSessionKey,
    });
    expect(resolved).toMatchObject({ ok: true, payload: { key: childKeys[index] } });
  }

  const unscoped = await directSessionReq("sessions.resolve", { label: "r1" });
  expect(unscoped.ok).toBe(false);
  expect(unscoped.error?.message).toMatch(/^Multiple sessions found with label: r1 /);
  for (const key of childKeys) {
    expect(unscoped.error?.message).toContain(key);
  }

  expect(await directSessionReq("sessions.create", { agentId: "main", label: "r1" })).toMatchObject(
    { ok: false, error: { code: "INVALID_REQUEST", message: "label already in use: r1" } },
  );
});

test("sessions.create still claims spawn labels without the trusted flag", async () => {
  await seedParents();
  const [first, second] = parents;
  expect((await spawnChild(first)).ok).toBe(true);
  expect(await spawnChild(second)).toMatchObject({
    ok: false,
    error: { code: "INVALID_REQUEST", message: "label already in use: r1" },
  });
});

test("sessions.create claims the label when a non-spawn creation carries the flag", async () => {
  await seedParents();
  const [first, second] = parents;
  expect((await spawnChild(first, { unclaimedLabel: true })).ok).toBe(true);
  const agentRun = await spawnChild(second, {
    via: "run",
    requesterSessionKey: undefined,
    inheritedToolPolicy: undefined,
    unclaimedLabel: true,
  });
  expect(agentRun).toMatchObject({
    ok: false,
    error: { code: "INVALID_REQUEST", message: "label already in use: r1" },
  });
});

test("sessions.create rejects unclaimedLabel from wire arguments", async () => {
  await seedParents();
  const fromWire = await directSessionReq("sessions.create", {
    agentId: "main",
    label: "wire-title",
    unclaimedLabel: true,
  });
  expect(fromWire).toMatchObject({
    ok: false,
    error: { code: "INVALID_REQUEST", message: expect.stringContaining("unclaimedLabel") },
  });
});
