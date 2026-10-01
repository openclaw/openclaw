import { expect, it } from "vitest";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { resolveSessionCreateInheritedSelection } from "./session-create-inheritance.js";
import {
  type ApplySessionsPatchArgs,
  MAIN_SESSION_KEY,
  runPatch,
  expectPatchOk,
  mainStoreEntry,
} from "./sessions-patch.test-support.js";

it("preserves the other communication direction and resets back to inheritance", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const store = mainStoreEntry({ communication: { send: "never", receive: "ask" } });
    const patch = async (communication: ApplySessionsPatchArgs["patch"]["communication"]) =>
      expectPatchOk(await runPatch({ store, patch: { key: MAIN_SESSION_KEY, communication } }));
    expect((await patch({ send: "always" })).communication).toEqual({
      send: "always",
      receive: "ask",
    });
    expect((await patch({ receive: null })).communication).toEqual({ send: "always" });
    expect((await patch({ send: null })).communication).toBeUndefined();
    expect((await patch({ receive: "never" })).communication).toEqual({ receive: "never" });
    expect((await patch(null)).communication).toBeUndefined();
  });
});

it("inherits communication independently of model choices without replacing explicit choices", () => {
  const parent = {
    sessionId: "parent",
    updatedAt: 1,
    modelOverride: "old-model",
    communication: { receive: "never" as const },
  };
  expect(
    resolveSessionCreateInheritedSelection({ params: { model: "new-model" }, parent }),
  ).toEqual({ communication: { receive: "never" } });
  expect(
    resolveSessionCreateInheritedSelection({ params: {}, parent, catalogModel: "catalog-model" }),
  ).toEqual({ communication: { receive: "never" } });
  expect(
    resolveSessionCreateInheritedSelection({
      params: { model: "new-model", communication: { send: "ask" } },
      parent,
    }),
  ).toEqual({});
});
