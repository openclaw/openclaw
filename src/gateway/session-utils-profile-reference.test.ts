import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SessionsListParams } from "../../packages/gateway-protocol/src/index.js";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { SessionEntry } from "../config/sessions.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { linkEmail } from "../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import type { GatewayClient } from "./server-methods/types.js";
import { listSessionFixture } from "./session-list.test-support.js";
import { createSessionListEntryFilter } from "./session-sharing.js";

const roots = createTempDirTracker();
const original = "12345678-a123-4123-8123-123456789abc";
const other = "12345678-a123-4123-8123-123456789def";
const prefix = "12345678a123";
const emptySearch = { search: "no-matching-session" };
const participant = (id: string) => ({
  participants: [{ identity: { type: "profile" as const, id } }],
});
const creator = (id: string, source: "profile" | "channel" = "profile") => ({
  type: "human" as const,
  id,
  source,
});
const visibleTo = (profileId: string) =>
  createSessionListEntryFilter({
    client: {
      connect: { scopes: ["operator.read"] },
      authenticatedUserProfile: { profileId },
    } as GatewayClient,
  });
let stateRoot: string;
beforeEach(() => {
  stateRoot = roots.make("activity-profile-reference-");
  vi.stubEnv("OPENCLAW_STATE_DIR", stateRoot);
});
afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.unstubAllEnvs();
  roots.cleanup();
});

function createProfile(id: string): void {
  const profile = ensureProfileForEmail(`${id}@activity.test`);
  const { db } = openOpenClawStateDatabase();
  // Deterministic IDs exercise real prefix collisions without weakening the UUID producer.
  db.prepare("UPDATE user_profiles SET id = ? WHERE id = ?").run(id, profile.id);
  db.prepare("UPDATE user_profile_emails SET profile_id = ? WHERE profile_id = ?").run(
    id,
    profile.id,
  );
}

function listSessions(
  entries: Record<string, Partial<SessionEntry>>,
  opts: SessionsListParams,
  entryFilter?: Parameters<typeof listSessionFixture>[0]["entryFilter"],
) {
  return listSessionFixture({
    cfg: {},
    storePath: stateRoot,
    opts,
    entryFilter,
    store: Object.fromEntries(
      Object.entries(entries).map(([id, entry]) => [
        `agent:main:${id}`,
        { sessionId: id, updatedAt: Date.now(), ...entry },
      ]),
    ),
  });
}

function listActivity(
  profileIds: string[],
  involvingProfileId: string,
  options: Partial<SessionsListParams> = {},
) {
  return listSessions(
    Object.fromEntries(profileIds.map((id, index) => [`activity-${index}`, participant(id)])),
    { includePeople: true, involvingProfileId, ...options },
  );
}

it("resolves inventory relationships through profile merges", async () => {
  const current = "87654321-c123-4123-8123-123456789abc";
  createProfile(original);
  createProfile(current);
  linkEmail(original + "@activity.test", current);
  for (const profileId of [original, current]) {
    const result = await listSessions(
      {
        "merged-profile": {
          updatedAt: 1,
          createdActor: creator(original),
          owner: { actor: { type: "human", id: original } },
          ...participant(original),
        },
      },
      {
        profileRelation: { profileId, relationship: "owned" },
        ownerId: original,
      },
    );
    expect(result.sessions.map((row) => row.sessionId)).toEqual(["merged-profile"]);
    expect(result.sessions[0]?.createdActor?.id).toBe(original);
  }
});

it("resolves retained profile without a durable row", async () => {
  const retained = original.toUpperCase();
  for (const reference of [retained, prefix, retained.replaceAll("-", "").toLowerCase()]) {
    const result = await listActivity([retained], reference);
    expect(result.involvingProfileId, reference).toBe(retained);
    expect(result.sessions, reference).toHaveLength(1);
    const empty = await listActivity([retained], reference, emptySearch);
    expect(empty.involvingProfileId, reference).toBe(retained);
    expect(empty.sessions, reference).toEqual([]);
  }
  expect(fs.existsSync(path.join(stateRoot, "state", "openclaw.sqlite"))).toBe(false);
  createProfile(other);
  await expect(listActivity([retained], prefix, emptySearch)).rejects.toThrow(
    "Person link is ambiguous",
  );
});

it("resolves qualified retained creators without treating legacy human IDs as profiles", async () => {
  const result = await listSessions(
    {
      qualified: { createdActor: creator(original) },
      legacy: { createdActor: creator(other, "channel") },
    },
    { includePeople: true, involvingProfileId: prefix },
  );
  expect(result.involvingProfileId).toBe(original);
  expect(result.sessions.map((row) => row.key)).toEqual(["agent:main:qualified"]);
});

it("leaves missing and invalid person references unresolved without creating profile storage", async () => {
  for (const reference of ["12345678", "unknown-person"]) {
    const result = await listActivity([], reference);
    expect(result.involvingProfileId).toBeUndefined();
    expect(result.sessions).toEqual([]);
  }
  expect(fs.existsSync(path.join(stateRoot, "state", "openclaw.sqlite"))).toBe(false);
});

it.each([
  { hidden: "draft", durable: false },
  { hidden: "incognito", durable: false },
  { hidden: "draft", durable: true },
  { hidden: "incognito", durable: true },
])("does not resolve hidden $hidden identities (durable=$durable)", async ({ hidden, durable }) => {
  const visibleId = original;
  const hiddenId = other;
  createProfile(visibleId);
  if (durable) {
    createProfile(hiddenId);
  }
  const entryFilter = visibleTo(visibleId);
  const store = {
    visible: { visibility: "shared", ...participant(visibleId) },
    hidden: {
      visibility: hidden === "draft" ? "draft" : "shared",
      incognito: hidden === "incognito" ? true : undefined,
      ...participant(hiddenId),
    },
  } satisfies Record<string, Partial<SessionEntry>>;
  for (const reference of [prefix, hiddenId, hiddenId.replaceAll("-", "")]) {
    const result = await listSessions(
      store,
      { includePeople: true, involvingProfileId: reference, ...emptySearch },
      entryFilter,
    );
    expect(result, reference).toMatchObject({
      involvingProfileId: reference === prefix ? visibleId : undefined,
      sessions: [],
      people: [],
    });
  }
});

it("resolves merge aliases for visible owners without considering hidden profiles", async () => {
  const source = original;
  const hidden = other;
  const target = "87654321-a123-4123-8123-123456789abc";
  for (const id of [source, hidden, target]) {
    createProfile(id);
  }
  linkEmail(`${source}@activity.test`, target);
  const entryFilter = visibleTo(target);
  const result = await listSessions(
    {
      owned: {
        visibility: "shared",
        owner: { actor: { type: "human", id: target } },
      },
      hidden: { visibility: "draft", ...participant(hidden) },
    },
    { includePeople: true, involvingProfileId: prefix },
    entryFilter,
  );
  expect(result.involvingProfileId).toBe(target);
  expect(result.sessions.map((row) => row.key)).toEqual(["agent:main:owned"]);
});
