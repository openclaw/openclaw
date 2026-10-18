import { vi } from "vitest";
import * as gatewayLockPayload from "../infra/gateway-lock-payload.js";
import * as gatewayStateOwner from "../infra/gateway-state-owner.js";
import * as processAncestry from "../infra/restart-stale-pids.js";

const hostPlatform = process.platform;

export function mockDoctorServicePlatform(platform: NodeJS.Platform): void {
  const actual = { ...gatewayStateOwner };
  const actualPayload = { ...gatewayLockPayload };
  const actualAncestry = { ...processAncestry };
  const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue(platform);
  // Service transports are synthetic; physical state and process probes keep the host rules.
  const onHost = <Args extends unknown[], Result>(operation: (...args: Args) => Result) => {
    return (...args: Args): Result => {
      const servicePlatform = process.platform;
      platformSpy.mockReturnValue(hostPlatform);
      try {
        return operation(...args);
      } finally {
        platformSpy.mockReturnValue(servicePlatform);
      }
    };
  };
  const acquireOnHost = <
    Args extends unknown[],
    Lease extends gatewayStateOwner.StateDatabaseSchemaLease | null | undefined,
  >(
    acquire: (...args: Args) => Lease,
  ) => {
    const acquireOwner = onHost(acquire);
    return (...args: Args): Lease => {
      const lease = acquireOwner(...args);
      if (lease) {
        lease.assertDatabaseAccess = onHost(lease.assertDatabaseAccess);
      }
      return lease;
    };
  };
  vi.spyOn(gatewayLockPayload, "readGatewayLockProcessNamespace").mockImplementation(
    onHost(actualPayload.readGatewayLockProcessNamespace),
  );
  vi.spyOn(gatewayLockPayload, "classifyGatewayLockProcessNamespace").mockImplementation(
    onHost(actualPayload.classifyGatewayLockProcessNamespace),
  );
  vi.spyOn(gatewayStateOwner, "resolveGatewayStateOwnerPath").mockImplementation(
    onHost(actual.resolveGatewayStateOwnerPath),
  );
  vi.spyOn(gatewayStateOwner, "acquireGatewayStateOwner").mockImplementation(
    acquireOnHost(actual.acquireGatewayStateOwner),
  );
  vi.spyOn(gatewayStateOwner, "acquireStateDatabaseSchemaLease").mockImplementation(
    acquireOnHost(actual.acquireStateDatabaseSchemaLease),
  );
  vi.spyOn(gatewayStateOwner, "tryAcquireGatewayStateOwner").mockImplementation(
    acquireOnHost(actual.tryAcquireGatewayStateOwner),
  );
  vi.spyOn(gatewayStateOwner, "tryBorrowGatewayStateOwner").mockImplementation(
    acquireOnHost(actual.tryBorrowGatewayStateOwner),
  );
  vi.spyOn(gatewayStateOwner, "hasActiveGatewayStateOwner").mockImplementation(
    onHost(actual.hasActiveGatewayStateOwner),
  );
  vi.spyOn(gatewayStateOwner, "assertStateDatabaseAccessAllowed").mockImplementation(
    onHost(actual.assertStateDatabaseAccessAllowed),
  );
  // Sibling fixtures may already own synthetic ancestry; only route real probes to the host.
  if (!vi.isMockFunction(actualAncestry.inspectSelfAndAncestorPidsSync)) {
    vi.spyOn(processAncestry, "inspectSelfAndAncestorPidsSync").mockImplementation(
      onHost(actualAncestry.inspectSelfAndAncestorPidsSync),
    );
  }
  if (!vi.isMockFunction(actualAncestry.getSelfAndAncestorPidsSync)) {
    vi.spyOn(processAncestry, "getSelfAndAncestorPidsSync").mockImplementation(
      onHost(actualAncestry.getSelfAndAncestorPidsSync),
    );
  }
}
