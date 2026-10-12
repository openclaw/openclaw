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
