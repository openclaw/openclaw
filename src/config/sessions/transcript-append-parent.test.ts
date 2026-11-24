import { expect, it } from "vitest";
import { preparedAssistantMessagesPreserveTurn } from "./transcript-append-parent.js";

const facts = (
  overrides: Partial<Parameters<typeof preparedAssistantMessagesPreserveTurn>[0][number]>,
) => ({
  event_id: "newer",
  message_role: "user",
  context_free_command: 0,
  human_addressed: 0,
  provenance_kind: "external_user",
  provenance_source_channel: undefined,
  ...overrides,
});

it("lets a prepared assistant append rebase over a message addressed to people", () => {
  expect(
    preparedAssistantMessagesPreserveTurn([facts({ human_addressed: 1 })], "admitted", () => false),
  ).toBe(true);
});

it("still rejects an ordinary newer user turn", () => {
  expect(preparedAssistantMessagesPreserveTurn([facts({})], "admitted", () => false)).toBe(false);
});
