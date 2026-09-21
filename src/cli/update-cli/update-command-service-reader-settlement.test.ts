import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type {
  GatewayServiceCommandConfig,
  GatewayServiceState,
} from "../../daemon/service-types.js";
import type { GatewayService, readGatewayServiceState } from "../../daemon/service.js";
import { createMockGatewayService } from "../../daemon/service.test-helpers.js";
import {
  CommandProcessCleanupError,
  hasCommandProcessCleanupError,
} from "../../process/exec-result.js";
import {
  resolveCommandProcessSignal,
  retainCommandProcessCleanup,
} from "../../process/exec-spawn.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  GatewayServiceUpdateOwnershipError,
  readManagedGatewayServiceForUpdate,
} from "./update-command-service-plan.js";

const boundary = vi.hoisted(() => ({
  service: vi.fn<() => GatewayService>(),
  read: vi.fn<typeof readGatewayServiceState>(),
}));
vi.mock("../../daemon/service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../daemon/service.js")>()),
  resolveGatewayService: boundary.service,
  readGatewayServiceState: boundary.read,
}));

const root = "/synthetic/install";
const command: GatewayServiceCommandConfig = {
  programArguments: ["/synthetic/node", `${root}/dist/index.js`, "gateway"],
};
const dirs = useAutoCleanupTempDirTracker(afterEach);
function state(owned: boolean, serviceCommand = command): GatewayServiceState {
  return {
    installed: true,
    running: owned,
    env: {},
    command: serviceCommand,
    loadState: owned ? { status: "loaded" } : { status: "unknown", detail: "manager unavailable" },
    runtime: owned
      ? { status: "running", systemd: { managerUid: 2001 } }
      : { status: "unknown", inspectionReason: "service-manager-unavailable" },
  };
}

let service: GatewayService;
beforeEach(() => {
  service = createMockGatewayService();
  boundary.service.mockReturnValue(service);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

it.each(
  (["inspection", "fallback"] as const).flatMap((phase) =>
    (["forced", "uncertain"] as const).map((cleanupResult) => ({ phase, cleanupResult })),
  ),
)(
  "joins $phase cleanup before returning unavailable ($cleanupResult)",
  async ({ phase, cleanupResult }) => {
    const cleanup = createDeferredCore<"forced" | "uncertain">();
    const joining = createDeferredCore();
    const retainCleanup = () => {
      retainCommandProcessCleanup(cleanup.promise);
      resolveCommandProcessSignal()?.addEventListener("abort", () => joining.resolve(), {
        once: true,
      });
    };
    if (phase === "inspection") {
      boundary.read.mockImplementation(async () => {
        retainCleanup();
        return state(false);
      });
    } else {
      boundary.read.mockRejectedValue(
        new GatewayServiceUpdateOwnershipError("recorded selector changed", undefined),
      );
      vi.mocked(service.isLoaded).mockImplementation(async () => {
        retainCleanup();
        throw new Error("manager unavailable");
      });
    }
    let finished = false;
    const work = readManagedGatewayServiceForUpdate({})
      .catch((error: unknown) => error)
      .finally(() => {
        finished = true;
      });
    try {
      await Promise.race([
        joining.promise,
        work.then(() => {
          throw new Error("service selection returned before cleanup joined");
        }),
      ]);
      expect(finished).toBe(false);
    } finally {
      cleanup.resolve(cleanupResult);
      await work;
    }
    const result = await work;
    expect(hasCommandProcessCleanupError(result)).toBe(cleanupResult === "uncertain");
    if (cleanupResult === "forced") {
      expect(result).toBeNull();
    }
    expect(service.isLoaded).toHaveBeenCalledTimes(phase === "fallback" ? 1 : 0);
  },
);

it.each(["inspection", "fallback"] as const)(
  "preserves nested canonical cleanup failure from %s",
  async (phase) => {
    const cleanup = new CommandProcessCleanupError();
    const failure = new GatewayServiceUpdateOwnershipError("inspection failed", cleanup);
    if (phase === "inspection") {
      boundary.read.mockRejectedValue(failure);
    } else {
      boundary.read.mockRejectedValue(
        new GatewayServiceUpdateOwnershipError("recorded selector changed", undefined),
      );
      vi.mocked(service.isLoaded).mockRejectedValue(failure);
    }
    await expect(readManagedGatewayServiceForUpdate({})).rejects.toBe(failure);
    expect(service.isLoaded).toHaveBeenCalledTimes(phase === "fallback" ? 1 : 0);
  },
);

it("returns the verified command and ownership verdict only after confirmed cleanup", async () => {
  const installRoot = await fs.realpath(dirs.make("service-reader-owned-package-"));
  const entrypoint = path.join(installRoot, "dist", "index.js");
  await fs.mkdir(path.dirname(entrypoint));
  await fs.writeFile(
    path.join(installRoot, "package.json"),
    JSON.stringify({ name: "openclaw", version: "2026.9.4" }),
  );
  await fs.writeFile(entrypoint, "// isolated ownership fixture\n");
  const ownedCommand: GatewayServiceCommandConfig = {
    programArguments: [process.execPath, entrypoint, "gateway"],
  };
  const cleanup = createDeferredCore<"forced">();
  const joining = createDeferredCore();
  boundary.read.mockImplementation(async () => {
    retainCommandProcessCleanup(cleanup.promise);
    resolveCommandProcessSignal()?.addEventListener("abort", () => joining.resolve(), {
      once: true,
    });
    return state(true, ownedCommand);
  });
  let selected = false;
  const work = readManagedGatewayServiceForUpdate({}).then((result) => {
    selected = true;
    return result;
  });
  try {
    await Promise.race([
      joining.promise,
      work.then(() => {
        throw new Error("owned command escaped cleanup ownership");
      }),
    ]);
    expect(selected).toBe(false);
  } finally {
    cleanup.resolve("forced");
    await work;
  }
  const result = await work;
  expect(result?.command).toBe(ownedCommand);
  expect(result?.verdict).toMatchObject({
    kind: "owned",
    root: installRoot,
    refreshDefinition: true,
  });
  expect(service.isLoaded).not.toHaveBeenCalled();
});
