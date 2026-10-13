import { expect, it } from "vitest";
import { inspectDatabaseWorkerBoundaries } from "../../scripts/lib/database-worker-compat.mts";

const accounts = "src/state/user-model-accounts.ts";
const owner = `
  export function updateUserModelAuthProfile() {}
  export function connectUserModelAccount() {}
  export function renameUserProfileAuthLinks() {}
  export function mergeUserModelAccounts() {}
  export function setUserProfileAuthLink() {}
  export function clearUserProfileAuthLink() {}
`;
function inspect(extra: Record<string, string>, source = owner) {
  return inspectDatabaseWorkerBoundaries(
    process.cwd(),
    new Map(Object.entries({ [accounts]: source, ...extra })),
  ).violations;
}

it("allows the exact credential worker operations and exclusive Doctor entry", () => {
  expect(
    inspect({
      "src/agents/auth-profiles/store.worker.ts": `
      import { updateUserModelAuthProfile as replace } from '../../state/user-model-accounts.js';
      export const operations = {
        'authProfiles.personalReplace': () => replace(),
        'authProfiles.personalUsage': () => replace(),
      };
    `,
      "src/state/user-profiles.worker.ts": `
      import { connectUserModelAccount } from './user-model-accounts.js';
      export const operations = {
        'userProfiles.modelAccount.connect': wrap(() => connectUserModelAccount()),
      };
    `,
      "src/commands/doctor-auth-flat-profiles.ts": `
      import { renameUserProfileAuthLinks } from '../state/user-model-accounts.js';
      export function maybeRepairLegacyAuthProfileStores() {
        const migrate = () => renameUserProfileAuthLinks();
        migrate();
      }
    `,
      "src/gateway/model-account-connect.ts": `
      import * as nativeAccounts from '../state/user-model-accounts.js';
      export function createModelAccountConnectService() {
        const setLinkNative = () => nativeAccounts.setUserProfileAuthLink();
        return {
          /** @deprecated Await linkAsync. */
          link() { setLinkNative(); },
          /** @deprecated Await unlinkAsync. */
          unlink() { nativeAccounts.clearUserProfileAuthLink(); },
        };
      }
    `,
    }),
  ).toEqual([]);
});

it.each([
  [
    "direct call",
    "import { connectUserModelAccount as write } from './state/user-model-accounts.js'; write();",
  ],
  [
    "namespace call",
    "import * as accounts from './state/user-model-accounts.js'; accounts.connectUserModelAccount();",
  ],
  [
    "computed member",
    "import * as accounts from './state/user-model-accounts.js'; accounts['connectUserModelAccount']();",
  ],
  [
    "writer escape",
    "import { connectUserModelAccount } from './state/user-model-accounts.js'; export const write = connectUserModelAccount;",
  ],
  [
    "namespace escape",
    "import * as accounts from './state/user-model-accounts.js'; export const writers = accounts;",
  ],
  [
    "barrel export",
    "export { connectUserModelAccount as write } from './state/user-model-accounts.js';",
  ],
  ["dynamic import", "const writers = await import('./state/user-model-accounts.js');"],
  ["wildcard export", "export * from './state/user-model-accounts.js';"],
  ["namespace export", "export * as accounts from './state/user-model-accounts.js';"],
])("rejects an unowned %s", (_name, consumer) => {
  expect(inspect({ "src/consumer.ts": consumer })).toEqual(
    expect.arrayContaining([
      expect.stringContaining("unreviewed personal credential writer reference"),
    ]),
  );
});

it("does not mistake worker naming or a sibling Doctor function for an approved entry", () => {
  expect(
    inspect({
      "src/agents/auth-profiles/store.worker.ts": `
      import { updateUserModelAuthProfile } from '../../state/user-model-accounts.js';
      export const operations = { 'new.writer': () => updateUserModelAuthProfile() };
    `,
      "src/commands/doctor-auth-flat-profiles.ts": `
      import { renameUserProfileAuthLinks } from '../state/user-model-accounts.js';
      export function newRepair() {
        const migrate = () => renameUserProfileAuthLinks();
        migrate();
      }
    `,
    }),
  ).toHaveLength(2);
});

it("checks internal sink helpers instead of exempting the owner file", () => {
  expect(
    inspect(
      {},
      `
    function writeRecord() {}
    function writeProfile() { writeRecord(); }
    export function bypass() { writeRecord(); }
  `,
    ),
  ).toEqual([expect.stringContaining(`from ${accounts}:bypass`)]);
});

