import type { GatewayRequestHandlerOptions } from "openclaw/plugin-sdk/gateway-runtime";
import { expectTypeOf } from "vitest";

// Preserve the released synchronous approval commit guard.
expectTypeOf<
  NonNullable<GatewayRequestHandlerOptions["sessionMutationCommitGuard"]>
>().toEqualTypeOf<() => void>();
