import { normalizeModelCatalog } from "@openclaw/model-catalog-core/model-catalog-normalize";
import type { ModelDecisionCapabilities } from "@openclaw/model-catalog-core/model-catalog-types";

export function normalizeCapabilities(decision: ModelDecisionCapabilities, id = "native") {
  const model = { id, name: "Fixture", inference: { chat: false, decision } };
  const capabilities = normalizeModelCatalog(
    { providers: { fixture: { models: [model] } } },
    { ownedProviders: new Set(["fixture"]) },
  )?.providers?.fixture?.models[0]?.inference?.decision;
  if (!capabilities) {
    throw new Error("Missing fixture capabilities");
  }
  return capabilities;
}
