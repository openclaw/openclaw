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
  for (const key of [
    "OPENCLAW_HOME",
    "OPENCLAW_STATE_DIR",
    "OPENCLAW_CONFIG_PATH",
    "OPENCLAW_SUPERVISOR_MODE",
    "OPENCLAW_PROFILE",
    "OPENCLAW_SYSTEMD_UNIT",
    "OPENCLAW_LAUNCHD_LABEL",
    "OPENCLAW_WINDOWS_TASK_NAME",
  ]) {
    vi.stubEnv(key, undefined);
  }
  service = createMockGatewayService();
  boundary.service.mockReturnValue(service);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

function inspectService(assertCurrent = () => {}) {
  return maybeStopManagedServiceBeforeMutableUpdate({
    root,
    updateInstallKind: "package",
    shouldRestart: true,
    jsonMode: true,
    phase: "inspect",
    assertCurrent,
  });
}

function pendingCleanup() {
  const cleanup = createDeferredCore<"forced" | "uncertain">();
  const joining = createDeferredCore();
  return {
    retain() {
      retainCommandProcessCleanup(cleanup.promise);
      resolveCommandProcessSignal()?.addEventListener("abort", () => joining.resolve(), {
        once: true,
      });
    },
    async settle(work: Promise<unknown>, result: "forced" | "uncertain", beforeRelease = () => {}) {
      try {
        await Promise.race([
          joining.promise,
          work.then(() => {
            throw new Error("inspection escaped cleanup ownership");
          }),
        ]);
        beforeRelease();
      } finally {
        cleanup.resolve(result);
        await work;
      }
      return await work;
    },
  };
}

it.each(["forced", "uncertain"] as const)(
  "joins the maintenance fallback before returning unavailable (%s)",
  async (cleanupResult) => {
    const cleanup = pendingCleanup();
    boundary.read.mockRejectedValue(
      new GatewayServiceUpdateOwnershipError("recorded selector changed", undefined),
    );
    vi.mocked(service.isLoaded).mockImplementation(async () => {
      cleanup.retain();
      throw new Error("manager unavailable");
    });
    const work = inspectService().catch((error: unknown) => error);
    const result = await cleanup.settle(work, cleanupResult, () => {
      expect(service.stop).not.toHaveBeenCalled();
    });
    expect(hasCommandProcessCleanupError(result)).toBe(cleanupResult === "uncertain");
    if (cleanupResult === "forced") {
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

it("does not demote a canonical maintenance fallback failure to unavailable", async () => {
  const failure = new GatewayServiceUpdateOwnershipError(
    "manager cleanup failed",
    new CommandProcessCleanupError(),
  );
  boundary.read.mockRejectedValue(
    new GatewayServiceUpdateOwnershipError("recorded selector changed", undefined),
  );
  vi.mocked(service.isLoaded).mockRejectedValue(failure);
  await expect(inspectService()).rejects.toBe(failure);
  expect(service.stop).not.toHaveBeenCalled();
});

it("rechecks retained authority after confirmed maintenance fallback cleanup", async () => {
  const cleanup = pendingCleanup();
  const lost = new Error("original executor lost");
  let current = true;
  boundary.read.mockRejectedValue(
    new GatewayServiceUpdateOwnershipError("recorded selector changed", undefined),
  );
  vi.mocked(service.isLoaded).mockImplementation(async () => {
    cleanup.retain();
    throw new Error("manager unavailable");
  });
  const work = inspectService(() => {
    if (!current) {
      throw lost;
    }
  }).catch((error: unknown) => error);
  const result = await cleanup.settle(work, "forced", () => {
    current = false;
  });
  expect(result).toBe(lost);
  expect(service.stop).not.toHaveBeenCalled();
});

it.each([
  { owned: false, cleanupResult: "forced" },
  { owned: false, cleanupResult: "uncertain" },
  { owned: true, cleanupResult: "forced" },
] as const)(
  "settles context inspection before publishing selected contexts (owned=$owned, $cleanupResult)",
  async ({ owned, cleanupResult }) => {
    const cleanup = pendingCleanup();
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
    boundary.inspect.mockImplementation(async () => {
      cleanup.retain();
      return inspected;
    });
    boundary.callerContext.mockResolvedValue(caller);
    boundary.managedContext.mockResolvedValue(owned ? managed : undefined);
    const work = inspectUpdateDatabaseContexts({
      roots: [root],
      updateInstallKind: "package",
      shouldRestart: true,
      jsonMode: true,
      timeoutMs: 1_000,
      managedServiceRootRedirect: null,
    }).catch((error: unknown) => error);
    const result = await cleanup.settle(work, cleanupResult);
    expect(hasCommandProcessCleanupError(result)).toBe(cleanupResult === "uncertain");
    if (cleanupResult === "forced") {
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

it("preserves nested cleanup uncertainty before capturing database contexts", async () => {
  const failure = new GatewayServiceUpdateOwnershipError(
    "inspection cleanup failed",
    new CommandProcessCleanupError(),
  );
  boundary.inspect.mockRejectedValue(failure);
  await expect(
    inspectUpdateDatabaseContexts({
      roots: [root],
      updateInstallKind: "package",
      shouldRestart: true,
      jsonMode: true,
      timeoutMs: 1_000,
      managedServiceRootRedirect: null,
    }),
  ).rejects.toBe(failure);
  expect(boundary.callerContext).not.toHaveBeenCalled();
  expect(boundary.managedContext).not.toHaveBeenCalled();
});
