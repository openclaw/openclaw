import "./test-helpers/schtasks-base-mocks.js";
import type { SpawnSyncOptions } from "node:child_process";
import { vi } from "vitest";
import type { SpawnSyncResult, TaskProbeResult } from "./test-helpers/schtasks-fixtures.js";

const timeState = vi.hoisted(() => ({ now: 0 }));
const sleepMock = vi.hoisted(() =>
  vi.fn(async (ms: number) => {
    timeState.now += ms;
  }),
);
const childUnref = vi.hoisted(() => vi.fn());
const spawn = vi.hoisted(() => vi.fn());
const spawnSync = vi.hoisted(() =>
  vi.fn<
    (command: string, args?: readonly string[], options?: SpawnSyncOptions) => SpawnSyncResult
  >(),
);
const taskProbe = vi.hoisted(() =>
  vi.fn<
    (command: string, args?: readonly string[], options?: SpawnSyncOptions) => TaskProbeResult
  >(),
);

const verifiedGatewayPids = vi.hoisted(() => vi.fn<(port: number) => number[]>(() => []));

vi.mock("../utils.js", async () => {
  const actual = await vi.importActual<typeof import("../utils.js")>("../utils.js");
  return {
    ...actual,
    sleep: (ms: number) => sleepMock(ms),
  };
});

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    spawn,
    spawnSync: (command: string, args?: readonly string[], options?: SpawnSyncOptions) => {
      const encoded = args?.indexOf("-EncodedCommand") ?? -1;
      if (
        encoded >= 0 &&
        Buffer.from(args?.[encoded + 1] ?? "", "base64")
          .toString("utf16le")
          .includes("Schedule.Service")
      ) {
        return taskProbe(command, args, options);
      }
      return spawnSync(command, args, options);
    },
  };
});
// mock-isolation: Windows fallback cases must not inspect or signal live gateway processes.
vi.mock("../infra/gateway-processes.js", () => ({
  findVerifiedGatewayListenerPidsOnPortSync: () => {
    throw new Error("Fallback runtime must await listener ownership inspection");
  },
  findVerifiedGatewayListenerPidsOnPort: async (port: number) => verifiedGatewayPids(port),
}));

export { timeState, sleepMock, childUnref, spawn, spawnSync, taskProbe, verifiedGatewayPids };
