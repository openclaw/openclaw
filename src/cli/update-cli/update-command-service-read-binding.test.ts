import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { GatewayService } from "../../daemon/service.js";
import {
  createMockGatewayService,
  mockSystemAccountHome,
} from "../../daemon/service.test-helpers.js";
import { readSystemdServiceExecStart } from "../../daemon/systemd.js";
import * as openClawTmp from "../../infra/tmp-openclaw-dir.js";
import { mockProcessPlatform } from "../../test-utils/vitest-spies.js";
import { maybeStopManagedServiceBeforeMutableUpdate } from "./update-command-service-maintenance.js";

const mocks = vi.hoisted(() => ({
  service: vi.fn<() => GatewayService>(),
  command: vi.fn<typeof import("../../daemon/systemd.js").readSystemdServiceExecStart>(),
  admitRead: vi.fn<typeof import("../../daemon/systemd-peer.js").admitSystemdServiceReadBinding>(),
}));

vi.mock("../../daemon/service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../daemon/service.js")>()),
  resolveGatewayService: mocks.service,
}));
vi.mock("../../daemon/systemd.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../daemon/systemd.js")>()),
  readSystemdServiceExecStart: mocks.command,
}));
// The real facade and scope owner run against synthetic native observations only.
vi.mock("../../daemon/systemd-peer.js", () => ({
  admitSystemdServiceReadBinding: mocks.admitRead,
}));

const dirs = useAutoCleanupTempDirTracker(afterEach);
let home: string;
beforeEach(async () => {
  vi.resetAllMocks();
  home = await fs.realpath(dirs.make("openclaw-service-read-binding-"));
  mockProcessPlatform("linux");
  mockSystemAccountHome();
  vi.spyOn(openClawTmp, "resolvePreferredOpenClawTmpDir").mockReturnValue(home);
  for (const key of [
    "OPENCLAW_HOME",
    "OPENCLAW_STATE_DIR",
    "OPENCLAW_CONFIG_PATH",
    "OPENCLAW_PROFILE",
    "OPENCLAW_SYSTEMD_UNIT",
    "OPENCLAW_SUPERVISOR_MODE",
    "OPENCLAW_SERVICE_MARKER",
    "OPENCLAW_SERVICE_KIND",
    "OPENCLAW_UPDATE_RUN_HANDOFF",
    "XDG_RUNTIME_DIR",
    "DBUS_SESSION_BUS_ADDRESS",
    "SUDO_USER",
  ]) {
    vi.stubEnv(key, undefined);
  }
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  mocks.admitRead.mockResolvedValue(undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it.each([false, true])(
  "retains the admitted read environment through pre-stop revalidation (peer=%s)",
  async (peer) => {
    const command = {
      programArguments: [process.execPath, path.join(process.cwd(), "openclaw.mjs"), "gateway"],
      // Installed services materialize defaults that the independent CLI shell omits.
      environment: {
        HOME: home,
        OPENCLAW_SYSTEMD_UNIT: "openclaw-gateway.service",
        OPENCLAW_STATE_DIR: path.join(home, ".openclaw"),
      },
    };
    mocks.command.mockResolvedValue(command);
    let assertStopped = () => undefined as void;
    const stop = vi.fn<GatewayService["stop"]>(async (args) => {
      if (!args.assertCurrent) {
        throw new Error("missing native ownership assertion");
      }
      args.assertCurrent();
      assertStopped = args.assertCurrent;
    });
    const service = createMockGatewayService({
      readCommand: readSystemdServiceExecStart,
      readRuntime: async () => ({ status: "running", systemd: { managerUid: 2001 } }),
      isLoaded: async () => true,
      stop,
    });
    mocks.service.mockReturnValue(service);
    const params = {
      root: process.cwd(),
      updateInstallKind: "package" as const,
      shouldRestart: true,
      jsonMode: true,
    };
    const before = await maybeStopManagedServiceBeforeMutableUpdate({
      ...params,
      phase: "inspect",
    });
    expect(before.serviceUpdateVerdict?.kind).toBe("owned");
    const binding = {
      unit: "openclaw-gateway.service",
      managerUid: 2001,
      destination: ":1.42",
      verify: vi.fn(),
      query: vi.fn(async () => []),
      close: vi.fn(async () => {}),
    };
    mocks.admitRead.mockClear().mockResolvedValue(peer ? binding : undefined);
    mocks.command.mockClear();

    await expect(
      maybeStopManagedServiceBeforeMutableUpdate({
        ...params,
        phase: "prepare",
        expectedService: before,
      }),
    ).resolves.toMatchObject({ stopped: true, serviceUpdateVerdict: { kind: "owned" } });

    expect(mocks.admitRead).toHaveBeenCalledTimes(1);
    const admittedEnv = mocks.admitRead.mock.calls[0]?.[0];
    expect(mocks.command).toHaveBeenCalledTimes(2);
    for (const [env, options] of mocks.command.mock.calls) {
      expect(env).toEqual(admittedEnv);
      expect(options?.systemdReadBinding).toBe(peer ? binding : undefined);
    }
    expect(stop).toHaveBeenCalledTimes(1);
    expect(assertStopped).toThrow("ownership has closed");
    expect(service.start).not.toHaveBeenCalled();
    expect(service.restart).not.toHaveBeenCalled();
    expect(service.install).not.toHaveBeenCalled();
    expect(binding.close).toHaveBeenCalledTimes(peer ? 1 : 0);
  },
);
