import { expect, it } from "vitest";
import type { ModelsListResult } from "../../packages/gateway-protocol/src/schema/model-catalog.js";
import { projectClientModelCatalog } from "./model-account-presentation.js";
import { projectOperatorModelRead } from "./operator-model-presentation.js";
import { authorizationClient } from "./server-methods.authorization.test-support.js";

it("keeps the selected reference consistent across catalog outcomes and chat history without rewriting admin facts", () => {
  const id = "fixture:private@example.test";
  const catalog = {
    models: [],
    accountSelection: { kind: "shared", authProfileId: id, label: id, source: "user", ordinal: 2 },
    providerOutcomes: [{ provider: "fixture", profileId: id, status: "ready" }],
    utilityModel: { modelRef: `fixture/model@${id}`, source: "config" },
    defaultModels: { automaticUtilityModel: `fixture/model@${id}` },
  } satisfies ModelsListResult;
  const reader = authorizationClient("reader", ["operator.read"]);
  const visible = projectClientModelCatalog(catalog, reader);
  expect(visible.accountSelection).not.toHaveProperty("ordinal");
  expect(
    projectClientModelCatalog(
      catalog,
      authorizationClient("participant", ["operator.sessions.write"]),
    ).accountSelection,
  ).not.toHaveProperty("ordinal");
  expect(
    projectClientModelCatalog(catalog, authorizationClient("editor", ["operator.write"]))
      .accountSelection.ordinal,
  ).toBe(2);
  expect(JSON.stringify(visible)).not.toContain(id);
  expect(visible.accountSelection.authProfileId).toMatch(/^shared-ref:/);
  expect(visible.providerOutcomes[0]?.profileId).toBe(visible.accountSelection.authProfileId);
  expect(visible.utilityModel.modelRef).toBe("fixture/model");
  expect(visible.defaultModels.automaticUtilityModel).toBe("fixture/model");
  const history = projectOperatorModelRead(
    { agentId: "main", context: { getRuntimeConfig: () => ({}) }, client: reader },
    { metadata: { accountSelection: catalog.accountSelection, swarmEnabled: false } },
  );
  expect(history.metadata.accountSelection).toEqual(visible.accountSelection);
  expect(
    projectClientModelCatalog(catalog, authorizationClient("admin", ["operator.admin"]))
      .accountSelection.authProfileId,
  ).toBe(id);
});
