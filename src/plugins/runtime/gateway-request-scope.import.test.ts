import { expect, it, vi } from "vitest";

vi.mock("../current-plugin-metadata-snapshot.js", () => {
  throw new Error("gateway request scope must remain lightweight");
});

it("does not import the plugin metadata control plane", async () => {
  const runtimeScope = await import("./gateway-request-scope.js");

  expect(runtimeScope.withPluginRuntimeGatewayRequestScope).toBeTypeOf("function");
});
