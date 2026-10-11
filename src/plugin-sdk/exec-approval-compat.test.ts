import type { GatewayRequestHandlerOptions } from "openclaw/plugin-sdk/gateway-runtime";
import { expectTypeOf, it } from "vitest";

it("retains the released synchronous approval commit guard", () => {
  expectTypeOf<
    NonNullable<GatewayRequestHandlerOptions["sessionMutationCommitGuard"]>
  >().toEqualTypeOf<() => void>();
});