it("rejects a new caller of the profile-merge participant", () => {
  expect(
    inspect({
      "src/state/user-profiles-merge.ts": `
      import { mergeUserModelAccounts } from './user-model-accounts.js';
      export function mergeUserProfiles() { mergeUserModelAccounts(); }
    `,
      "src/consumer.ts": `
      import { mergeUserProfiles } from './state/user-profiles-merge.js';
      mergeUserProfiles();
    `,
    }),
  ).toEqual([expect.stringContaining("user-profiles-merge.ts:mergeUserProfiles")]);
});

it("ignores type references and same-named unrelated functions", () => {
  expect(
    inspect({
      "src/consumer.ts": `
      import type { connectUserModelAccount } from './state/user-model-accounts.js';
      export type Connect = typeof connectUserModelAccount;
      export type { updateUserModelAuthProfile } from './state/user-model-accounts.js';
      function run(updateUserModelAuthProfile: () => void) { updateUserModelAuthProfile(); }
    `,
    }),
  ).toEqual([]);
});

it("permits a named reader re-export without exposing its sibling writers", () => {
  expect(
    inspect(
      {
        "src/consumer.ts": `
        export { listUserProfileAuthLinksAsync } from './state/user-model-accounts.js';
      `,
      },
      `${owner}\nexport function listUserProfileAuthLinksAsync() {}`,
    ),
  ).toEqual([]);
});

it("allows reviewed sinks but rejects added sinks even in their owner function", () => {
  const sink = `db.insertInto('secret_store_entries').values({ name: 'model-account:test' });`;
  expect(inspect({}, `function writeRecord() { ${sink} }`)).toEqual([]);
  expect(inspect({}, `function writeRecord() { ${sink} ${sink} }`)).toEqual([
    expect.stringContaining("unreviewed secret_store_entries writer"),
  ]);
  expect(inspect({ "src/new-writer.worker.ts": `function write() { ${sink} }` })).toEqual([
    expect.stringContaining("unreviewed secret_store_entries writer"),
  ]);
});

it.each([
  "const table = 'secret_store_entries'; db.deleteFrom(table);",
  "db.updateTable('secret_store_entries').set({ value: 'replacement' });",
  "db.exec('DELETE FROM secret_store_entries WHERE name = ?');",
  "db.exec(`UPDATE secret_store_entries SET value = 'replacement'`);",
  "db.exec(`UPDATE secret_store_entries SET value = ${replacement}`);",
])("rejects a newly introduced secret-store write: %s", (write) => {
  expect(inspect({ "src/new-writer.ts": `function write() { ${write} }` })).toHaveLength(1);
});

it("permits audited nonpersonal cleanup without granting a whole-file exemption", () => {
  const file = "src/secrets/store/secret-store-expiry.kernel.ts";
  const remove = "db.deleteFrom('secret_store_entries').where('deleted_at_ms', '<', cutoff);";
  expect(
    inspect({ [file]: `function purgeExpiredSecretStoreEntriesInDatabase() { ${remove} }` }),
  ).toEqual([]);
  expect(inspect({ [file]: `function newCleanup() { ${remove} }` })).toEqual([
    expect.stringContaining("unreviewed secret_store_entries writer"),
  ]);
});

it.each([
  "db.insertInto('auth_profile_store').values({ store_key: 'primary' });",
  "const table = 'auth_profile_store'; db.deleteFrom(table);",
  "db.exec('UPDATE auth_profile_store SET store_json = ? WHERE store_key = ?');",
  "db.insertInto('config_machine_state').values({ state_key: 'authProfiles.store' });",
  "const key = 'authProfiles.store'; db.deleteFrom('config_machine_state').where('state_key', '=', key);",
  "db.deleteFrom('config_machine_state').where('state_key', 'in', ['authProfiles.state', 'authProfiles.store']);",
  "db.updateTable('config_machine_state').set({ state_key: 'authProfiles.store' }).where('state_key', '=', 'other');",
  "db.exec('DELETE FROM config_machine_state WHERE state_key = ?');",
  "db.insertInto('config_machine_state').values({ state_key: unknownKey });",
])("rejects a synthetic shared or agent credential bypass: %s", (write) => {
  expect(inspect({ "src/new-writer.worker.ts": `function write() { ${write} }` })).toHaveLength(1);
});

it("permits bounded noncredential machine-state writes", () => {
  expect(
    inspect({
      "src/new-writer.worker.ts": `
      const unrelated = 'authProfiles.state';
      db.insertInto('config_machine_state').values({ state_key: unrelated });
      db.deleteFrom('config_machine_state').where('state_key', '=', unrelated);
    `,
    }),
  ).toEqual([]);
});

