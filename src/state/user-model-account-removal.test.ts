import { beforeEach, expect, it } from "vitest";
import type { AuthProfileCredential } from "../agents/auth-profiles/types.js";
import { openOpenClawStateDatabase } from "./openclaw-state-db.js";
import {
  connectUserModelAccount,
  listUserModelAccounts,
  listUserProfileAuthLinks,
  readSelectedUserModelAccount,
  readUserModelAccountSummary,
  readUserModelAuthProfile,
  removeUserModelAccount,
  updateUserModelAuthProfile,
} from "./user-model-accounts.js";
import { mergeProfiles } from "./user-profile-writes.worker.js";
import { ensureProfileForEmail } from "./user-profiles.js";
import { useUserStateFixture } from "./user-state.test-support.js";

type RemovalStage = "transaction" | "commit";

const stateOptions = useUserStateFixture("user-model-account-removal-");
let options: ReturnType<typeof stateOptions>;
beforeEach(() => {
  options = stateOptions();
});

const tokenCredential = (token = "synthetic-personal-token", provider = "anthropic") =>
  ({ type: "token", provider, token }) satisfies AuthProfileCredential;

function secretRowCount(scopeId: string, name: string): number {
  const { db } = openOpenClawStateDatabase(options);
  const row = db
    .prepare(
      `SELECT COUNT(*) AS count FROM secret_store_entries
      WHERE scope_kind = 'identity' AND scope_id = ? AND name = ?`,
    )
    .get(scopeId, name) as { count: number };
  return row.count;
}

function readLinksRecord(profileId: string): { links: Record<string, unknown> } {
  const { db } = openOpenClawStateDatabase(options);
  const row = db
    .prepare(
      `SELECT value FROM secret_store_entries
      WHERE scope_kind = 'identity' AND scope_id = ? AND name = 'model-accounts'`,
    )
    .get(profileId) as { value: string } | undefined;
  return row === undefined
    ? { links: {} }
    : (JSON.parse(row.value) as { links: Record<string, unknown> });
}

function owner(email = "alice@example.test") {
  const { id } = ensureProfileForEmail(email, options);
  return {
    id,
    connect: (credential: AuthProfileCredential) =>
      connectUserModelAccount({ ownerProfileId: id, credential, assertCurrent: () => {} }, options),
    remove: (authProfileId: string, assertCurrent: (stage: RemovalStage) => void = () => {}) =>
      removeUserModelAccount({ profileId: id, authProfileId, assertCurrent }, options),
    accounts: () => listUserModelAccounts({ profileId: id }, options).accounts,
    links: () => listUserProfileAuthLinks(id, options),
    selected: (provider: string) => readSelectedUserModelAccount(id, provider, options),
    summary: (authProfileId: string) =>
      readUserModelAccountSummary({ profileId: id, authProfileId }, options),
    credential: (authProfileId: string) => readUserModelAuthProfile(authProfileId, options),
    refresh: (authProfileId: string) =>
      updateUserModelAuthProfile(
        authProfileId,
        (profile) => {
          if (profile.credential.type !== "token") {
            return false;
          }
          profile.credential.token = "synthetic-late-refresh-token";
          return true;
        },
        options,
      ),
  };
}

it("removes a selected account, clears its exact link, and deletes the secret row", () => {
  const alice = owner();
  const anthropicId = alice.connect(tokenCredential()).authProfileId;
  const openaiCredential = tokenCredential("synthetic-openai-token", "openai");
  const openaiId = alice.connect(openaiCredential).authProfileId;
  expect(secretRowCount(alice.id, `model-account:${anthropicId}`)).toBe(1);
  const result = alice.remove(anthropicId);
  expect(result).toEqual({
    removed: true,
    provider: "anthropic",
    links: [{ provider: "openai", authProfileId: openaiId, updatedAt: expect.any(Number) }],
  });
  expect(secretRowCount(alice.id, `model-account:${anthropicId}`)).toBe(0);
  expect(secretRowCount(alice.id, `model-account:${openaiId}`)).toBe(1);
  expect(readLinksRecord(alice.id).links.anthropic).toBe(null);
  expect(readLinksRecord(alice.id).links.openai).toEqual({
    authProfileId: openaiId,
    updatedAt: expect.any(Number),
  });
  expect(alice.accounts().map((account) => account.authProfileId)).toEqual([openaiId]);
  expect(alice.selected("anthropic")).toBeUndefined();
  expect(alice.credential(anthropicId)).toBeUndefined();
});

