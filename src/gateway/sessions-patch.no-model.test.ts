import { expect, test } from "vitest";
import {
  MAIN_SESSION_KEY,
  expectPatchOk,
  mainStoreEntry,
  runPatch,
} from "./sessions-patch.test-support.js";

test("clears a model override when no model is configured to return to", async () => {
  const store = mainStoreEntry({
    providerOverride: "anthropic",
    modelOverride: "claude-sonnet-5-5",
    modelOverrideSource: "user",
    modelProvider: "anthropic",
    model: "claude-sonnet-5-5",
  });
  const entry = expectPatchOk(
    await runPatch({ cfg: {}, store, patch: { key: MAIN_SESSION_KEY, model: null } }),
  );
  expect(entry).not.toHaveProperty("providerOverride");
  expect(entry).not.toHaveProperty("modelOverride");
  expect(entry).not.toHaveProperty("model");
  expect(entry.modelOverrideSource).toBeUndefined();
});
