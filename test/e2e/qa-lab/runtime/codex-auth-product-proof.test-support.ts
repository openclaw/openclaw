import fs from "node:fs/promises";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect } from "vitest";
import { loadPersistedSharedAuthProfileStore } from "../../../../src/agents/auth-profiles/persisted.js";
import type { OpenClawTestInstance } from "../../../helpers/openclaw-test-instance.js";

const OAUTH_PROFILE_ID = "openai:qa-oauth";
const LEGACY_OAUTH_PROFILE_ID = "openai-codex:qa-oauth";
const API_KEY_PROFILE_ID = "openai:media-api";

export type CodexAuthMigrationShape = "mixed" | "oauth-only";

export async function runCodexAuthDoctorMigrationProof(
  instance: OpenClawTestInstance,
  params: {
    accountId: string;
    oauthAccess: string;
    shape: CodexAuthMigrationShape;
  },
) {
  const includeApiKey = params.shape === "mixed";
  const expectedOrder = includeApiKey ? [OAUTH_PROFILE_ID, API_KEY_PROFILE_ID] : [OAUTH_PROFILE_ID];
  const profiles: Record<string, Record<string, unknown>> = {
    [LEGACY_OAUTH_PROFILE_ID]: {
      type: "oauth",
      provider: "openai-codex",
      access: params.oauthAccess,
      refresh: "test-refresh",
      expires: Date.UTC(2036, 0, 1),
      accountId: params.accountId,
    },
  };
  const order: Record<string, string[]> = {
    "openai-codex": [LEGACY_OAUTH_PROFILE_ID],
  };
  if (includeApiKey) {
    profiles[API_KEY_PROFILE_ID] = {
      type: "api_key",
      provider: "openai",
      key: "test-api-key",
    };
    order.openai = [API_KEY_PROFILE_ID];
  }

  const legacyAuthPath = await instance.state.writeText(
    "agents/main/agent/auth-profiles.json",
    `${JSON.stringify({ version: 1, profiles, order }, null, 2)}\n`,
  );
  const doctor = await instance.cli(["doctor", "--fix", "--yes", "--non-interactive"], {
    timeoutMs: 120_000,
  });
  expect(doctor.code, doctor.stderr).toBe(0);

  const canonicalStore = loadPersistedSharedAuthProfileStore(instance.env);
  const expectedProfiles: Record<string, Record<string, unknown>> = {
    [OAUTH_PROFILE_ID]: {
      type: "oauth",
      provider: "openai",
      access: params.oauthAccess,
      refresh: "test-refresh",
      expires: Date.UTC(2036, 0, 1),
      accountId: params.accountId,
    },
  };
  if (includeApiKey) {
    expectedProfiles[API_KEY_PROFILE_ID] = { type: "api_key", provider: "openai" };
  }
  expect(canonicalStore).toMatchObject({
    profiles: expectedProfiles,
    order: { openai: expectedOrder },
  });
  expect(canonicalStore?.profiles[LEGACY_OAUTH_PROFILE_ID]).toBeUndefined();
  await expect(fs.access(legacyAuthPath)).rejects.toMatchObject({ code: "ENOENT" });
  return canonicalStore;
}

export type CodexFixtureTurnAccountEvidence = {
  instanceId: string;
  threadId: string;
  turnId: string;
  threadOperation: "thread_started" | "thread_resumed";
  threadSequence: number;
  startedSequence: number;
  completedSequence: number;
  account: { type: "chatgptAuthTokens"; accountId: string };
};

export function findCodexFixtureTurnAccountEvidence(
  entries: readonly unknown[],
  params: { afterIndex: number; threadId: string; accountId: string },
): CodexFixtureTurnAccountEvidence | undefined {
  if (
    !Number.isSafeInteger(params.afterIndex) ||
    params.afterIndex < 0 ||
    params.afterIndex > entries.length ||
    !params.threadId.trim() ||
    !params.accountId.trim()
  ) {
    return undefined;
  }
  const operations = entries.flatMap((entry, index) =>
    isRecord(entry) && isRecord(entry.fixtureAuthOperation)
      ? [{ index, value: entry.fixtureAuthOperation }]
      : [],
  );
  const turns = operations.filter(
    ({ index, value }) =>
      index >= params.afterIndex &&
      value.threadId === params.threadId &&
      (value.operation === "turn_started" || value.operation === "turn_completed"),
  );
  const started = turns[0];
  const completed = turns[1];
  if (turns.length !== 2 || !started || !completed) {
    return undefined;
  }
  if (
    started.value.operation !== "turn_started" ||
    completed.value.operation !== "turn_completed" ||
    started.value.version !== 1 ||
    completed.value.version !== 1 ||
    typeof started.value.instanceId !== "string" ||
    !started.value.instanceId.trim() ||
    completed.value.instanceId !== started.value.instanceId ||
    typeof started.value.turnId !== "string" ||
    !started.value.turnId.trim() ||
    completed.value.turnId !== started.value.turnId ||
    typeof started.value.sequence !== "number" ||
    !Number.isSafeInteger(started.value.sequence) ||
    started.value.sequence <= 0 ||
    typeof completed.value.sequence !== "number" ||
    !Number.isSafeInteger(completed.value.sequence) ||
    completed.value.sequence <= started.value.sequence ||
    !isRecord(started.value.account) ||
    started.value.account.type !== "chatgptAuthTokens" ||
    started.value.account.accountId !== params.accountId ||
    !isRecord(completed.value.account) ||
    completed.value.account.type !== "chatgptAuthTokens" ||
    completed.value.account.accountId !== params.accountId
  ) {
    return undefined;
  }
  // A warm thread can predate this control; only its new turn must follow the cursor.
  const thread = operations.findLast(
    ({ index, value }) =>
      index < started.index &&
      value.instanceId === started.value.instanceId &&
      value.threadId === params.threadId &&
      (value.operation === "thread_started" || value.operation === "thread_resumed"),
  )?.value;
  if (
    !thread ||
    thread.version !== 1 ||
    typeof thread.sequence !== "number" ||
    !Number.isSafeInteger(thread.sequence) ||
    thread.sequence <= 0 ||
    thread.sequence >= started.value.sequence
  ) {
    return undefined;
  }
  return {
    instanceId: started.value.instanceId,
    threadId: params.threadId,
    turnId: started.value.turnId,
    threadOperation: thread.operation as "thread_started" | "thread_resumed",
    threadSequence: thread.sequence,
    startedSequence: started.value.sequence,
    completedSequence: completed.value.sequence,
    account: { type: "chatgptAuthTokens", accountId: started.value.account.accountId },
  };
}