it("removes an unselected account while preserving the newer selected default", () => {
  const alice = owner();
  const staleCredential = tokenCredential("synthetic-first-token", "openai");
  const stale = alice.connect(staleCredential).authProfileId;
  const currentCredential = tokenCredential("synthetic-second-token", "openai");
  const current = alice.connect(currentCredential).authProfileId;
  expect(stale).not.toBe(current);
  const result = alice.remove(stale);
  expect(result).toEqual({
    removed: true,
    provider: "openai",
    links: [{ provider: "openai", authProfileId: current, updatedAt: expect.any(Number) }],
  });
  expect(alice.selected("openai")).toEqual({
    id: current,
    credential: currentCredential,
  });
  expect(secretRowCount(alice.id, `model-account:${stale}`)).toBe(0);
  expect(secretRowCount(alice.id, `model-account:${current}`)).toBe(1);
  expect(readLinksRecord(alice.id).links.openai).toEqual({
    authProfileId: current,
    updatedAt: expect.any(Number),
  });
});

it("accepts an idempotent retry once the credential row is already absent", () => {
  const alice = owner();
  const { authProfileId } = alice.connect(tokenCredential());
  expect(alice.remove(authProfileId).removed).toBe(true);
  const retry = alice.remove(authProfileId);
  expect(retry).toEqual({ removed: false, links: [] });
  expect(alice.accounts()).toEqual([]);
  expect(alice.links()).toEqual([]);
  expect(secretRowCount(alice.id, `model-account:${authProfileId}`)).toBe(0);
});

it("rejects shared identifiers and personal accounts owned by another profile", () => {
  const alice = owner();
  const bob = owner("bob@example.test");
  const { authProfileId } = bob.connect(tokenCredential("synthetic-bob-token"));
  expect(() => alice.remove(authProfileId)).toThrow(/does not belong to this profile/);
  expect(() => alice.remove("shared:acme:assistant")).toThrow(/does not belong to this profile/);
  expect(secretRowCount(bob.id, `model-account:${authProfileId}`)).toBe(1);
  expect(bob.remove(authProfileId).removed).toBe(true);
});

it("rolls back the deletion and the link clear when commit admission fails", () => {
  const alice = owner();
  const { authProfileId } = alice.connect(tokenCredential());
  const stages: RemovalStage[] = [];
  const assertCurrent = (stage: RemovalStage) => {
    stages.push(stage);
    if (stage === "commit") {
      throw new Error("synthetic stale caller at commit");
    }
  };
  expect(() => alice.remove(authProfileId, assertCurrent)).toThrow(
    "synthetic stale caller at commit",
  );
  expect(stages).toEqual(["transaction", "commit"]);
  expect(secretRowCount(alice.id, `model-account:${authProfileId}`)).toBe(1);
  expect(readLinksRecord(alice.id).links.anthropic).toEqual({
    authProfileId,
    updatedAt: expect.any(Number),
  });
  expect(alice.selected("anthropic")?.id).toBe(authProfileId);
  expect(alice.accounts()).toHaveLength(1);
  expect(alice.remove(authProfileId).removed).toBe(true);
});

it("returns false from a late refresh and never resurrects the deleted row", () => {
  const alice = owner();
  const { authProfileId } = alice.connect(tokenCredential("synthetic-initial-token"));
  expect(alice.remove(authProfileId).removed).toBe(true);
  expect(alice.refresh(authProfileId)).toBe(false);
  expect(secretRowCount(alice.id, `model-account:${authProfileId}`)).toBe(0);
  expect(alice.summary(authProfileId)).toBeUndefined();
  expect(alice.credential(authProfileId)).toBeUndefined();
  expect(alice.accounts()).toEqual([]);
});

it("allows the canonical owner to remove a merged alias account but rejects the stale caller", () => {
  const source = owner("source@example.test");
  const target = owner("target@example.test");
  const id = source.connect(tokenCredential()).authProfileId;
  mergeProfiles(source.id, target.id, options);
  expect(() => source.remove(id)).toThrow(/owner changed/);
  expect(target.credential(id)).toBeDefined();
  expect(target.remove(id).removed).toBe(true);
  expect(secretRowCount(target.id, `model-account:${id}`)).toBe(0);
});
