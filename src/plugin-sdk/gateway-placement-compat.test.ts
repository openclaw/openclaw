import type { GatewayRequestHandlerOptions as CoreHandler } from "openclaw/plugin-sdk/core";
import type {
  GatewayRequestHandlerOptions as RuntimeHandler,
  prepareGitHubPublicationRequesterV2,
  preparePersonalGitHubSessionActionV2,
} from "openclaw/plugin-sdk/gateway-runtime";
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
  // v2026.9.8 exposed these opaque callbacks through all three Gateway context entry points.
  type ReleasedRequesterData = {
    version: 1;
    actor: { kind: "operator"; profileId: string } | { kind: "system" };
    scopes: string[];
    grant: { pluginId: string; grantId: string; aliasBindingIds: string[] } | null;
  };
  type ReleasedRequesterSnapshot = Readonly<
    Omit<ReleasedRequesterData, "actor" | "scopes" | "grant"> & {
      actor: Readonly<ReleasedRequesterData["actor"]>;
      scopes: readonly string[];
      grant: Readonly<
        Omit<NonNullable<ReleasedRequesterData["grant"]>, "aliasBindingIds"> & {
          aliasBindingIds: readonly string[];
        }
      > | null;
    }
  >;
  type ReleasedRequester = Readonly<{
    snapshot: ReleasedRequesterSnapshot;
    assertCurrent: () => void;
  }> &
    Readonly<{ assertInvocationCurrent: () => void }>;
  type ReleasedPersonalConnectionAction = {
    owner: string;
    assertCurrent: () => void;
  };
  type ReleasedPersonalAction = ReleasedPersonalConnectionAction & {
    sessionId: string;
    sessionKey: string;
    agentId: string;
    lifecycleRevision: string | null;
  };
  expectTypeOf<
    Parameters<Publications["requestForClaim"]>[0]["requester"]
  >().toEqualTypeOf<ReleasedRequester>();
  expectTypeOf<
    Parameters<Publications["requestForSession"]>[0]["requester"]
  >().toEqualTypeOf<ReleasedRequester>();
  expectTypeOf<
    Parameters<Publications["requestPersonalForSession"]>[1]
  >().toEqualTypeOf<ReleasedPersonalAction>();
  expectTypeOf<
    Parameters<Publications["confirmPersonal"]>[1]
  >().toEqualTypeOf<ReleasedPersonalAction>();
  expectTypeOf<ReturnType<Publications["deferClaimPreparation"]>>().toEqualTypeOf<void>();
  expectTypeOf<ReturnType<Publications["markReported"]>>().toEqualTypeOf<void>();
  expectTypeOf<ReturnType<Publications["listUnreportedResults"]>>().toExtend<
    Array<{ result: { requestId: string }; sessionId: string; sessionKey: string; agentId: string }>
  >();
  type WorkerRequester = Parameters<Publications["requestForSessionV2"]>[0]["requester"];
  expectTypeOf<WorkerRequester["version"]>().toEqualTypeOf<2>();
  expectTypeOf<WorkerRequester["signal"]>().toEqualTypeOf<AbortSignal>();
  expectTypeOf<
    Awaited<ReturnType<typeof prepareGitHubPublicationRequesterV2>>["requester"]
  >().toEqualTypeOf<WorkerRequester>();
  expectTypeOf<
    Awaited<ReturnType<typeof preparePersonalGitHubSessionActionV2>>["action"]
  >().toEqualTypeOf<Parameters<Publications["requestPersonalForSessionV2"]>[1]>();
  expectTypeOf<ReturnType<WorkerRequester["prepareSource"]>>().toExtend<
    Promise<{ readonly version: 1; release(): Promise<void> }>
  >();
  expectTypeOf<ReturnType<Publications["markReportedAsync"]>>().toEqualTypeOf<Promise<void>>();
  expectTypeOf<ReturnType<Publications["listUnreportedResultsAsync"]>>().toEqualTypeOf<
    Promise<ReturnType<Publications["listUnreportedResults"]>>
  >();
  expectTypeOf<Parameters<Publications["personalStatusAsync"]>>().toEqualTypeOf<
    Parameters<Publications["personalStatus"]>
  >();
  expectTypeOf<ReturnType<Publications["personalStatusAsync"]>>().toEqualTypeOf<
    Promise<ReturnType<Publications["personalStatus"]>>
  >();
  type ManagedGitHub = NonNullable<NonNullable<Context>["githubOAuthService"]>;
  expectTypeOf<ReturnType<ManagedGitHub["cancelAuthorization"]>>().toEqualTypeOf<boolean>();
  expectTypeOf<ReturnType<ManagedGitHub["retireProfile"]>>().toEqualTypeOf<void>();
  expectTypeOf<Parameters<ManagedGitHub["cancelAuthorizationAsync"]>>().toEqualTypeOf<
    Parameters<ManagedGitHub["cancelAuthorization"]>
  >();
  expectTypeOf<Parameters<ManagedGitHub["retireProfileAsync"]>>().toEqualTypeOf<
    Parameters<ManagedGitHub["retireProfile"]>
  >();
  expectTypeOf<ReturnType<ManagedGitHub["cancelAuthorizationAsync"]>>().toEqualTypeOf<
    Promise<boolean>
  >();
  expectTypeOf<ReturnType<ManagedGitHub["retireProfileAsync"]>>().toEqualTypeOf<Promise<void>>();
  type PersonalGitHub = NonNullable<NonNullable<Context>["githubOAuthService"]>["personal"];
  expectTypeOf<Parameters<PersonalGitHub["cancelAuthorization"]>>().toEqualTypeOf<
    [action: ReleasedPersonalConnectionAction, requestId: string]
  >();
  expectTypeOf<Parameters<PersonalGitHub["disconnect"]>>().toEqualTypeOf<
    [action: ReleasedPersonalConnectionAction]
  >();
  expectTypeOf<ReturnType<PersonalGitHub["cancelAuthorization"]>>().toEqualTypeOf<boolean>();
  expectTypeOf<ReturnType<PersonalGitHub["disconnect"]>>().toEqualTypeOf<void>();
  expectTypeOf<Parameters<PersonalGitHub["cancelAuthorizationAsync"]>>().toEqualTypeOf<
    Parameters<PersonalGitHub["cancelAuthorization"]>
  >();
  expectTypeOf<Parameters<PersonalGitHub["disconnectAsync"]>>().toEqualTypeOf<
    Parameters<PersonalGitHub["disconnect"]>
  >();
  expectTypeOf<ReturnType<PersonalGitHub["cancelAuthorizationAsync"]>>().toEqualTypeOf<
    Promise<boolean>
  >();
  expectTypeOf<ReturnType<PersonalGitHub["disconnectAsync"]>>().toEqualTypeOf<Promise<void>>();
});