it("counts canonical auth sinks and transitional generic sinks without file exemptions", () => {
  const authCells = "src/agents/auth-profiles/sqlite-json-write.ts";
  const machineState = "src/state/config-machine-state-write.ts";
  const write = `db.insertInto('auth_profile_store');
    db.insertInto('config_machine_state').values({ state_key: 'authProfiles.store' });`;
  const sources = {
    [authCells]: `function writeAuthProfileJsonCell() { ${write} }`,
    [machineState]: `function upsertConfigMachineState(key: string) {
      db.insertInto('config_machine_state').values({ state_key: key });
    }`,
  };
  expect(inspect(sources)).toEqual([]);
  expect(
    inspect({
      ...sources,
      [authCells]: `${sources[authCells]} function bypass() { db.deleteFrom('auth_profile_store'); }`,
    }),
  ).toEqual([expect.stringContaining("unreviewed auth_profile_store writer")]);
  expect(
    inspect({
      ...sources,
      [authCells]: `function writeAuthProfileJsonCell() { ${write} db.deleteFrom('auth_profile_store'); }`,
    }),
  ).toEqual([expect.stringContaining("unreviewed auth_profile_store writer")]);
  expect(
    inspect({
      ...sources,
      [machineState]: `${sources[machineState]} function bypass() {
      db.deleteFrom('config_machine_state').where('state_key', '=', 'authProfiles.store');
    }`,
    }),
  ).toEqual([expect.stringContaining("unreviewed config_machine_state writer")]);
});

it("limits offline raw machine-state migration exceptions to their reviewed statements", () => {
  const file = "src/state/openclaw-state-db-schema-v12-foldin.ts";
  const statement = "INSERT INTO config_machine_state (state_key) VALUES (?)";
  const source = (sql: string) =>
    `function migrateSingletonStateFoldInV12() { db.exec('${sql}'); }`;
  expect(inspect({ [file]: source(statement) })).toEqual([]);
  for (const sql of [`${statement}; ${statement}`, "DELETE FROM auth_profile_store"]) {
    expect(inspect({ [file]: source(sql) })).toEqual([
      expect.stringContaining("raw authority-table write"),
    ]);
  }
});

const lifecycle = "src/state/github-publication-session-lifecycles.worker.ts";
const sharedPublication = "src/gateway/github-publication-store.worker.ts";
const publicationWorker = "src/state/github-publication.worker.ts";

it("permits publication inserts only through the reviewed request and lifecycle owners", () => {
  const sources = {
    [lifecycle]: `export function insertGitHubPublicationSessionLifecycle() {
      db.insertInto('github_publication_session_lifecycles');
    }`,
    [sharedPublication]: `
      import { insertGitHubPublicationSessionLifecycle } from '../state/github-publication-session-lifecycles.worker.js';
      export function insertGitHubPublicationRequest() {
        db.insertInto('github_publication_requests');
        insertGitHubPublicationSessionLifecycle();
      }
    `,
    "src/state/github-publication-request.worker.ts": `
      import { insertGitHubPublicationRequest } from '../gateway/github-publication-store.worker.js';
      export const operations = { 'githubPublications.insert': () => {
        const write = () => insertGitHubPublicationRequest();
        write();
      } };
    `,
  };
  expect(inspect(sources)).toEqual([]);
  expect(
    inspect({
      ...sources,
      "src/state/github-publication-request.worker.ts": sources[
        "src/state/github-publication-request.worker.ts"
      ].replace("githubPublications.insert", "githubPublications.bypass"),
    }),
  ).toEqual([expect.stringContaining("unreviewed GitHub publication writer reference")]);
  expect(
    inspect({
      ...sources,
      "src/new-writer.worker.ts": `
        import { insertGitHubPublicationSessionLifecycle as write } from './state/github-publication-session-lifecycles.worker.js';
        write();
      `,
    }),
  ).toEqual([expect.stringContaining("unreviewed GitHub publication writer reference")]);
});

it.each([
  "github_publication_requests",
  "github_personal_publication_requests",
  "github_repository_publication_requests",
  "github_publication_session_lifecycles",
])("rejects unowned native and raw publication writes to %s", (table) => {
  expect(
    inspect({
      "src/new-writer.worker.ts": `
        const table = '${table}';
        db.updateTable(table);
        db.exec('DELETE FROM ${table} WHERE request_id = ?');
      `,
    }),
  ).toEqual([
    expect.stringContaining(`unreviewed ${table} writer`),
    expect.stringContaining("raw authority-table write"),
  ]);
});

