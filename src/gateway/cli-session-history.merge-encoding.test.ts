import { expect, it } from "vitest";
import { mergeImportedChatHistoryMessages } from "./cli-session-history.test-support.js";

it("keeps lone surrogates distinct from replacement characters in SQLite match keys", () => {
  const local = { role: "assistant", content: "\ud800" };
  const imported = { role: "assistant", content: "\ufffd" };
  expect(
    mergeImportedChatHistoryMessages({ localMessages: [local], importedMessages: [imported] }),
  ).toEqual([local, imported]);
});
