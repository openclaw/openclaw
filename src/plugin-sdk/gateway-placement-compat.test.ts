import type { GatewayRequestHandlerOptions as CoreHandler } from "openclaw/plugin-sdk/core";
import type { GatewayRequestHandlerOptions as RuntimeHandler } from "openclaw/plugin-sdk/gateway-runtime";
import type { getPluginRuntimeGatewayRequestScope } from "openclaw/plugin-sdk/plugin-runtime";
import { expectTypeOf, it } from "vitest";

it("retains synchronous placement and publication contracts from the released Gateway context", () => {
  type Context = CoreHandler["context"];
  expectTypeOf<RuntimeHandler["context"]>().toEqualTypeOf<Context>();
  expectTypeOf<
    NonNullable<NonNullable<ReturnType<typeof getPluginRuntimeGatewayRequestScope>>["context"]>
  >().toEqualTypeOf<Context>();
  type Placements = NonNullable<NonNullable<Context>["workerSessionPlacementService"]>;
  type Publications = NonNullable<NonNullable<Context>["githubPublicationService"]>;
  type PendingReader = NonNullable<Placements["listPendingWorkspaceResults"]>;
  type ReconciliationReader = NonNullable<Placements["getWorkspaceResultReconcilingSessionIds"]>;

  expectTypeOf<Parameters<PendingReader>>().toEqualTypeOf<[sessionId?: string]>();
  expectTypeOf<ReturnType<PendingReader>>().toExtend<
    Array<{ sessionId: string; claimId: string }>
  >();
  expectTypeOf<Parameters<ReconciliationReader>>().toEqualTypeOf<[sessionIds: readonly string[]]>();
  expectTypeOf<ReturnType<ReconciliationReader>>().toEqualTypeOf<ReadonlySet<string>>();
  expectTypeOf<ReturnType<Publications["deferOrphanedRequests"]>>().toEqualTypeOf<void>();
  expectTypeOf<
    ReturnType<NonNullable<Placements["listPendingWorkspaceResultsAsync"]>>
  >().toEqualTypeOf<Promise<ReturnType<PendingReader>>>();
  expectTypeOf<
    ReturnType<NonNullable<Placements["getWorkspaceResultReconcilingSessionIdsAsync"]>>
  >().toEqualTypeOf<Promise<ReadonlySet<string>>>();
  expectTypeOf<ReturnType<Publications["deferOrphanedRequestsAsync"]>>().toEqualTypeOf<
    Promise<void>
  >();
});
