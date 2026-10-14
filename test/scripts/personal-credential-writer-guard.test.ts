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
  [
    "dynamic import escape",
    "export const writers = await import('./state/user-model-accounts.js');",
  ],
  ["wildcard export", "export * from './state/user-model-accounts.js';"],
  ["namespace export", "export * as accounts from './state/user-model-accounts.js';"],
])("rejects an unowned %s", (_name, consumer) => {
  expect(inspect({ "src/consumer.ts": consumer })).toEqual(
    expect.arrayContaining([
      expect.stringContaining("unreviewed personal credential writer reference"),
    ]),
  );
});

it.each([
  "const { SELECT: selected } = await import('./state/user-model-accounts.js'); selected();",
  "const accounts = await import('./state/user-model-accounts.js'); accounts.SELECT();",
  "(await import('./state/user-model-accounts.js'))['SELECT']();",
  "const [{ SELECT: selected }] = await Promise.all([import('./state/user-model-accounts.js')]); selected();",
  "import('./state/user-model-accounts.js').then(({ SELECT: selected }) => selected());",
  "Promise.all([import('./state/user-model-accounts.js')]).then(([accounts]) => accounts.SELECT());",
])("checks a selected dynamic import without charging unused sibling exports: %s", (consumer) => {
  const source = `${owner}\nexport function listUserProfileAuthLinksAsync() {}`;
  const selected = (name: string) =>
    inspect(
      {
        "src/consumer.ts": consumer.replaceAll("SELECT", name),
      },
      source,
    );
  expect(selected("listUserProfileAuthLinksAsync")).toEqual([]);
  expect(selected("connectUserModelAccount")).toEqual([
    expect.stringContaining("unreviewed personal credential writer reference"),
  ]);
});

it.each([
  "const accounts = await import('./state/user-model-accounts.js'); export const escaped = accounts;",
  "export const [accounts] = await Promise.all([import('./state/user-model-accounts.js')]);",
  "const { ...accounts } = await import('./state/user-model-accounts.js'); consume(accounts);",
  "const accounts = await import('./state/user-model-accounts.js'); accounts[unknownKey]();",
  "const { [unknownKey]: writer } = await import('./state/user-model-accounts.js'); writer();",
])("rejects an unbounded dynamic namespace or export: %s", (consumer) => {
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
  "db.exec('REPLACE INTO secret_store_entries (name) VALUES (?)');",
  "db.exec('UPDATE OR REPLACE secret_store_entries SET value = ?');",
  "db.replaceInto('secret_store_entries').values({ name: 'replacement' });",
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
  "db.replaceInto('config_machine_state').values({ state_key: 'authProfiles.store' });",
  "db.insertInto('config_machine_state').values({ state_key: 'other' }).onConflict((conflict) => conflict.column('state_key').doUpdateSet({ state_key: 'authProfiles.store' }));",
  "db.insertInto('config_machine_state').values({ state_key: 'other' }).onConflict((conflict) => { return conflict.column('state_key').doUpdateSet({ state_key: 'authProfiles.store' }); });",
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
      db.replaceInto('config_machine_state').values({ state_key: unrelated });
      db.insertInto('config_machine_state').values({ state_key: unrelated })
        .onConflict((conflict) => conflict.column('state_key').doUpdateSet({ value_json: '{}' }));
      db.insertInto('config_machine_state').values({ state_key: unrelated })
        .onConflict((conflict) => conflict.column('state_key').doUpdateSet({ state_key: 'other' }));
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
    expect.stringContaining(
      "machineState.write credential writes require the host publication adapter",
    ),
  ]);
  expect(
    inspect({
      "src/new-writer.ts": source.replace("type: command", "type: 'machineState.write'"),
    }),
  ).toEqual([
    expect.stringContaining(
      "machineState.write credential writes require the host publication adapter",
    ),
  ]);
});

const authRuntime = "src/agents/auth-profiles/store-runtime.ts";
const authStore = "src/agents/auth-profiles/store.ts";
const authCells = "src/agents/auth-profiles/sqlite-json-write.ts";

