import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { GatewayServiceState } from "../../daemon/service-types.js";
import * as serviceBoundary from "../../daemon/service.js";
import type { GatewayService } from "../../daemon/service.js";
import {
  createMockGatewayService,
  mockSystemAccountHome,
} from "../../daemon/service.test-helpers.js";
import {
  CommandProcessCleanupError,
  hasCommandProcessCleanupError,
} from "../../process/exec-result.js";
import * as schemaPreflight from "./schema-preflight.js";
import { inspectUpdateDatabaseContexts } from "./update-command-database-context.js";
import { retainedInspectionCleanup } from "./update-command-inspection-settlement.test-support.js";
import * as managedContext from "./update-command-managed-context.js";
import type { PreManagedServiceStop } from "./update-command-service-context-types.js";
import { maintenanceDefaults } from "./update-command-service-fixtures.test-support.js";
import { maybeStopManagedServiceBeforeMutableUpdate } from "./update-command-service-maintenance.js";
import {
  GatewayServiceUpdateOwnershipError,
  readManagedGatewayServiceForUpdate,
} from "./update-command-service-plan.js";
import * as serviceCommands from "./update-command-service.js";

const boundary = {
  service: vi.fn<() => GatewayService>(),
  read: vi.fn<typeof serviceBoundary.readGatewayServiceState>(),
  inspect: vi.fn(),
  callerContext: vi.fn(),
  managedContext: vi.fn(),
};
let service: GatewayService;
beforeEach(() => {
  service = createMockGatewayService();
  boundary.service.mockReturnValue(service);
  vi.spyOn(serviceBoundary, "resolveGatewayService").mockImplementation(boundary.service);
  vi.spyOn(serviceBoundary, "readGatewayServiceState").mockImplementation(boundary.read);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

describe("service reader settlement", () => {
  const command = {
    programArguments: ["/synthetic/node", "/synthetic/install/dist/index.js", "gateway"],
  };
  const dirs = useAutoCleanupTempDirTracker(afterEach);
  function state(owned: boolean, serviceCommand = command): GatewayServiceState {
    return {
      installed: true,
      running: owned,
      env: {},
      command: serviceCommand,
      loadState: owned
        ? { status: "loaded" }
        : { status: "unknown", detail: "manager unavailable" },
      runtime: owned
        ? { status: "running", systemd: { managerUid: 2001 } }
        : { status: "unknown", inspectionReason: "service-manager-unavailable" },
    };
  }

  it.each([
    ["inspection", "uncertain", false],
    ["fallback", "forced", false],
    ["inspection", "forced", true],
    ["inspection", "canonical", false],
    ["fallback", "canonical", false],
  ] as const)(
    "settles %s %s cleanup before publishing ownership=%s",
    async (phase, kind, owned) => {
      let installRoot: string | undefined;
      let selectedCommand = command;
      if (owned) {
        installRoot = await fs.realpath(dirs.make("service-reader-owned-package-"));
        const entrypoint = path.join(installRoot, "dist", "index.js");
        await fs.mkdir(path.dirname(entrypoint));
        await fs.writeFile(
          path.join(installRoot, "package.json"),
          JSON.stringify({ name: "openclaw", version: "2026.9.4" }),
        );
        await fs.writeFile(entrypoint, "// isolated ownership fixture\n");
        selectedCommand = { programArguments: [process.execPath, entrypoint, "gateway"] };
      }
      const cleanup = retainedInspectionCleanup();
      const failure = new GatewayServiceUpdateOwnershipError(
        "inspection failed",
        new CommandProcessCleanupError(),
      );
      const read = async () => {
        if (kind === "canonical") {
          throw failure;
        }
        cleanup.retain();
        return state(owned, selectedCommand);
      };
      boundary.read.mockImplementation(read);
      if (phase === "fallback") {
        boundary.read.mockRejectedValue(
          new GatewayServiceUpdateOwnershipError("recorded selector changed", undefined),
        );
        vi.mocked(service.isLoaded).mockImplementation(async () => {
          await read();
          throw new Error("manager unavailable");
        });
      }
      if (kind === "canonical") {
        await expect(readManagedGatewayServiceForUpdate({})).rejects.toBe(failure);
      } else {
        const finished = vi.fn();
        const work = readManagedGatewayServiceForUpdate({})
          .catch((error: unknown) => error)
          .finally(finished);
        const result = await cleanup.join(work, kind, () =>
          expect(finished).not.toHaveBeenCalled(),
        );
        expect(hasCommandProcessCleanupError(result)).toBe(kind === "uncertain");
        if (owned) {
          expect(result).toMatchObject({
            verdict: { kind: "owned", root: installRoot, refreshDefinition: true },
          });
          assert(typeof result === "object" && result !== null && "command" in result);
          expect(result.command).toBe(selectedCommand);
        } else if (kind === "forced") {
          expect(result).toBeNull();
        }
      }
    },
  );
});

describe("maintenance inspection settlement", () => {
  const root = "/synthetic/install";
  beforeEach(() => {
    mockSystemAccountHome();
    for (const suffix of "HOME STATE_DIR CONFIG_PATH SUPERVISOR_MODE PROFILE SYSTEMD_UNIT LAUNCHD_LABEL WINDOWS_TASK_NAME".split(
      " ",
    )) {
      vi.stubEnv(`OPENCLAW_${suffix}`, undefined);
    }
    vi.spyOn(serviceCommands, "maybeStopManagedServiceBeforeMutableUpdate").mockImplementation(
      boundary.inspect,
    );
    vi.spyOn(schemaPreflight, "captureTargetDatabaseSchemaContext").mockImplementation(
      boundary.callerContext,
    );
    vi.spyOn(managedContext, "captureOwnedManagedUpdatePreflightContext").mockImplementation(
      boundary.managedContext,
    );
  });
  type Outcome = "forced" | "uncertain" | "nested failure" | "revoked";
  function pendingCleanup(outcome: Outcome) {
    const cleanup = retainedInspectionCleanup();
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
        cleanup.retain();
        return value;
      },
      async settle(inspection: Promise<unknown>, beforeRelease = () => {}) {
        if (outcome === "nested failure") {
          await expect(inspection).rejects.toBe(failure);
          return failure;
        }
        const work = inspection.catch((error: unknown) => error);
        return await cleanup.join(work, outcome === "revoked" ? "forced" : outcome, beforeRelease);
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
      }
    },
  );
});
