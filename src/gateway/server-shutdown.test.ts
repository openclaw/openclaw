import { expect, it } from "vitest";
import { resolveGatewayShutdownNotice } from "./server-shutdown.js";

it("omits invalid restart metadata and normalizes the reason", () => {
  expect(
    resolveGatewayShutdownNotice({ reason: "  upgrade  ", restartExpectedMs: Number.NaN }),
  ).toEqual({ reason: "upgrade" });
  expect(resolveGatewayShutdownNotice({ restartExpectedMs: -2 })).toEqual({
    reason: "gateway stopping",
    restartExpectedMs: 0,
  });
});
