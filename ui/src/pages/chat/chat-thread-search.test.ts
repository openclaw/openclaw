import { expect, it } from "vitest";
import { groupsOf, message } from "./chat-thread-fixtures.test-support.ts";
import { buildItems } from "./chat-thread.test-support.ts";

it.each(["Σ", "σ", "ς", "ΕΛΕΓΧΟΣ", "ελεγχος"])(
  "matches Greek sigma forms when searching messages for %s",
  (searchQuery) => {
    const items = buildItems({
      messages: [
        message("user", "Handoff review — ΕΛΕΓΧΟΣ", 1_000),
        message("assistant", "Done", 1_001),
      ],
      searchOpen: true,
      searchQuery,
    });

    expect(groupsOf(items).map((group) => group.role)).toEqual(["user"]);
  },
);
