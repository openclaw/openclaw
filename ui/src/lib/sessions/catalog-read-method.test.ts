import { expect, it } from "vitest";
import { createApplicationGatewaySnapshot } from "../../test-helpers/application-context-fixtures.ts";
import { canComposeCatalogSession, catalogMethod } from "./catalog-read-method.ts";

it.each([
  { scopes: ["operator.sessions.write"] },
  { scopes: ["operator.read", "operator.sessions.write"] },
])("uses publisher continuation without shared write access: $scopes", ({ scopes }) => {
  const snapshot = createApplicationGatewaySnapshot({
    hello: {
      type: "hello-ok",
      protocol: 3,
      auth: { role: "operator", scopes },
      features: { methods: ["beam.owned.continue"] },
    },
  });
  expect(catalogMethod(snapshot, "beam", "continue")).toBe("beam.owned.continue");
  expect(canComposeCatalogSession(snapshot, "beam")).toBe(true);
  expect(catalogMethod(snapshot, "beam", "read")).toBe(
    scopes.includes("operator.read") ? "sessions.catalog.read" : "beam.owned.read",
  );
});

it("preserves shared write continuation and does not invent old-host support", () => {
  const staff = createApplicationGatewaySnapshot({
    hello: {
      type: "hello-ok",
      protocol: 3,
      auth: { role: "operator", scopes: ["operator.write"] },
    },
  });
  expect(catalogMethod(staff, "beam", "continue")).toBe("sessions.catalog.continue");
  expect(canComposeCatalogSession(staff, "beam")).toBe(true);
  const guest = createApplicationGatewaySnapshot({
    hello: {
      type: "hello-ok",
      protocol: 3,
      auth: { role: "operator", scopes: ["operator.sessions.write"] },
    },
  });
  expect(canComposeCatalogSession(guest, "beam")).toBe(false);
});
