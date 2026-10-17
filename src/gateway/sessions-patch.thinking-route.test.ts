import { expect, test } from "vitest";
import type { ModelCatalogEntry } from "../agents/model-catalog.js";
import { projectSessionsPatchEntry } from "./sessions-patch.js";
import {
  MAIN_SESSION_KEY,
  expectPatchError,
  expectPatchOk,
  mainStoreEntry,
} from "./sessions-patch.test-support.js";

test.each([false, true])(
  "keeps configured reasoning=%s when a runtime route row is substituted",
  async (reasoning) => {
    const configured: ModelCatalogEntry = {
      provider: "runtime-fixture",
      id: "reasoner",
      name: "Reasoner",
      api: "openai-completions",
      reasoning,
    };
    const result = await projectSessionsPatchEntry({
      cfg: { agents: { defaults: { model: "runtime-fixture/reasoner" } } },
      storeKey: MAIN_SESSION_KEY,
      existingEntry: mainStoreEntry({})[MAIN_SESSION_KEY],
      isLabelInUse: () => false,
      preparedAgentRuntime: "openclaw",
      patch: { key: MAIN_SESSION_KEY, thinkingLevel: "low" },
      loadGatewayModelCatalogSnapshot: async () => ({
        entries: [configured],
        routeVariants: [{ ...configured, api: "openai-responses", reasoning: !reasoning }],
      }),
    });

    if (reasoning) {
      expect(expectPatchOk(result).thinkingLevel).toBe("low");
    } else {
      expectPatchError(result, 'thinkingLevel "low" is not supported');
    }
  },
);
