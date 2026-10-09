import { Command } from "commander";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { registerDevicesCli } from "../cli/devices-cli.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../state/openclaw-state-db-cache.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { approveDevicePairing } from "./device-pairing-approval.js";
import {
  clearDevicePairing,
  listDevicePairing,
  rejectDevicePairing,
  removePairedDevice,
  requestDevicePairing,
} from "./device-pairing.js";

const { callGateway, runtime } = vi.hoisted(() => ({
  callGateway: vi.fn(),
  runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn(), writeJson: vi.fn() },
}));
vi.mock("../gateway/call.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../gateway/call.js")>()),
  callGateway,
  formatGatewayTransportErrorJson: () => null,
  buildGatewayConnectionDetails: () => ({
    url: "ws://127.0.0.1:18789",
    urlSource: "local loopback",
    message: "",
  }),
}));
vi.mock("../cli/progress.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../cli/progress.js")>()),
  withProgress: async (_opts: unknown, fn: () => Promise<unknown>) => await fn(),
}));
vi.mock("../runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../runtime.js")>()),
  defaultRuntime: runtime,
}));

let baseDir: string;
let database: ReturnType<typeof openOpenClawStateDatabase>;
const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterAll(async () => {
    await closeOpenClawStateDatabaseByPathAsync(database.path);
    cleanup();
  }),
);
beforeAll(() => {
  baseDir = tempDirs.make("devices-clear-composition-");
  database = openOpenClawStateDatabase({
    env: { ...process.env, OPENCLAW_STATE_DIR: baseDir },
  });
  // Only transport is replaced: each RPC executes its production pairing owner.
  callGateway.mockImplementation(
    async ({ method, params }: { method: string; params: Record<string, unknown> }) => {
      if (method === "device.pair.clear") {
        const cleared = await clearDevicePairing({ pending: params.pending === true }, baseDir);
        return {
          removedDevices: cleared.removedDevices,
          rejectedPending: cleared.rejectedRequests.map((request) => request.requestId),
        };
      }
      if (method === "device.pair.list") {
        return await listDevicePairing(baseDir);
      }
      if (method === "device.pair.remove") {
        return await removePairedDevice(String(params.deviceId), baseDir);
      }
      if (method === "device.pair.reject") {
        const rejected = await rejectDevicePairing(String(params.requestId), baseDir);
        if (!rejected) {
          throw new Error("unknown requestId");
        }
        return rejected;
      }
      throw new Error(`Unexpected method: ${method}`);
    },
  );
});

test("clears a paired repair once and reports exact committed IDs as one JSON document", async () => {
  const request = await requestDevicePairing(
    { deviceId: "synthetic-device", publicKey: "original-key", role: "operator", scopes: [] },
    baseDir,
  );
  await approveDevicePairing(request.request.requestId, { callerScopes: [] }, baseDir);
  const repair = await requestDevicePairing(
    { deviceId: "synthetic-device", publicKey: "replacement-key", role: "operator", scopes: [] },
    baseDir,
  );
  expect(repair.request.isRepair).toBe(true);
  const runClear = async () => {
    const program = new Command().exitOverride();
    registerDevicesCli(program);
    await program.parseAsync(["devices", "clear", "--yes", "--pending", "--json"], {
      from: "user",
    });
  };

  await runClear();

  expect(runtime.writeJson).toHaveBeenCalledExactlyOnceWith({
    removedDevices: ["synthetic-device"],
    rejectedPending: [repair.request.requestId],
  });
  expect(runtime.log).not.toHaveBeenCalled();
  expect(await listDevicePairing(baseDir)).toEqual({ pending: [], paired: [] });
  await runClear();
  expect(runtime.writeJson).toHaveBeenLastCalledWith({ removedDevices: [], rejectedPending: [] });
});
