import { once } from "node:events";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { expect, vi, type Mock } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import * as serviceOwner from "../../daemon/service.js";
import {
  createMockGatewayService,
  mockSystemAccountHome,
} from "../../daemon/service.test-helpers.js";
import * as gatewayCall from "../../gateway/call.js";
import { gatewayHealthResponse } from "../../gateway/health-response.test-support.js";
import { readPackageVersion } from "../../infra/package-json.js";
import * as ports from "../../infra/ports-inspect.js";
import { getUpdateRun } from "../../infra/update-run-ledger.js";
import type { UpdateRunResult } from "../../infra/update-runner-types.js";
import * as utils from "../../utils.js";
import * as restartProbe from "../daemon-cli/restart-health-probe.js";
import type { UpdateCommandOptions } from "./shared.js";
import * as serviceExports from "./update-command-service.js";

export async function createReadinessRollbackFixture(params: {
  packageRoot: string;
  launcher: string;
  env: NodeJS.ProcessEnv & {
    HOME: string;
    USERPROFILE: string;
    OPENCLAW_STATE_DIR: string;
    OPENCLAW_CONFIG_PATH: string;
  };
  harness: {
    gatewayCommand: Mock<
      typeof import("./update-command-service-command.js").runUpdatedInstallGatewayCommand
    >;
    restartCandidate: {
      mockImplementationOnce: (
        implementation: typeof serviceExports.maybeRestartService,
      ) => unknown;
    };
    verifyGateway: {
      mockImplementation: (
        implementation: typeof import("./update-command-verification.js").verifyUpdatedGateway,
      ) => unknown;
    };
  };
}) {
  const entered = createDeferred();
  const released = createDeferred();
  let nowMs = 0;
  let candidateSettled = false;
  let stalled = false;
  let servingVersion: string | undefined;
  const activations: string[] = [];
  for (const key of [
    "HOME",
    "USERPROFILE",
    "OPENCLAW_HOME",
    "OPENCLAW_PROFILE",
    "OPENCLAW_SUPERVISOR_MODE",
    "OPENCLAW_STATE_DIR",
    "OPENCLAW_CONFIG_PATH",
  ]) {
    vi.stubEnv(key, params.env[key]);
  }
  mockSystemAccountHome();
  vi.spyOn(performance, "now").mockImplementation(() => nowMs);
  vi.spyOn(utils, "sleep").mockImplementation(async (ms, signal) => {
    signal?.throwIfAborted();
    nowMs += ms;
  });
  const server = createServer((_req, res) => {
    res.writeHead(servingVersion === "1.0.0" ? 200 : 503).end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Missing recovery HTTP listener");
  }
  const command = {
    programArguments: [
      process.execPath,
      path.join(params.packageRoot, "dist", "index.js"),
      "gateway",
      "--port",
      String(address.port),
    ],
    environment: {
      HOME: params.env.HOME,
      USERPROFILE: params.env.USERPROFILE,
      OPENCLAW_STATE_DIR: params.env.OPENCLAW_STATE_DIR,
      OPENCLAW_CONFIG_PATH: params.env.OPENCLAW_CONFIG_PATH,
    },
  };
  const service = createMockGatewayService({
    isLoaded: async () => true,
    readCommand: async () => command,
    readRuntime: vi.fn(async () => {
      if (activations.length === 1 && !stalled) {
        stalled = true;
        entered.resolve();
        await released.promise;
        return { status: "running", pid: 8000 };
      }
      return servingVersion ? { status: "running", pid: 4242 } : { status: "stopped" };
    }),
  });
  vi.spyOn(serviceOwner, "resolveGatewayService").mockReturnValue(service);
  vi.spyOn(serviceOwner, "readGatewayServiceState").mockImplementation(async () => ({
    installed: true,
    running: servingVersion !== undefined,
    loadState: { status: "loaded" },
    env: params.env,
    command,
  }));
  vi.spyOn(restartProbe, "resolveGatewayRestartProbeContext").mockResolvedValue({
    config: { gateway: { auth: { mode: "none" } } },
    auth: undefined,
  });
  const portProbe = vi.spyOn(ports, "inspectPortUsage").mockImplementation(async (port) => ({
    port,
    status: servingVersion ? "busy" : "free",
    listeners: servingVersion ? [{ pid: 4242, command: "openclaw-gateway" }] : [],
    hints: [],
  }));
  const rpc = vi.spyOn(gatewayCall, "callGateway").mockImplementation(async (options) => {
    if (!servingVersion) {
      throw new Error("Candidate Gateway is not listening");
    }
    return gatewayHealthResponse({
      server: { version: servingVersion, bootId: "restored-gateway" },
    })(options);
  });
  params.harness.gatewayCommand.mockImplementation(async (_activation, action) => {
    expect(action).toBe("restart");
    const installed = await readPackageVersion(params.packageRoot);
    if (!installed) {
      throw new Error("Gateway activation requires an installed package");
    }
    activations.push(installed);
    if (activations.length === 1) {
      expect(installed).toBe("9999.1.1");
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    } else {
      expect(installed).toBe("1.0.0");
      expect(await fs.readFile(params.launcher, "utf8")).toBe("old launcher\n");
      servingVersion = installed;
    }
    return "accepted";
  });
  const actualService = await vi.importActual<typeof serviceExports>("./update-command-service.js");
  vi.spyOn(serviceExports, "resolveUpdatedGatewayRestartPort").mockImplementation(
    actualService.resolveUpdatedGatewayRestartPort,
  );
  params.harness.restartCandidate.mockImplementationOnce(actualService.maybeRestartService);
  params.harness.restartCandidate.mockImplementationOnce(actualService.maybeRestartService);
  const verification = await vi.importActual<typeof import("./update-command-verification.js")>(
    "./update-command-verification.js",
  );
  params.harness.verifyGateway.mockImplementation(async (options) => {
    const candidate = activations.length === 1;
    try {
      return await verification.verifyUpdatedGateway(options);
    } finally {
      if (candidate) {
        candidateSettled = true;
      }
    }
  });
  return {
    port: address.port,
    finish: async (
      finishing: Promise<UpdateRunResult>,
      run: NonNullable<UpdateCommandOptions["run"]>,
    ) => {
      const settled = finishing.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      try {
        await Promise.race([
          entered.promise,
          settled.then((outcome) => {
            throw new Error("Finalization settled before the candidate readiness read", {
              cause: "error" in outcome ? outcome.error : outcome.value,
            });
          }),
        ]);
        nowMs = 6_500;
        await vi.advanceTimersByTimeAsync(6_500);
        expect(candidateSettled).toBe(true);
        vi.useRealTimers();
        const outcome = await settled;
        expect(activations).toEqual(["9999.1.1", "1.0.0"]);
        const recorded = getUpdateRun(run.runId, { env: run.env });
        expect(recorded?.status).toBe("rolled-back");
        const calls = [rpc.mock.calls.length, portProbe.mock.calls.length];
        released.resolve();
        await setImmediate();
        expect([rpc.mock.calls.length, portProbe.mock.calls.length]).toEqual(calls);
        expect(getUpdateRun(run.runId, { env: run.env })).toEqual(recorded);
        expect(await readPackageVersion(params.packageRoot)).toBe("1.0.0");
        if ("error" in outcome) {
          throw outcome.error;
        }
        return outcome.value;
      } finally {
        vi.useRealTimers();
        released.resolve();
        await settled;
        server.closeAllConnections();
        const closed = once(server, "close");
        server.close();
        await closed;
      }
    },
  };
}
