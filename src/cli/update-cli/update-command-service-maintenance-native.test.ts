// Install service observations before loading the real native stop owner.
import "./update-command-service-maintenance.test-support.js";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { expect, it, vi } from "vitest";
import * as launchdExec from "../../daemon/launchd-exec.js";
import * as launchdRuntime from "../../daemon/launchd-runtime.js";
import { stopLaunchAgent } from "../../daemon/launchd-stop.js";
import { createMockGatewayService } from "../../daemon/service.test-helpers.js";
import * as ports from "../../infra/ports-inspect.js";
import * as ancestry from "../../infra/restart-stale-pids.js";
import { CONTROL_PLANE_UPDATE_SENTINEL_META_ENV } from "../../infra/update-control-plane-sentinel.js";
import { createManagedHandoffLeaseStore } from "../../infra/update-managed-service-handoff-lease.js";
import { createUpdateRun } from "../../infra/update-run-ledger.js";
import * as pidAlive from "../../shared/pid-alive.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { mockProcessPlatform } from "../../test-utils/vitest-spies.js";
import { maybeStopManagedServiceBeforeMutableUpdate } from "./update-command-service-maintenance.js";

const { mocks, withServiceHome } =
  await import("./update-command-service-maintenance.test-support.js");

it
  .runIf(process.platform === "darwin" || process.platform === "linux")
  .each([
    "direct helper",
    "activation helper",
    "ordinary nested caller",
    "unrecorded helper",
    "revoked at native stop",
    "revoked after inspection",
    "revoked after inspection with disable",
    "revoked after disable",
    "revoked before port cleanup",
  ] as const)("enforces live handoff authority in the real LaunchAgent stop: %s", (scenario) =>
  withServiceHome(async (home) => {
    const root = await fs.realpath(process.cwd());
    const runId = randomUUID();
    const label = "ai.openclaw.native-stop-test";
    const gatewayPid = 4242;
    const metaPath = path.join(home, "handoff-meta.json");
    const store = createManagedHandoffLeaseStore();
    const claim = store.acquire(root, "native-stop-handoff", { kind: "update" });
    if (claim.kind !== "acquired") {
      throw new Error("fixture could not acquire its handoff lease");
    }
    createUpdateRun({ runId, trigger: "cli" }, { env: process.env });
    await fs.writeFile(
      metaPath,
      JSON.stringify({ version: 1, meta: { root, runId, handoffId: claim.lease.owner } }),
    );
    if (scenario === "ordinary nested caller" || scenario === "unrecorded helper") {
      expect(store.release(claim.lease)).toBe(true);
    }
    mockProcessPlatform("darwin");
    vi.spyOn(ancestry, "getSelfAndAncestorPidsSync").mockReturnValue(
      new Set([process.pid, process.ppid, gatewayPid]),
    );
    // The native manager and port are the external boundaries; stopLaunchAgent stays real.
    const cleanup = vi.spyOn(ancestry, "cleanStaleGatewayProcessesSync").mockReturnValue([]);
    vi.spyOn(ports, "inspectPortUsage").mockResolvedValue({
      port: 43210,
      status: "free",
      listeners: [],
      hints: [],
    });
    vi.spyOn(launchdRuntime, "resolveLaunchAgentGatewayContext").mockImplementation(async () => {
      if (scenario === "revoked before port cleanup") {
        expect(store.release(claim.lease)).toBe(true);
      }
      return {
        env: {},
        port: scenario === "revoked before port cleanup" ? 43210 : null,
        probeHosts: [],
      };
    });
    let loaded = true;
    vi.spyOn(pidAlive, "isPidDefinitelyDead").mockImplementation(
      (pid) => pid === gatewayPid && !loaded,
    );
    const nativeCalls: string[][] = [];
    let inspections = 0;
    vi.spyOn(launchdExec, "execLaunchctl").mockImplementation(async (args) => {
      nativeCalls.push(args);
      if (args[0] === "print") {
        inspections += 1;
        if (
          scenario === "revoked at native stop" ||
          (inspections === 2 &&
            (scenario === "revoked after inspection" ||
              scenario === "revoked after inspection with disable"))
        ) {
          expect(store.release(claim.lease)).toBe(true);
        }
        return loaded
          ? {
              code: 0,
              termination: "exit",
              stdout: `state = running\npid = ${gatewayPid}`,
              stderr: "",
            }
          : { code: 113, termination: "exit", stdout: "", stderr: "Could not find service" };
      }
      if (args[0] === "disable") {
        if (scenario === "revoked after disable") {
          expect(store.release(claim.lease)).toBe(true);
        }
        return { code: 0, termination: "exit", stdout: "", stderr: "" };
      }
      expect(args[0]).toBe("bootout");
      loaded = false;
      return { code: 0, termination: "exit", stdout: "", stderr: "" };
    });
    await withEnvAsync(
      {
        OPENCLAW_UPDATE_RUN_HANDOFF: scenario === "ordinary nested caller" ? undefined : "1",
        [CONTROL_PLANE_UPDATE_SENTINEL_META_ENV]: metaPath,
        OPENCLAW_LAUNCHD_LABEL: label,
        OPENCLAW_SERVICE_MARKER: undefined,
        OPENCLAW_SERVICE_KIND: undefined,
        LAUNCH_JOB_LABEL: undefined,
        LAUNCH_JOB_NAME: undefined,
        XPC_SERVICE_NAME: undefined,
      },
      async () => {
        const output = new PassThrough();
        const service = createMockGatewayService({
          readCommand: async () => ({
            programArguments: [process.execPath, path.join(root, "openclaw.mjs"), "gateway"],
            environment: { HOME: home, OPENCLAW_LAUNCHD_LABEL: label },
          }),
          readRuntime: async () =>
            loaded ? { status: "running", pid: gatewayPid } : { status: "stopped" },
          isLoaded: async () => loaded,
          stop: stopLaunchAgent,
        });
        mocks.service.mockReturnValue(service);
        const nativeArgs = {
          env: process.env,
          stdout: output,
          disable:
            scenario === "revoked after inspection with disable" ||
            scenario === "revoked after disable",
          ...(scenario === "ordinary nested caller" ? {} : { updateHandoff: { root, runId } }),
        };
        const stop = () =>
          scenario === "activation helper" || scenario === "revoked at native stop"
            ? maybeStopManagedServiceBeforeMutableUpdate({
                root,
                updateInstallKind: "package",
                shouldRestart: true,
                jsonMode: true,
                phase: "prepare",
                updateRun: { runId, env: process.env },
              }).then((result) => expect(result.stopped).toBe(true))
            : stopLaunchAgent(nativeArgs);
        const authorized = scenario === "direct helper" || scenario === "activation helper";
        if (authorized) {
          await stop();
        } else {
          await expect(stop()).rejects.toThrow(
            `Refusing to stop LaunchAgent ${label} from inside the same launchd service`,
          );
        }
        const target = `${launchdRuntime.resolveLaunchAgentGuiDomain()}/${label}`;
        const bootedOut = authorized || scenario === "revoked before port cleanup";
        expect(nativeCalls.filter(([command]) => command !== "print")).toEqual(
          bootedOut
            ? [["bootout", target]]
            : scenario === "revoked after disable"
              ? [["disable", target]]
              : [],
        );
        expect(loaded).toBe(!bootedOut);
        expect(cleanup).not.toHaveBeenCalled();
      },
    );
  }),
);
