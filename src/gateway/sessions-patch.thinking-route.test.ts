import { expect, test } from "vitest";
import type { ModelCatalogEntry } from "../agents/model-catalog.js";
import { projectSessionsPatchEntry } from "./sessions-patch.js";
import {
  MAIN_SESSION_KEY,
  expectPatchError,
  expectPatchOk,
  mainStoreEntry,
} from "./sessions-patch.test-support.js";

// The selected runtime route row owns effort support, but the logical row's configured
// reasoning flag still decides whether the model reasons at all.
test.each([
  {
    level: "max",
    logical: { compat: { supportedReasoningEfforts: ["high"] } },
    route: { compat: { supportedReasoningEfforts: ["max"] } },
    accepted: true,
  },
  {
    level: "max",
    logical: { compat: { supportedReasoningEfforts: ["max"] } },
    route: { compat: { supportedReasoningEfforts: ["high"] } },
    accepted: false,
  },
  { level: "low", logical: { reasoning: false }, route: { reasoning: true }, accepted: false },
  { level: "low", logical: { reasoning: true }, route: { reasoning: false }, accepted: true },
])(
  "validates $level against the selected runtime route (accepted=$accepted)",
  async ({ level, logical, route, accepted }) => {
    const entry: ModelCatalogEntry = {
      provider: "runtime-fixture",
      id: "reasoner",
      name: "Reasoner",
      reasoning: true,
      ...logical,
    };
    const result = await projectSessionsPatchEntry({
      cfg: { agents: { defaults: { model: "runtime-fixture/reasoner" } } },
      storeKey: MAIN_SESSION_KEY,
      existingEntry: mainStoreEntry({})[MAIN_SESSION_KEY],
      isLabelInUse: () => false,
      preparedAgentRuntime: "fixture-native",
      patch: { key: MAIN_SESSION_KEY, thinkingLevel: level },
      loadGatewayModelCatalogSnapshot: async () => ({
        entries: [entry],
        routeVariants: [entry, { ...entry, nativeRuntime: "fixture-native", ...route }],
      }),
    });

    if (accepted) {
      expect(expectPatchOk(result).thinkingLevel).toBe(level);
    } else {
      expectPatchError(result, `thinkingLevel "${level}" is not supported`);
    }
  },
);
