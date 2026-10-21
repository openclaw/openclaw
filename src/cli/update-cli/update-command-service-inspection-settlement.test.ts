import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { GatewayService, readGatewayServiceState } from "../../daemon/service.js";
import {
  createMockGatewayService,
  mockSystemAccountHome,
} from "../../daemon/service.test-helpers.js";
import {
  CommandProcessCleanupError,
  hasCommandProcessCleanupError,
} from "../../process/exec-result.js";
import {
  resolveCommandProcessSignal,
  retainCommandProcessCleanup,
} from "../../process/exec-spawn.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { inspectUpdateDatabaseContexts } from "./update-command-database-context.js";
import type { PreManagedServiceStop } from "./update-command-service-context-types.js";
import { maintenanceDefaults } from "./update-command-service-fixtures.test-support.js";
import { maybeStopManagedServiceBeforeMutableUpdate } from "./update-command-service-maintenance.js";
import { GatewayServiceUpdateOwnershipError } from "./update-command-service-plan.js";

const boundary = vi.hoisted(() => ({
  service: vi.fn<() => GatewayService>(),
  read: vi.fn<typeof readGatewayServiceState>(),
  inspect: vi.fn(),
  callerContext: vi.fn(),
  managedContext: vi.fn(),
}));
vi.mock("../../daemon/service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../daemon/service.js")>()),
  resolveGatewayService: boundary.service,
  readGatewayServiceState: boundary.read,
}));
vi.mock("./update-command-service.js", () => ({
  maybeStopManagedServiceBeforeMutableUpdate: boundary.inspect,
}));
vi.mock("./schema-preflight.js", () => ({
  captureTargetDatabaseSchemaContext: boundary.callerContext,
}));
vi.mock("./update-command-managed-context.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-command-managed-context.js")>()),
  captureOwnedManagedUpdatePreflightContext: boundary.managedContext,
}));

const root = "/synthetic/install";
let service: GatewayService;
beforeEach(() => {
  mockSystemAccountHome();
  const suffixes =
    "HOME STATE_DIR CONFIG_PATH SUPERVISOR_MODE PROFILE SYSTEMD_UNIT LAUNCHD_LABEL WINDOWS_TASK_NAME";
  for (const suffix of suffixes.split(" ")) {
    vi.stubEnv(`OPENCLAW_${suffix}`, undefined);
  }
  service = createMockGatewayService();
  boundary.service.mockReturnValue(service);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

type Outcome = "forced" | "uncertain" | "nested failure" | "revoked";
function pendingCleanup(outcome: Outcome) {
  const cleanup = createDeferredCore<"forced" | "uncertain">();
  const joining = createDeferredCore();
  const failure =
    outcome === "nested failure"
      ? new GatewayServiceUpdateOwnershipError(
          "inspection cleanup failed",
          new CommandProcessCleanupError(),
        )
      : new Error("original executor lost");
  return {
    failure,
    retain<T>(value?: T) {
      if (outcome === "nested failure") {
        throw failure;
      }
      retainCommandProcessCleanup(cleanup.promise);
      resolveCommandProcessSignal()?.addEventListener("abort", () => joining.resolve(), {
        once: true,
      });
      return value;
    },
    async settle(inspection: Promise<unknown>, beforeRelease = () => {}) {
      if (outcome === "nested failure") {
        await expect(inspection).rejects.toBe(failure);
        return failure;
      }
      const work = inspection.catch((error: unknown) => error);
      try {
        await Promise.race([
          joining.promise,
          work.then(() => {
            throw new Error("inspection escaped cleanup ownership");
          }),
        ]);
        beforeRelease();
      } finally {
        cleanup.resolve(outcome === "revoked" ? "forced" : outcome);
        await work;
      }
      return await work;
    },
  };
}

it.each(["forced", "uncertain", "revoked", "nested failure"] as const)(
  "settles the maintenance fallback without losing cleanup or authority failure: %s",
  async (outcome) => {
    const cleanup = pendingCleanup(outcome);
    const { failure } = cleanup;
    let current = true;
    boundary.read.mockRejectedValue(
      new GatewayServiceUpdateOwnershipError("recorded selector changed", undefined),
    );
    vi.mocked(service.isLoaded).mockImplementation(async () => {
      cleanup.retain();
      throw new Error("manager unavailable");
    });
    const inspection = maybeStopManagedServiceBeforeMutableUpdate({
      ...maintenanceDefaults,
      root,
      phase: "inspect",
      assertCurrent: () => {
        if (!current) {
          throw failure;
        }
      },
    });
    const result = await cleanup.settle(inspection, () => {
      expect(service.stop).not.toHaveBeenCalled();
      current = outcome !== "revoked";
    });
    expect(hasCommandProcessCleanupError(result)).toBe(
      outcome === "uncertain" || outcome === "nested failure",
    );
    if (outcome === "nested failure" || outcome === "revoked") {
      expect(result).toBe(failure);
    } else if (outcome === "forced") {
      expect(result).toEqual({
        stopped: false,
        inspected: false,
        runtimeInspected: false,
        running: false,
        serviceMutationAllowed: false,
        serviceUpdateVerdict: { kind: "unavailable", message: expect.any(String) },
        serviceMutationSkipMessage: expect.any(String),
      });
    }
    expect(service.stop).not.toHaveBeenCalled();
  },
);

it.each([
  { owned: false, cleanupResult: "forced" },
  { owned: false, cleanupResult: "uncertain" },
  { owned: true, cleanupResult: "forced" },
  { owned: false, cleanupResult: "nested failure" },
] as const)(
  "settles context inspection before publishing selected contexts (owned=$owned, $cleanupResult)",
  async ({ owned, cleanupResult }) => {
    const cleanup = pendingCleanup(cleanupResult);
    const caller = { env: { OPENCLAW_STATE_DIR: "/synthetic/caller" }, config: {} };
    const managed = { env: { OPENCLAW_STATE_DIR: "/synthetic/managed" }, config: {} };
    const inspected: PreManagedServiceStop = {
      stopped: false,
      inspected: owned,
      runtimeInspected: owned,
      running: owned,
      ...(owned ? { serviceEnv: managed.env } : {}),
      serviceUpdateVerdict: owned
        ? { kind: "owned", root, fingerprint: "definition", refreshDefinition: true }
        : { kind: "unavailable", message: "manager unavailable" },
    };
    boundary.inspect.mockImplementation(async () => cleanup.retain(inspected));
    boundary.callerContext.mockResolvedValue(caller);
    boundary.managedContext.mockResolvedValue(owned ? managed : undefined);
    const inspection = inspectUpdateDatabaseContexts({
      roots: [root],
      ...maintenanceDefaults,
      timeoutMs: 1_000,
      managedServiceRootRedirect: null,
    });
    const result = await cleanup.settle(inspection);
    expect(hasCommandProcessCleanupError(result)).toBe(cleanupResult !== "forced");
    if (cleanupResult === "nested failure") {
      expect(result).toBe(cleanup.failure);
      expect(boundary.callerContext).not.toHaveBeenCalled();
      expect(boundary.managedContext).not.toHaveBeenCalled();
    } else if (cleanupResult === "forced") {
      expect(result).toEqual({
        service: owned ? inspected : undefined,
        services: new Map([[root, inspected]]),
        contexts: owned ? [caller, managed] : [caller],
        managedEnv: owned ? managed.env : undefined,
      });
      expect(boundary.managedContext).toHaveBeenCalledWith(
        expect.objectContaining({ stopState: owned ? inspected : undefined }),
      );
    }
  },
);