it("tracks nested native writer declarations and permits only the reviewed factory return", () => {
  const source = `export function createAuthProfileStoreRuntime() {
    function saveAuthProfileStoreInTransaction() {}
    function saveAuthProfileStore() { saveAuthProfileStoreInTransaction(); }
    return { saveAuthProfileStore };
  }`;
  expect(inspect({ [authStore]: source })).toEqual([]);
  expect(
    inspect({
      [authStore]: source.replace(
        "return { saveAuthProfileStore };",
        "function bypass() { saveAuthProfileStoreInTransaction(); } return { saveAuthProfileStore };",
      ),
    }),
  ).toEqual([
    expect.stringContaining(
      "from src/agents/auth-profiles/store.ts:createAuthProfileStoreRuntime/bypass",
    ),
  ]);
  expect(
    inspect({
      [authStore]: source.replace(
        "return { saveAuthProfileStore };",
        "const escaped = saveAuthProfileStore; return { saveAuthProfileStore };",
      ),
    }),
  ).toEqual([expect.stringContaining("unreviewed personal credential writer reference")]);
});

it.each([
  "import { saveAuthProfileStore as save } from './plugin-sdk/agent-runtime.js'; save();",
  "import * as sdk from './plugin-sdk/agent-runtime.js'; sdk.saveAuthProfileStore();",
  "import * as sdk from './plugin-sdk/agent-runtime.js'; sdk['saveAuthProfileStore']();",
  "export { saveAuthProfileStore } from './plugin-sdk/agent-runtime.js';",
])("rejects a new ordinary worker entry through the released sync SDK: %s", (consumer) => {
  const sources = {
    [authRuntime]: `export const saveAuthProfileStore = () => {};`,
    "src/agents/auth-profiles.ts": `export { saveAuthProfileStore } from './auth-profiles/store-runtime.js';`,
    "src/plugin-sdk/agent-runtime.ts": `export { saveAuthProfileStore } from '../agents/auth-profiles.js';`,
  };
  expect(inspect(sources)).toEqual([]);
  expect(inspect({ ...sources, "src/new-writer.worker.ts": consumer })).toEqual([
    expect.stringContaining("unreviewed personal credential writer reference"),
  ]);
});

it("protects destructured facade writers and native readers that can synchronize credentials", () => {
  const sources = {
    [authRuntime]: `
      const runtime = { saveAuthProfileStoreWithPreparedOwner() {}, ensureAuthProfileStore() {} };
      export const { saveAuthProfileStoreWithPreparedOwner } = runtime;
      export const ensureAuthProfileStore = runtime.ensureAuthProfileStore;
    `,
    "src/new-writer.worker.ts": `
      import { saveAuthProfileStoreWithPreparedOwner, ensureAuthProfileStore } from './agents/auth-profiles/store-runtime.js';
      saveAuthProfileStoreWithPreparedOwner();
      ensureAuthProfileStore();
    `,
  };
  expect(inspect(sources)).toEqual([
    expect.stringContaining("saveAuthProfileStoreWithPreparedOwner"),
    expect.stringContaining("ensureAuthProfileStore"),
  ]);
});

it("preserves the released provider-auth package barrel without admitting a new facade", () => {
  const sources = {
    [authRuntime]: `export function ensureAuthProfileStore() {}`,
    "src/plugin-sdk/provider-auth.ts": `export { ensureAuthProfileStore } from '../agents/auth-profiles/store-runtime.js';`,
    "packages/plugin-sdk/src/provider-auth.ts": `export * from '../../../src/plugin-sdk/provider-auth.js';`,
  };
  expect(inspect(sources)).toEqual([]);
  expect(
    inspect({
      ...sources,
      "src/new-facade.ts": `export * from './plugin-sdk/provider-auth.js';`,
    }),
  ).toEqual([expect.stringContaining("unreviewed personal credential writer reference")]);
});

