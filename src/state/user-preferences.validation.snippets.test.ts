import { expect, it } from "vitest";
import {
  createVoiceSnippetCatalog,
  editVoiceSnippetCatalog,
  VOICE_SNIPPET_BODY_BYTES,
  VOICE_SNIPPETS_PREFERENCE_KEY as key,
} from "../shared/voice-snippets.js";
import { prepareUserPreferenceUpdate } from "./user-preferences.validation.js";

it("validates large static definitions and complete optimistic revisions at the server write boundary", () => {
  const first = editVoiceSnippetCatalog(createVoiceSnippetCatalog(), {
    type: "save",
    expectedRevision: null,
    snippet: {
      id: "static",
      name: "Static",
      locale: "en-US",
      triggers: ["static"],
      body: "0001\n{{name}}\n" + "x".repeat(5000),
      enabled: true,
      sensitivity: "normal",
    },
  });
  const prepared = prepareUserPreferenceUpdate({ [key]: first }, { [key]: null });
  expect(prepared).toMatchObject({
    ok: true,
    value: { expected: [{ prefKey: key, valueJson: null }] },
  });
  expect(prepared.ok && JSON.parse(prepared.value.serialized[0]!.valueJson).snippets[0].body).toBe(
    first.snippets[0]!.body,
  );
  expect(prepareUserPreferenceUpdate({ [key]: first })).toEqual({
    ok: false,
    error: { code: "conflict" },
  });
  const unchanged = { ...first, revision: 2 };
  expect(prepareUserPreferenceUpdate({ [key]: unchanged }, { [key]: first })).toMatchObject({
    ok: true,
  });
  expect(
    prepareUserPreferenceUpdate(
      { [key]: { ...unchanged, snippets: [{ ...first.snippets[0], body: "different bytes" }] } },
      { [key]: first },
    ),
  ).toEqual({ ok: false, error: { code: "conflict" } });
  for (const [invalid, reason] of [
    [{ ...unchanged, requiredFeatures: ["dynamic-variables"] }, "invalid-schema"],
    [
      {
        ...unchanged,
        snippets: [{ ...first.snippets[0], body: "x".repeat(VOICE_SNIPPET_BODY_BYTES + 1) }],
      },
      "body-too-large",
    ],
  ] as const) {
    expect(
      prepareUserPreferenceUpdate({ [key]: invalid, unrelated: true }, { [key]: first }),
    ).toEqual({ ok: false, error: { code: "invalid-snippet-catalog", reason } });
  }
  expect(prepareUserPreferenceUpdate({ ordinary: "x".repeat(5000) })).toMatchObject({
    ok: false,
    error: { code: "value-too-large" },
  });
  expect(prepareUserPreferenceUpdate({ [key]: null }, { [key]: first })).toMatchObject({
    ok: false,
  });
});