it("guards publication mutation entry paths and the existing repeated factory calls", () => {
  const factory = "createGitHubPublicationExecutionStoreInDatabase";
  const sources = {
    [sharedPublication]: `export function ${factory}() {}`,
    [publicationWorker]: `
      import { ${factory} } from '../gateway/github-publication-store.worker.js';
      function sharedMutation() { ${factory}(); ${factory}(); ${factory}(); }
      export const operations = {
        'githubPublications.shared': () => sharedMutation(),
        'githubPublications.maintenance': () => { sharedMutation(); sharedMutation(); },
      };
    `,
  };
  expect(inspect(sources)).toEqual([]);
  expect(
    inspect({
      ...sources,
      [publicationWorker]: `${sources[publicationWorker]}
        function bypass() { sharedMutation(); }
      `,
    }),
  ).toEqual([expect.stringContaining(`from ${publicationWorker}:bypass`)]);
  expect(
    inspect({
      ...sources,
      [publicationWorker]: sources[publicationWorker].replace(
        `function sharedMutation() {`,
        `function sharedMutation() { ${factory}();`,
      ),
    }),
  ).toEqual([expect.stringContaining(`from ${publicationWorker}:sharedMutation`)]);
});

it("counts the receipt deletion loop and lifecycle deletion as two reviewed sinks", () => {
  const file = "src/state/github-personal-publication-lifecycle.ts";
  const source = `export function deletePersonalGitHubSessionReceiptsInDatabase() {
    const tables = ['github_personal_publication_requests', 'github_repository_publication_requests'] as const;
    const existing = tables.filter((table) => tableExists(table));
    for (const table of existing) { db.deleteFrom(table); }
    db.deleteFrom('github_publication_session_lifecycles');
  }`;
  expect(inspect({ [file]: source })).toEqual([]);
  expect(
    inspect({
      [file]:
        source +
        `
    function bypass(table: 'github_personal_publication_requests' | 'github_repository_publication_requests') {
      db.deleteFrom(table);
    }
  `,
    }),
  ).toEqual([expect.stringContaining("unreviewed github_")]);
  expect(
    inspect({
      [file]: source.replace(
        "db.deleteFrom(table);",
        "db.deleteFrom(table); db.deleteFrom(table);",
      ),
    }),
  ).toEqual([expect.stringContaining("unreviewed github_publication_session_lifecycles writer")]);
});

it("guards generic credential publication and custody helpers against new caller entries", () => {
  const authority = "src/state/user-model-account-authority.ts";
  const custody = "src/agents/auth-profiles/credential-write-custody.ts";
  const machine = "src/state/config-machine-state-write.ts";
  const sources = {
    [custody]: `export function withAuthProfileCredentialWriteCustody() {}`,
    [authority]: `
      import { withAuthProfileCredentialWriteCustody } from '../agents/auth-profiles/credential-write-custody.js';
      export function withAuthProfileCredentialWrite() { withAuthProfileCredentialWriteCustody(); }
    `,
    [machine]: `
      import { withAuthProfileCredentialWrite } from './user-model-account-authority.js';
      function publishMachineStateWrite() { withAuthProfileCredentialWrite(); }
      function upsertConfigMachineState() { publishMachineStateWrite(); }
    `,
  };
  expect(inspect(sources)).toEqual([]);
  expect(
    inspect({
      ...sources,
      "src/new-writer.worker.ts": `
      import { withAuthProfileCredentialWriteCustody as write } from './agents/auth-profiles/credential-write-custody.js';
      write();
    `,
    }),
  ).toEqual([expect.stringContaining("unreviewed personal credential writer reference")]);
  expect(
    inspect({
      ...sources,
      [machine]: sources[machine] + `function bypass() { publishMachineStateWrite(); }`,
    }),
  ).toEqual([expect.stringContaining("unreviewed personal credential writer reference")]);
});

it("requires the host publication adapter for direct and aliased machine-state commands", () => {
  const source = `export function writeConfigMachineStateAsync() {
    const command = 'machineState.write' as const;
    return scope.execute({ type: command, input: { key: 'authProfiles.store', value: {} } });
  }`;
  expect(inspect({ "src/state/config-machine-state-async.ts": source })).toEqual([]);
  expect(inspect({ "src/new-writer.ts": source })).toEqual([
    expect.stringContaining("machine-state credential writes require the host publication adapter"),
  ]);
  expect(
    inspect({
      "src/new-writer.ts": source.replace("type: command", "type: 'machineState.write'"),
    }),
  ).toEqual([
    expect.stringContaining("machine-state credential writes require the host publication adapter"),
  ]);
});
