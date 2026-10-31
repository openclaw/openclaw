import { expect, test } from "vitest";
import { resolveResetPreservedSelection } from "../config/sessions/reset-preserved-selection.js";
import { buildSessionCreateSettingsPatch } from "./session-create-existing-selection.js";
import {
  MAIN_SESSION_KEY,
  runPatch,
  expectPatchOk,
  mainStoreEntry,
} from "./sessions-patch.test-support.js";

test("keeps explicit Standard distinct from clearing the saved access program", async () => {
  const store = mainStoreEntry({ cyberAccessProgram: "daybreak_blue" });
  const standard = expectPatchOk(
    await runPatch({
      store,
      patch: { key: MAIN_SESSION_KEY, cyberAccessProgram: "standard" },
    }),
  );
  expect(standard.cyberAccessProgram).toBe("standard");
  const cleared = expectPatchOk(
    await runPatch({
      store: { [MAIN_SESSION_KEY]: standard },
      patch: { key: MAIN_SESSION_KEY, cyberAccessProgram: null },
    }),
  );
  expect(cleared).not.toHaveProperty("cyberAccessProgram");
});

test.each(["standard", "daybreak_blue", "daybreak_red"] as const)(
  "preserves explicit access %s through reset",
  (cyberAccessProgram) => {
    expect(
      resolveResetPreservedSelection({
        entry: { sessionId: "test", updatedAt: 1, cyberAccessProgram },
      }),
    ).toEqual({ cyberAccessProgram });
  },
);

test("creation preserves omitted settings and explicit access clearing", () => {
  const selected = { key: MAIN_SESSION_KEY };
  const omitted = buildSessionCreateSettingsPatch({}, selected);
  for (const field of [
    "model",
    "agentRuntime",
    "contextWindow",
    "thinkingLevel",
    "fastMode",
    "cyberAccessProgram",
  ]) {
    expect(omitted).not.toHaveProperty(field);
  }
  expect(
    buildSessionCreateSettingsPatch({ cyberAccessProgram: "standard" }, selected),
  ).toHaveProperty("cyberAccessProgram", "standard");
  expect(buildSessionCreateSettingsPatch({ cyberAccessProgram: null }, selected)).toHaveProperty(
    "cyberAccessProgram",
    null,
  );
});