it("permits the exact native reader dependency forwards without opening sibling callers", () => {
  const sources = {
    [authRuntime]: `export function ensureAuthProfileStore() {} export function loadAuthProfileStoreForRuntime() {}`,
    "extensions/codex/src/app-server/auth-profile.ts": `
      import { ensureAuthProfileStore } from '../../../../src/agents/auth-profiles/store-runtime.js';
      const selection = createCodexAuthProfileSelection({ ensureAuthProfileStore });
    `,
    "src/agents/cli-execution-auth.ts": `
      import { loadAuthProfileStoreForRuntime } from './auth-profiles/store-runtime.js';
      export function resolveCliExecutionAuthProfileId(params) {
        const loadStore = params.loadAuthProfileStoreForRuntime ?? loadAuthProfileStoreForRuntime;
        return loadStore();
      }
    `,
    "src/system-agent/setup-inference-profile.ts": `
      import { loadAuthProfileStoreForRuntime } from '../agents/auth-profiles/store-runtime.js';
      export function resolveSetupInferenceProfileError(deps) {
        const loadStore = deps.loadAuthProfileStoreForRuntime ?? loadAuthProfileStoreForRuntime;
        return loadStore();
      }
    `,
    "src/system-agent/verified-inference.ts": `
      import { loadAuthProfileStoreForRuntime } from '../agents/auth-profiles/store-runtime.js';
      function loadRouteAuthProfileStore(deps) {
        return (deps.loadAuthProfileStoreForRuntime ?? loadAuthProfileStoreForRuntime)();
      }
    `,
  };
  expect(inspect(sources)).toEqual([]);
  expect(
    inspect({
      ...sources,
      "src/agents/cli-execution-auth.ts": sources["src/agents/cli-execution-auth.ts"].replace(
        "resolveCliExecutionAuthProfileId",
        "newReader",
      ),
    }),
  ).toEqual([expect.stringContaining("from src/agents/cli-execution-auth.ts:newReader")]);
});

it("bounds reviewed lazy imports by loader, declaration scope and selected export", () => {
  const file = "src/media-understanding/runner.ts";
  const sources = {
    [authRuntime]: `export function ensureAuthProfileStore() {}`,
    "src/agents/model-auth.ts": `export { ensureAuthProfileStore } from './auth-profiles/store-runtime.js';`,
  };
  const source = `const loadHasAvailableAuthForProvider = createLazyRuntimeNamedExport(
    () => import('../agents/model-auth.js'), 'hasAvailableAuthForProvider');`;
  expect(inspect({ ...sources, [file]: source })).toEqual([]);
  for (const changed of [
    source.replace("'hasAvailableAuthForProvider'", "'ensureAuthProfileStore'"),
    source.replace("createLazyRuntimeNamedExport", "newLoader"),
    `function newLoader() { ${source} }`,
  ]) {
    expect(inspect({ ...sources, [file]: changed })).toEqual([
      expect.stringContaining("unreviewed personal credential writer reference"),
    ]);
  }
});

it("closes raw-store and worker-kernel entries while preserving the named update dispatchers", () => {
  const sources = {
    [authCells]: `export function writeAuthProfileJsonCell() {}`,
    "src/agents/auth-profiles/store-update-kernel.ts": `
      import { writeAuthProfileJsonCell } from './sqlite-json-write.js';
      export function updateAuthProfileStoreInDatabase() { writeAuthProfileJsonCell(); }
    `,
    "src/agents/auth-profiles/store.worker.ts": `
      import { updateAuthProfileStoreInDatabase } from './store-update-kernel.js';
      export const operations = { 'authProfiles.update': () => updateAuthProfileStoreInDatabase() };
    `,
  };
  expect(inspect(sources)).toEqual([]);
  expect(
    inspect({
      ...sources,
      "src/new-writer.worker.ts": `
        import { updateAuthProfileStoreInDatabase } from './agents/auth-profiles/store-update-kernel.js';
        updateAuthProfileStoreInDatabase();
      `,
    }),
  ).toEqual([expect.stringContaining("unreviewed personal credential writer reference")]);
});

it.each([
  "writeConfigMachineState('authProfiles.store', {});",
  "const key = ' authProfiles.store '; writeConfigMachineState(key, {});",
  "writeConfigMachineState(command.input.key, {});",
  "export const write = writeConfigMachineState;",
])("rejects a generic machine-state entry with credential access: %s", (consumer) => {
  expect(
    inspect({
      "src/state/config-machine-state-write.ts": `export function writeConfigMachineState() {}`,
      "src/new-writer.worker.ts": `
        import { writeConfigMachineState } from './state/config-machine-state-write.js';
        ${consumer}
      `,
    }),
  ).toEqual([expect.stringContaining("unreviewed personal credential writer reference")]);
});

