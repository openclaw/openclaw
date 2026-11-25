import { createHash, randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as workerAdmission from "../../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe } from "../../infra/sqlite-worker-owner-probe.test-support.js";
import { isSecretValueRegisteredForRedaction as isRegistered } from "../../logging/secret-redaction-registry.js";
import { resetSecretRedactionRegistryForTest } from "../../logging/secret-redaction-registry.test-support.js";
import {
  closeOpenClawStateDatabaseAsync as closeDatabase,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { createTemplateDraft, readTemplateDraft } from "../../templates/draft.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import {
  readPersonalTemplateClawHubToken as read,
  savePersonalTemplateClawHubToken as save,
} from "./secret-store-clawhub-template.js";
import {
  listSecretStoreEntries,
  readSecretStoreExecEnvironment,
  readSecretStoreValue,
  subscribeSecretStoreChanges,
  writeSecretStoreEntry,
} from "./secret-store.js";

const target = { profileId: "fixture-person", baseUrl: "https://registry.example/first" };
const scope = { kind: "team" } as const;
let state: OpenClawTestState;

beforeEach(async () => {
  state = await createOpenClawTestState({ prefix: "template-credential-", applyEnv: true });
});
afterEach(async () => {
  vi.restoreAllMocks();
  resetSecretRedactionRegistryForTest();
  await closeDatabase();
  await state.cleanup();
});

it("reads a persisted identity credential only for its person and full registry URL", async () => {
  const value = randomUUID();
  const name = "clawhub-template:" + createHash("sha256").update(target.baseUrl).digest("hex");
  openOpenClawStateDatabase()
    .db.prepare(
      "INSERT INTO secret_store_entries (scope_kind, scope_id, name, kind, value, created_at_ms, updated_at_ms) VALUES ('identity', ?, ?, 'secret', ?, 1, 1)",
    )
    .run(target.profileId, name, value);
  await closeDatabase();
  expect((await read(target)) === value).toBe(true);
  expect(isRegistered(value)).toBe(true);
  expect((await read({ ...target, profileId: "other" })) === undefined).toBe(true);
  expect(
    (await read({ ...target, baseUrl: "https://registry.example/second" })) === undefined,
  ).toBe(true);
});

it("keeps personal sign-in across reopen without changing existing drafts or exporting team aliases", async () => {
  const teamValue = randomUUID();
  await writeSecretStoreEntry({
    scope,
    name: "EXISTING",
    kind: "secret",
    value: teamValue,
    updatedBy: "fixture",
  });
  const { draftId } = await createTemplateDraft(state.workspaceDir);
  const draft = await readTemplateDraft(state.workspaceDir, draftId);
  const events = vi.fn();
  const unsubscribe = subscribeSecretStoreChanges(events);
  const credentials = [
    target,
    { ...target, profileId: "other" },
    { ...target, baseUrl: "https://registry.example/second" },
  ].map((owner) => ({ owner, value: randomUUID() }));
  try {
    for (const { owner, value } of credentials) {
      await save({ ...owner, assertCurrent: () => {} }, value);
      expect(isRegistered(value)).toBe(true);
    }
    expect(events).not.toHaveBeenCalled();
  } finally {
    unsubscribe();
  }
  await closeDatabase();
  resetSecretRedactionRegistryForTest();
  expect((await listSecretStoreEntries({ scope })).map(({ name }) => name)).toEqual(["EXISTING"]);
  const exported = await readSecretStoreExecEnvironment({ includeSecretSentinels: true });
  expect(Object.keys(exported.secretSentinels ?? {})).toEqual(["EXISTING"]);
  const team = await readSecretStoreValue({ scope, name: "EXISTING" });
  expect(team.ok && team.value === teamValue).toBe(true);
  for (const { owner, value } of credentials) {
    expect(isRegistered(value)).toBe(false);
    expect((await read(owner)) === value).toBe(true);
    expect(isRegistered(value)).toBe(true);
  }
  expect((await readTemplateDraft(state.workspaceDir, draftId)).revision).toBe(draft.revision);
});

it("rolls back a credential replacement when the original caller loses authority at commit", async () => {
  const original = randomUUID();
  await save({ ...target, assertCurrent: () => {} }, original);
  let current = true;
  const stages: string[] = [];
  sqliteWorkerOwnerProbe.admission(workerAdmission, (request, grant, admit) => {
    stages.push(request.stage);
    if (request.stage === "commit") {
      current = false;
    }
    admit(request, grant);
  });
  const caller = {
    ...target,
    assertCurrent: () => {
      if (!current) {
        throw new Error("Synthetic caller revoked");
      }
    },
  };
  const replacement = save(caller, randomUUID());
  caller.assertCurrent = () => {};
  await expect(replacement).rejects.toThrow("Synthetic caller revoked");
  expect(stages).toEqual(["transaction", "commit"]);
  await closeDatabase();
  expect((await read(target)) === original).toBe(true);
});
