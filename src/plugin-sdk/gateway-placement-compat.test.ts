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
  type Dispatch = NonNullable<NonNullable<Context>["workerPlacementDispatchService"]>;
  type Grants = NonNullable<NonNullable<Context>["placementStandingGrants"]>;
  type ReleasedBinding = {
    pluginId: string;
    command: string;
    approvalScope: string;
    agentId: string;
    sessionKey: string;
    nodeId: string;
    pairingGeneration: string;
    sessionId: string;
    environmentId: string;
    ownerEpoch: number;
    placementGeneration: number;
    cwd: string;
  };
  type ReleasedBindingInput = Pick<
    ReleasedBinding,
    | "pluginId"
    | "command"
    | "approvalScope"
    | "agentId"
    | "sessionKey"
    | "nodeId"
    | "pairingGeneration"
  >;
  type ReleasedGrantResult =
    | {
        outcome: "consumed";
        grant: ReleasedBinding & { mintedByApprovalId: string; expiresAtMs: number };
      }
    | {
        outcome:
          | "no-grant"
          | "expired"
          | "approval-missing"
          | "approval-not-allow-always"
          | "placement-missing"
          | "placement-changed"
          | "node-changed"
          | "pairing-changed";
      };
  type ReleasedGrants = {
    resolveBinding: (input: ReleasedBindingInput) => ReleasedBinding | null;
    retain: (
      grant: ReleasedBinding & {
        approvalId: string;
        nowMs: number;
        expiresAtMs: number | null;
      },
    ) => boolean;
    validate: (binding: ReleasedBinding) => ReleasedGrantResult;
    consume: (binding: ReleasedBinding) => ReleasedGrantResult;
  };
  expectTypeOf<ReleasedGrants>().toExtend<Grants>();
  expectTypeOf<Pick<Grants, keyof ReleasedGrants>>().toEqualTypeOf<ReleasedGrants>();
  expectTypeOf<Parameters<Placements["getMany"]>>().toEqualTypeOf<
    [sessionIds: readonly string[]]
  >();
  expectTypeOf<ReturnType<Placements["getMany"]>>().toExtend<
    ReadonlyMap<string, { sessionId: string }>
  >();
  type Retirement = NonNullable<Placements["retireSessionPlacement"]>;
  expectTypeOf<Parameters<Retirement>>().toEqualTypeOf<
    [
      input: {
        sessionId: string;
        expectedState: "local" | "requested" | "reclaimed" | "failed";
        expectedGeneration: number;
      },
    ]
  >();
  expectTypeOf<ReturnType<Retirement>>().toEqualTypeOf<void>();
  type Demand = NonNullable<Dispatch["getAdmittedDeviceSessionCounts"]>;
  expectTypeOf<Parameters<Demand>>().toEqualTypeOf<[excludeSessionId?: string]>();
  expectTypeOf<ReturnType<Demand>>().toEqualTypeOf<ReadonlyMap<string, number>>();
  expectTypeOf<ReturnType<NonNullable<Placements["getManyAsync"]>>>().toEqualTypeOf<
    Promise<ReturnType<Placements["getMany"]>>
  >();
  expectTypeOf<ReturnType<NonNullable<Placements["retireSessionPlacementAsync"]>>>().toEqualTypeOf<
    Promise<void>
  >();
  expectTypeOf<
    ReturnType<NonNullable<Dispatch["getAdmittedDeviceSessionCountsAsync"]>>
  >().toEqualTypeOf<Promise<ReadonlyMap<string, number>>>();
  type ReclaimSourceCheck = NonNullable<Parameters<NonNullable<Dispatch["reclaim"]>>[2]>;
  type ReleasedReclaimSourceCheck = (predecessor?: Parameters<ReclaimSourceCheck>[0]) => void;
  expectTypeOf<ReleasedReclaimSourceCheck>().toExtend<ReclaimSourceCheck>();
  expectTypeOf<ReturnType<ReclaimSourceCheck>>().toEqualTypeOf<void>();
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