it("permits fixed noncredential generic writer keys without granting a caller exemption", () => {
  expect(
    inspect({
      "src/state/config-machine-state-write.ts": `export function writeConfigMachineState() {}`,
      "src/new-writer.worker.ts": `
        import { writeConfigMachineState } from './state/config-machine-state-write.js';
        const stateKey = 'authProfiles.state';
        writeConfigMachineState(stateKey, {});
      `,
    }),
  ).toEqual([]);
});

it("requires host publication for auth-store commands, including literal aliases", () => {
  const source = `async function runPreparedAuthProfileStoreUpdate() {
    const type = 'authProfiles.update' as const;
    await scope.execute({ type, input: {} });
  }`;
  expect(inspect({ "src/agents/auth-profiles/store-update.ts": source })).toEqual([]);
  expect(inspect({ "src/new-writer.worker.ts": source })).toEqual([
    expect.stringContaining(
      "authProfiles.update credential writes require the host publication adapter",
    ),
  ]);
});

it("keeps catalog capture and worker write custody behind the reviewed batch entry", () => {
  const sources = {
    "src/agents/auth-profiles/runtime-scope.ts": `export function withWorkerAuthProfileWrites() {}`,
    "src/state/user-model-account-authority.ts": `export function captureAuthProfileCredentialCommits() {}`,
    "src/agents/prepared-model-catalog.worker.ts": `
      import { withWorkerAuthProfileWrites } from './auth-profiles/runtime-scope.js';
      import { captureAuthProfileCredentialCommits } from '../state/user-model-account-authority.js';
      captureAuthProfileCredentialCommits(() => withWorkerAuthProfileWrites());
    `,
  };
  expect(inspect(sources)).toEqual([]);
  expect(
    inspect({
      ...sources,
      "src/new-writer.worker.ts": `
        import { withWorkerAuthProfileWrites } from './agents/auth-profiles/runtime-scope.js';
        withWorkerAuthProfileWrites();
      `,
    }),
  ).toEqual([expect.stringContaining("unreviewed personal credential writer reference")]);
});

it("does not expose the onboarding mutation callback outside its bounded-key adapter", () => {
  const file = "src/state/onboarding-recommendations.kernel.ts";
  const source = `
    function writeOnboardingRecommendationsOffer() {}
    function recommendationOperation(callback) { return callback; }
    export const operations = {
      'onboardingRecommendations.writeOffer': recommendationOperation(writeOnboardingRecommendationsOffer),
    };
  `;
  expect(inspect({ [file]: source })).toEqual([]);
  expect(
    inspect({
      [file]: source + `export function bypass() { writeOnboardingRecommendationsOffer(); }`,
    }),
  ).toEqual([expect.stringContaining("unreviewed personal credential writer reference")]);
});

it("permits supplied-database SDK save custody without granting sibling factory access", () => {
  const source = `
    import { withAuthProfileCredentialWriteCustody } from './credential-write-custody.js';
    export function createAuthProfileStoreRuntime() {
      function saveAuthProfileStore() { withAuthProfileCredentialWriteCustody(); }
      return { saveAuthProfileStore };
    }
  `;
  const sources = {
    "src/agents/auth-profiles/credential-write-custody.ts": `export function withAuthProfileCredentialWriteCustody() {}`,
    [authStore]: source,
  };
  expect(inspect(sources)).toEqual([]);
  expect(
    inspect({
      ...sources,
      [authStore]: source.replace(
        "return { saveAuthProfileStore };",
        "function bypass() { withAuthProfileCredentialWriteCustody(); } return { saveAuthProfileStore };",
      ),
    }),
  ).toEqual([expect.stringContaining("createAuthProfileStoreRuntime/bypass")]);
});

