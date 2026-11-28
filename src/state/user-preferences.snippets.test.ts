import { expect, it } from "vitest";
import {
  createVoiceSnippetCatalog,
  editVoiceSnippetCatalog,
  VOICE_SNIPPETS_PREFERENCE_KEY as key,
  type VoiceSnippetCatalog,
} from "../shared/voice-snippets.js";
import {
  closeOpenClawStateDatabaseByPathAsync,
  runOpenClawStateWriteTransaction,
} from "./openclaw-state-db.js";
import { getCanonicalUserPreferences, setCanonicalUserPreferences } from "./user-preferences.js";
import { mergeUserPreferences } from "./user-preferences.store.js";
import { ensureProfileForEmail } from "./user-profiles.js";
import { fillUserPreferences, useUserStateFixture } from "./user-state.test-support.js";

const fixture = useUserStateFixture("openclaw-snippets-");
const catalog = () =>
  editVoiceSnippetCatalog(createVoiceSnippetCatalog(), {
    type: "save",
    expectedRevision: null,
    snippet: {
      id: "literal",
      name: "Literal",
      locale: "en-US",
      triggers: ["literal"],
      body: "0007 {{name}} <date>\n\n$HOME\n" + "a".repeat(4096),
      enabled: true,
      sensitivity: "normal",
    },
  });

it("persists an atomic catalog through real writers, restart, disable and failed replacement", async () => {
  const options = fixture();
  const profile = ensureProfileForEmail("snippets@example.test", options).id;
  const first = catalog();
  const save = (next: VoiceSnippetCatalog, previous: VoiceSnippetCatalog | null) =>
    setCanonicalUserPreferences(
      profile,
      { [key]: next },
      { ...options, expectedEntries: { [key]: previous } },
    );
  expect(await save(first, null)).toMatchObject({ ok: true });
  const left = editVoiceSnippetCatalog(first, { type: "enabled", enabled: true });
  const right = editVoiceSnippetCatalog(first, {
    type: "save",
    snippet: { ...first.snippets[0]!, name: "Concurrent edit" },
    expectedRevision: 1,
  });
  const outcomes = await Promise.all([save(left, first), save(right, first)]);
  expect(outcomes.filter((result) => result?.ok)).toHaveLength(1);
  expect(outcomes.filter((result) => result && !result.ok)).toEqual([
    { ok: false, error: { code: "conflict" } },
  ]);
  const current = (await getCanonicalUserPreferences(profile, [key], options))!.entries[
    key
  ] as VoiceSnippetCatalog;
  expect(current).toEqual(outcomes[0]?.ok ? left : right);
  expect(
    await setCanonicalUserPreferences(
      profile,
      { [key]: { ...current, revision: current.revision + 1, templateEngine: "shell" } },
      { ...options, expectedEntries: { [key]: current } },
    ),
  ).toMatchObject({ ok: false, error: { code: "invalid-snippet-catalog" } });
  expect(await setCanonicalUserPreferences(profile, { [key]: null }, options)).toMatchObject({
    ok: false,
  });
  const disabled = editVoiceSnippetCatalog(current, { type: "enabled", enabled: false });
  expect(await save(disabled, current)).toMatchObject({ ok: true });
  await closeOpenClawStateDatabaseByPathAsync(options.path);
  expect((await getCanonicalUserPreferences(profile, [key], options))?.entries[key]).toEqual(
    disabled,
  );
  expect((await getCanonicalUserPreferences(profile, undefined, options))?.entries).toEqual({});
  const other = ensureProfileForEmail("other@example.test", options).id;
  expect((await getCanonicalUserPreferences(other, [key], options))?.entries).toEqual({});
});

it("rejects revision forgery and revoked write admission before changing saved definitions", async () => {
  const options = fixture();
  const profile = ensureProfileForEmail("revision@example.test", options).id;
  const first = catalog();
  expect(
    await setCanonicalUserPreferences(
      profile,
      { [key]: first },
      { ...options, expectedEntries: { [key]: null } },
    ),
  ).toMatchObject({ ok: true });
  const modified = {
    ...first,
    revision: 2,
    snippets: first.snippets.map((snippet) => ({
      ...snippet,
      body: "changed without record revision",
    })),
  };
  expect(
    await setCanonicalUserPreferences(
      profile,
      { [key]: modified },
      { ...options, expectedEntries: { [key]: first } },
    ),
  ).toMatchObject({ ok: false, error: { code: "conflict" } });
  expect(
    await setCanonicalUserPreferences(profile, { [key]: { ...first, revision: 2 } }, options),
  ).toMatchObject({ ok: false, error: { code: "conflict" } });
  await expect(
    setCanonicalUserPreferences(
      profile,
      { [key]: { ...first, revision: 2 } },
      {
        ...options,
        expectedEntries: { [key]: first },
        assertCurrent: () => {
          throw new Error("revoked");
        },
      },
    ),
  ).rejects.toThrow("revoked");
  expect((await getCanonicalUserPreferences(profile, [key], options))?.entries[key]).toEqual(first);
});

it("keeps authored catalogs recoverable during profile merges and a full preference quota", async () => {
  const options = fixture();
  const source = ensureProfileForEmail("source@example.test", options).id;
  const target = ensureProfileForEmail("target@example.test", options).id;
  const first = catalog();
  fillUserPreferences(options, target, 128);
  expect(
    await setCanonicalUserPreferences(
      source,
      { [key]: first },
      { ...options, expectedEntries: { [key]: null } },
    ),
  ).toMatchObject({ ok: true });
  const merge = () =>
    runOpenClawStateWriteTransaction(({ db }) => mergeUserPreferences(db, source, target), options);
  merge();
  expect((await getCanonicalUserPreferences(target, [key], options))?.entries[key]).toEqual(first);
  expect(
    await setCanonicalUserPreferences(
      source,
      { [key]: first },
      { ...options, expectedEntries: { [key]: null } },
    ),
  ).toMatchObject({ ok: true });
  expect(merge).toThrow("Export and resolve");
  expect((await getCanonicalUserPreferences(source, [key], options))?.entries[key]).toEqual(first);
  expect((await getCanonicalUserPreferences(target, [key], options))?.entries[key]).toEqual(first);
});
