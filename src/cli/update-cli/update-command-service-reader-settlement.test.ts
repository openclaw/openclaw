import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, assert, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { GatewayServiceState } from "../../daemon/service-types.js";
import type { GatewayService, readGatewayServiceState } from "../../daemon/service.js";
import { createMockGatewayService } from "../../daemon/service.test-helpers.js";
import {
  CommandProcessCleanupError,
  hasCommandProcessCleanupError,
} from "../../process/exec-result.js";
import { retainedInspectionCleanup } from "./update-command-inspection-settlement.test-support.js";
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

it.each([
  ["inspection", "uncertain", false],
  ["fallback", "forced", false],
  ["inspection", "forced", true],
  ["inspection", "canonical", false],
  ["fallback", "canonical", false],
] as const)("settles %s %s cleanup before publishing ownership=%s", async (phase, kind, owned) => {
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
    const result = await cleanup.join(work, kind, () => expect(finished).not.toHaveBeenCalled());
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
  expect(service.isLoaded).toHaveBeenCalledTimes(phase === "fallback" ? 1 : 0);
});