const authStorageSources = {
  "src/agents/sessions/auth-storage.ts": `
    export class AuthStorage {
      static forAgent() { return new AuthStorage(); }
      static create() { return AuthStorage.forAgent(); }
      static forAgentAsync() { return new AuthStorage(); }
      static fromStorage() { return new AuthStorage(); }
      static inMemory() { return new AuthStorage(); }
      set() {}
      remove() {}
    }
  `,
  "src/agents/sessions/index.ts": `export * from './auth-storage.js';`,
  "src/plugin-sdk/agent-sessions.ts": `export { AuthStorage } from '../agents/sessions/index.js';`,
};

it("preserves the released AuthStorage barrel and nonnative constructors", () => {
  expect(
    inspect({
      ...authStorageSources,
      "src/new-reader.worker.ts": `
        import { AuthStorage as Storage } from './plugin-sdk/agent-sessions.js';
        import * as sdk from './plugin-sdk/agent-sessions.js';
        Storage.forAgentAsync();
        sdk.AuthStorage.inMemory();
        sdk.AuthStorage['fromStorage']();
        const { AuthStorage: DynamicStorage } = await import('./plugin-sdk/agent-sessions.js');
        DynamicStorage.forAgentAsync();
      `,
    }),
  ).toEqual([]);
});

it.each([
  "import { AuthStorage } from './plugin-sdk/agent-sessions.js'; AuthStorage.forAgent().set();",
  "import { AuthStorage as Storage } from './plugin-sdk/agent-sessions.js'; Storage.create().remove();",
  "import * as sdk from './plugin-sdk/agent-sessions.js'; sdk.AuthStorage.forAgent().set();",
  "import * as sdk from './plugin-sdk/agent-sessions.js'; sdk.AuthStorage['create']().remove();",
  "import { AuthStorage } from './plugin-sdk/agent-sessions.js'; const { forAgent } = AuthStorage; forAgent().set();",
  "import { AuthStorage } from './plugin-sdk/agent-sessions.js'; export const Storage = AuthStorage;",
  "export { AuthStorage as Storage } from './plugin-sdk/agent-sessions.js';",
  "const { AuthStorage: Storage } = await import('./plugin-sdk/agent-sessions.js'); Storage.forAgent().set();",
  "const [{ AuthStorage: { forAgent: createStorage } }] = await Promise.all([import('./plugin-sdk/agent-sessions.js')]); createStorage().set();",
])("rejects a new native AuthStorage SDK entry or escape: %s", (consumer) => {
  expect(inspect({ ...authStorageSources, "src/new-writer.worker.ts": consumer })).toEqual(
    expect.arrayContaining([
      expect.stringContaining("unreviewed personal credential writer reference"),
    ]),
  );
});

it("keeps session membership writes with the worker and canonical entry owners", () => {
  const members = "src/config/sessions/session-sharing-store.native.ts";
  const sources = {
    [members]: `export function addSessionMember() { db.insertInto('session_members'); }`,
    "src/config/sessions/session-sharing-store.worker.ts": `
      import { addSessionMember } from './session-sharing-store.native.js';
      function bindSqliteWorkerBackend() { return { execute() { addSessionMember(); } }; }
    `,
    "src/config/sessions/session-accessor.sqlite-node-artifacts.ts": `
      export function clearSessionCollaborationForKey() {
        const tables = clear ? ['session_members'] as const : ['session_members', 'session_suggestions'] as const;
        for (const table of tables) { db.deleteFrom(table); }
      }
    `,
    "src/config/sessions/session-accessor.sqlite-entry-store.ts": `
      import { clearSessionCollaborationForKey } from './session-accessor.sqlite-node-artifacts.js';
      function writeSessionEntry() { clearSessionCollaborationForKey(); }
    `,
  };
  expect(inspect(sources)).toEqual([]);
  expect(
    inspect({
      ...sources,
      "src/new-writer.ts": `
        import { addSessionMember } from './config/sessions/session-sharing-store.native.js';
        addSessionMember();
        db.exec('DELETE FROM session_members');
      `,
    }),
  ).toEqual([
    expect.stringContaining("unreviewed session membership writer reference"),
    expect.stringContaining("raw authority-table write"),
  ]);
});
