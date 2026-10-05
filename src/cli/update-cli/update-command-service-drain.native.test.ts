import fs from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HelloOk } from "../../../packages/gateway-protocol/src/schema/frames.js";
import { installPrivateUpdateHandoffStore } from "../../../test/helpers/private-update-handoff-store.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { GatewayServiceCommandConfig } from "../../daemon/service-types.js";
import type { openSystemdBroker } from "../../daemon/systemd-peer-native.js";
import type { CallGatewayCliOptions } from "../../gateway/call.js";
import {
  armGatewaySuspendHandoff,
  consumeGatewaySuspendHandoff,
  getGatewaySuspendStatus,
  prepareGatewaySuspend,
  resetGatewaySuspendCoordinatorForLifecycleRestart,
  resumeGatewaySuspend,
} from "../../infra/gateway-suspend-coordinator.js";
import { inspectors } from "../../infra/gateway-suspend-coordinator.test-support.js";
import type { ImmutableInstallDescriptor } from "../../infra/update-immutable-install-schema.js";
import {
  controlImmutableService,
  inspectImmutableActivationService,
} from "../../infra/update-immutable-service.js";
import {
  isGatewayWorkAdmissionClosed,
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
} from "../../process/gateway-work-admission.js";
import { createGatewayHostLifecycle } from "../gateway-cli/host-lifecycle.js";
import { withGatewayMaintenanceDrain } from "./update-command-service-drain.js";

const mocks = vi.hoisted(() => ({
  call: vi.fn(),
  openBroker: vi.fn(),
  command: vi.fn(),
  location: vi.fn(),
  systemctl: vi.fn(),
}));
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return {
    ...actual,
    readFileSync: (...args: Parameters<typeof actual.readFileSync>) => fs.readFileSync(...args),
  };
});
vi.mock("../../gateway/call.js", () => ({ callGatewayCli: mocks.call }));
vi.mock("../../daemon/systemd-peer-native.js", () => ({
  openSystemdBroker: mocks.openBroker,
  openSystemdMachineBroker: mocks.openBroker,
}));
vi.mock("../../daemon/systemd-service-files.js", async (original) => ({
  ...(await original<typeof import("../../daemon/systemd-service-files.js")>()),
  readSystemdServiceCommandLocation: mocks.location,
  readSystemdServiceExecStartAsRoot: mocks.command,
}));
vi.mock("../../daemon/systemd-exec.js", async (original) => ({
  ...(await original<typeof import("../../daemon/systemd-exec.js")>()),
  execSystemctl: mocks.systemctl,
  execSystemctlUser: mocks.systemctl,
}));
vi.mock("../daemon-cli/restart-health-probe.js", () => ({
  resolveGatewayRestartProbeContext: async () => ({
    config: { gateway: { auth: { mode: "none" } } },
    auth: {},
  }),
}));
vi.mock("./update-command-service-plan.js", () => ({
  resolveUpdatedGatewayRestartPort: async () => 18789,
}));
vi.mock("../../gateway/local-http-probe.js", () => ({
  createConfiguredGatewayLocalProbe: () => ({
    resolveWebSocketTarget: async () => ({ url: "ws://127.0.0.1:18789" }),
  }),
}));

const dirs = useAutoCleanupTempDirTracker(afterEach);
const pid = 43210;
const controlGroup = "/system.slice/immutable-native-fixture.service";
let root: string;
let descriptor: ImmutableInstallDescriptor;
let command: GatewayServiceCommandConfig;
let alive: boolean;
let processTicks: number;
let shutdownCommitted: boolean;
let host: ReturnType<typeof createGatewayHostLifecycle>;
let loseCommittedReply: boolean;
let epoch: number;
let monotonic: number;
let ordinaryWork: number;
let persistence: number;
let bootId: string;
let suspensionId: string;
let events: string[];
let atNativeInspection: (() => void) | undefined;
let beforeDispatch: (() => void) | undefined;
let beforeHandoffDispatch: (() => void) | undefined;
let assertProtection: () => void;
const assertCurrent = () => {};

function hello(): HelloOk {
  return {
    type: "hello-ok",
    protocol: 3,
    server: { version: "fixture", connId: "fixture", bootId },
    features: { methods: [], events: [] },
    snapshot: { presence: [], health: {}, stateVersion: { presence: 0, health: 0 }, uptimeMs: 0 },
    auth: { role: "operator", scopes: ["operator.admin"] },
    policy: { maxPayload: 1_000_000, maxBufferedBytes: 1_000_000, tickIntervalMs: 60_000 },
  };
}

function params(request: CallGatewayCliOptions): Record<string, unknown> {
  if (!isRecord(request.params)) {
    throw new Error(`Missing fixture RPC params for ${request.method}`);
  }
  return request.params;
}

beforeEach(() => {
  vi.resetAllMocks();
  resetGatewaySuspendCoordinatorForLifecycleRestart();
  resetGatewayWorkAdmission();
  root = fs.realpathSync(dirs.make("immutable-native-drain-"));
  installPrivateUpdateHandoffStore(root);
  vi.spyOn(process, "geteuid").mockReturnValue(0);
  alive = true;
  processTicks = 101;
  shutdownCommitted = false;
  loseCommittedReply = false;
  epoch = 1_800_000_000_000;
  monotonic = 1_000;
  ordinaryWork = 0;
  persistence = 0;
  bootId = "original-boot";
  suspensionId = "";
  events = [];
  atNativeInspection = undefined;
  beforeDispatch = undefined;
  beforeHandoffDispatch = undefined;
  assertProtection = () => {};
  host = createGatewayHostLifecycle({
    isCurrent: () => true,
    isServing: () => alive && !shutdownCommitted,
    acceptStop: () => {
      throw new Error("Immutable handoff must not use privileged hosted stop");
    },
    commitExternalStop: () => {
      const consumed = consumeGatewaySuspendHandoff(host.capability.externalRestart);
      if (!consumed.ok || !consumed.value) {
        throw new Error("Host did not consume its exact suspension");
      }
      markGatewayRestartDraining("stop (SIGTERM)");
      shutdownCommitted = true;
      events.push("host:committed");
    },
    processOwner: { ownsProcessLifecycle: true, supervisor: "systemd" },
  });
  vi.spyOn(Date, "now").mockImplementation(() => epoch);
  vi.spyOn(performance, "now").mockImplementation(() => monotonic);
  const sha = "a".repeat(40);
  const generation = path.join(root, "releases", sha);
  fs.mkdirSync(path.join(generation, "dist"), { recursive: true });
  fs.mkdirSync(path.join(root, "bin"));
  fs.writeFileSync(path.join(generation, "dist", "index.js"), "// fixture runtime\n");
  const runtime = path.join(root, "node");
  fs.writeFileSync(runtime, "fixture external runtime");
  const launcher = path.join(root, "bin", "openclaw-gateway");
  fs.writeFileSync(launcher, `#!${runtime}\n// fixture launcher\n`);
  fs.symlinkSync(`releases/${sha}`, path.join(root, "current"));
  const sourcePath = path.join(root, "immutable-native-fixture.service");
  fs.writeFileSync(sourcePath, "[Service]\nUser=synthetic-gateway\nKillMode=control-group\n");
  descriptor = {
    version: 2,
    activationEnabled: true,
    kind: "immutable",
    root,
    rootIdentity: "1:1",
    releasesIdentity: "1:2",
    current: {
      sha,
      path: generation,
      identity: "1:3",
      pointerIdentity: "1:4",
      buildDigest: "a".repeat(64),
    },
    service: {
      unit: "immutable-native-fixture.service",
      scope: "system",
      account: "synthetic-gateway",
      stateDir: path.join(root, "state"),
      configPath: path.join(root, "openclaw.json"),
      profile: null,
    },
    runtime: { path: runtime, identity: "1:5" },
    source: "https://github.com/openclaw/openclaw.git",
  };
  command = {
    programArguments: [launcher],
    sourcePath,
    environment: {
      OPENCLAW_STATE_DIR: descriptor.service.stateDir,
      OPENCLAW_CONFIG_PATH: descriptor.service.configPath,
    },
  };
  mocks.location.mockImplementation(async () => ({ kind: "command", command }));
  mocks.command.mockImplementation(async () => command);
  mocks.systemctl.mockImplementation(async () => ({
    code: 0,
    termination: "exit",
    stderr: "",
    stdout: `Id=${descriptor.service.unit}\nLoadState=loaded\nActiveState=${alive ? "active" : "inactive"}\nSubState=${alive ? "running" : "dead"}\nMainPID=${alive ? pid : 0}\nControlGroup=${controlGroup}\nTasksCurrent=${alive ? 1 : 0}\nJob=0\nKillMode=control-group\nTimeoutStopUSec=330s\nDynamicUser=no\nRootDirectory=\nRootImage=\n`,
  }));
  const readFile = fs.readFileSync;
  vi.spyOn(fs, "readFileSync").mockImplementation((file, ...args) => {
    if (String(file) === `/proc/${pid}/stat`) {
      if (!alive) {
        throw Object.assign(new Error("fixture process exited"), { code: "ENOENT" });
      }
      return `${pid} (openclaw-gateway) S ${"0 ".repeat(18)}${processTicks}`;
    }
    if (String(file) === `/proc/${pid}/cgroup`) {
      return `0::${controlGroup}\n`;
    }
    if (String(file) === `/proc/${process.pid}/cgroup`) {
      return "0::/user.slice/immutable-updater.scope\n";
    }
    if (String(file) === `/sys/fs/cgroup${controlGroup}/cgroup.events`) {
      events.push(alive ? "cgroup:populated" : "cgroup:empty");
      return `populated ${alive ? 1 : 0}\nfrozen 0\n`;
    }
    return readFile(file, ...args);
  });
  const readlink = fs.readlinkSync;
  vi.spyOn(fs, "readlinkSync").mockImplementation((file, ...args) => {
    if (String(file) === `/proc/${pid}/exe`) {
      return runtime;
    }
    if (String(file) === `/proc/${pid}/cwd`) {
      return generation;
    }
    return readlink(file, ...args);
  });
  mocks.call.mockImplementation(async (request: CallGatewayCliOptions) => {
    request.onHelloOk?.(hello());
    if (request.method === "gateway.suspend.handoff") {
      await Promise.resolve();
      beforeHandoffDispatch?.();
    }
    request.assertDispatchCurrent?.();
    events.push(`rpc:${request.method}`);
    if (request.method === "status") {
      return { pid, shutdownBudget: { timeoutMs: 325_000 } };
    }
    if (request.method === "system.info") {
      return { pid, processInstanceId: "original-process-instance" };
    }
    if (request.method === "gateway.suspend.prepare") {
      const input = params(request);
      if (typeof input.requestId !== "string") {
        throw new Error("Missing fixture request ID");
      }
      const result = await prepareGatewaySuspend({
        requestId: input.requestId,
        drain: true,
        terminalPolicy: "terminate",
        pauseScheduling: () => events.push("scheduler:paused"),
        resumeScheduling: () => events.push("scheduler:resumed"),
        inspect: inspectors({
          getRootRequests: () => ordinaryWork,
          getTerminalPersistence: () => persistence,
        }),
        nowMs: () => epoch,
      });
      if (result.status === "ready" || result.status === "draining") {
        suspensionId = result.suspensionId;
      }
      events.push(`prepared:${result.status}`);
      return result;
    }
    if (request.method === "gateway.suspend.status") {
      const input = params(request);
      if (typeof input.suspensionId !== "string") {
        throw new Error("Missing fixture suspension ID");
      }
      return getGatewaySuspendStatus(input.suspensionId, input.includeLifecycle === true);
    }
    if (request.method === "gateway.suspend.handoff") {
      const input = params(request);
      if (typeof input.suspensionId !== "string") {
        throw new Error("Missing fixture suspension ID");
      }
      expect(input.target).toEqual({ pid, processInstanceId: "original-process-instance" });
      const owner = host.capability.externalRestart;
      if (!owner) {
        throw new Error("Fixture host has no process-exit owner");
      }
      const result = armGatewaySuspendHandoff({
        suspensionId: input.suspensionId,
        owner,
        ...(input.commit === true ? { commit: true } : {}),
      });
      if (!result.ok) {
        throw new Error(result.error);
      }
      if (result.value.status === "committed" && loseCommittedReply) {
        throw new Error("Synthetic transport lost the committed reply");
      }
      return result.value;
    }
    if (request.method === "gateway.suspend.resume") {
      const input = params(request);
      if (typeof input.suspensionId !== "string") {
        throw new Error("Missing fixture suspension ID");
      }
      return resumeGatewaySuspend(input.suspensionId);
    }
    throw new Error(`Unsupported fixture Gateway method: ${request.method}`);
  });
  mocks.openBroker.mockImplementation(async () => {
    let mutationInspection = false;
    const query: Awaited<ReturnType<typeof openSystemdBroker>>["query"] = async (
      args,
      _signatures,
      _deadline,
      current,
      dispatch,
    ) => {
      current?.();
      const method = args[4];
      if (method === "GetId") {
        return [["a".repeat(32)]];
      }
      if (method === "GetNameOwner") {
        if (mutationInspection) {
          await Promise.resolve();
          events.push("native:inspected");
          atNativeInspection?.();
          mutationInspection = false;
        }
        return [[":1.42"]];
      }
      if (method === "GetConnectionUnixUser") {
        return [[0]];
      }
      if (method === "GetUnit" || method === "LoadUnit") {
        mutationInspection = method === "LoadUnit";
        return [["/org/freedesktop/systemd1/unit/immutable_2dnative_2dfixture_2eservice"]];
      }
      if (args[0] === "get-property") {
        return method === "Id"
          ? [descriptor.service.unit, sourcePath]
          : [descriptor.service.account];
      }
      if (method === "StopUnit") {
        await Promise.resolve();
        beforeDispatch?.();
        current?.();
        dispatch?.();
        events.push(
          isGatewayWorkAdmissionClosed() ? "effect:admission-closed" : "effect:admission-open",
        );
        events.push("effect:StopUnit");
        alive = false;
        current?.();
        return [["/org/freedesktop/systemd1/job/7"]];
      }
      throw new Error(`Unsupported fixture native method: ${method}`);
    };
    return { query, close: async () => {}, verify: () => {} };
  });
});
afterEach(async () => {
  await host?.retire();
  resetGatewaySuspendCoordinatorForLifecycleRestart();
  resetGatewayWorkAdmission();
  vi.restoreAllMocks();
});

async function stopWithLiveDrain() {
  const observed = await inspectImmutableActivationService({
    descriptor,
    generationPath: descriptor.current.path,
    assertCurrent,
  });
  return withGatewayMaintenanceDrain(
    {
      state: observed.state,
      timeoutMs: 0,
      drainPolicy: "interrupt-after-drain",
      assertCurrent,
      warn: () => {},
    },
    async (guard) => {
      events.push("stop:entered");
      await controlImmutableService("stop", {
        descriptor,
        expected: observed,
        assertCurrent,
        stdout: new PassThrough(),
        prepareEffect: guard ? () => guard.prepareEffect(assertProtection) : undefined,
        beforeEffect: assertProtection,
      });
      events.push("stop:settled");
    },
  );
}

describe.skipIf(process.platform !== "linux")(
  "immutable drain through the native service owner",
  () => {
    it.each(["ready", "draining"] as const)(
      "stops only behind the live %s lease and observes complete process settlement",
      async (phase) => {
        ordinaryWork = Number(phase === "draining");
        await stopWithLiveDrain();
        expect(events).toContain(`prepared:${phase}`);
        expect(events.filter((event) => event === "effect:StopUnit")).toHaveLength(1);
        expect(events).toContain("effect:admission-closed");
        expect(events.indexOf("cgroup:empty")).toBeGreaterThan(events.indexOf("effect:StopUnit"));
        expect(events.at(-1)).toBe("stop:settled");
        expect(alive).toBe(false);
      },
    );

    it.each(["native inspection", "handoff dispatch"] as const)(
      "refuses changed protected config at %s before host commitment",
      async (window) => {
        const file = path.join(root, "protected-config.json");
        fs.writeFileSync(file, "original bytes");
        assertProtection = () => {
          if (fs.readFileSync(file, "utf8") !== "original bytes") {
            throw new Error("protected config changed");
          }
        };
        const replace = () => fs.writeFileSync(file, "foreign bytes");
        if (window === "native inspection") {
          atNativeInspection = replace;
        } else {
          beforeHandoffDispatch = replace;
        }
        await expect(stopWithLiveDrain()).rejects.toThrow("protected config changed");
        expect(events).toContain("native:inspected");
        expect(events).not.toContain("host:committed");
        expect(events).not.toContain("effect:StopUnit");
        expect(shutdownCommitted).toBe(false);
        expect(alive).toBe(true);
      },
    );

    it.each(["expiry", "resume", "write custody", "boot replacement"] as const)(
      "preserves the serving process when %s changes during native identity inspection",
      async (change) => {
        atNativeInspection = () => {
          if (change === "expiry") {
            epoch += 120_000;
            monotonic += 120_000;
            expect(getGatewaySuspendStatus(suspensionId, true)).toMatchObject({
              status: "running",
            });
          } else if (change === "resume") {
            expect(resumeGatewaySuspend(suspensionId)).toMatchObject({ ok: true, resumed: true });
          } else if (change === "write custody") {
            persistence = 1;
          } else {
            bootId = "replacement-boot";
          }
        };
        const outcome = await stopWithLiveDrain().then(
          () => null,
          (error: unknown) => error,
        );
        expect(events).toContain("native:inspected");
        expect(events.filter((event) => event === "effect:StopUnit")).toEqual([]);
        expect(outcome).toBeInstanceOf(Error);
        expect(alive).toBe(true);
      },
    );

    it.each(["forward", "backward"] as const)(
      "preserves committed shutdown across queued lease expiry when the wall clock moves %s",
      async (clock) => {
        beforeDispatch = () => {
          epoch += clock === "forward" ? 120_000 : -120_000;
          monotonic += 120_000;
        };
        await stopWithLiveDrain();
        expect(events).toContain("native:inspected");
        expect(events.filter((event) => event === "host:committed")).toHaveLength(1);
        expect(events.filter((event) => event === "effect:StopUnit")).toHaveLength(1);
        expect(events).not.toContain("effect:admission-open");
        expect(isGatewayWorkAdmissionClosed()).toBe(true);
        expect(getGatewaySuspendStatus(suspensionId, true)).toMatchObject({
          status: "draining",
          phase: "interrupting",
        });
        expect(alive).toBe(false);
      },
    );

    it("refuses resume after host commitment while native stop is queued", async () => {
      let resumed: ReturnType<typeof resumeGatewaySuspend> | undefined;
      beforeDispatch = () => {
        resumed = resumeGatewaySuspend(suspensionId);
      };
      await stopWithLiveDrain();
      expect(events).not.toContain("effect:admission-open");
      expect(events.filter((event) => event === "host:committed")).toHaveLength(1);
      expect(events.filter((event) => event === "effect:StopUnit")).toHaveLength(1);
      expect(resumed).toEqual({ ok: false, reason: "gateway-restarting" });
      expect(isGatewayWorkAdmissionClosed()).toBe(true);
    });

    it("settles the original process that exits after commitment before native dispatch", async () => {
      beforeDispatch = () => {
        alive = false;
      };
      await stopWithLiveDrain();
      expect(events.filter((event) => event === "host:committed")).toHaveLength(1);
      expect(events.filter((event) => event === "effect:StopUnit")).toEqual([]);
      expect(events.at(-1)).toBe("stop:settled");
    });

    it("preserves a replacement process after the original host committed shutdown", async () => {
      beforeDispatch = () => {
        processTicks++;
      };
      const outcome = await stopWithLiveDrain().then(
        () => null,
        (error: unknown) => error,
      );
      expect(events).toContain("host:committed");
      expect(events.filter((event) => event === "effect:StopUnit")).toEqual([]);
      expect(outcome).toBeInstanceOf(Error);
      expect(alive).toBe(true);
    });

    it("keeps committed shutdown observable after a lost reply without sending an unverified native stop", async () => {
      loseCommittedReply = true;
      await expect(stopWithLiveDrain()).rejects.toThrow("lost the committed reply");
      expect(events.filter((event) => event === "host:committed")).toHaveLength(1);
      expect(events.filter((event) => event === "effect:StopUnit")).toEqual([]);
      expect(resumeGatewaySuspend(suspensionId)).toEqual({
        ok: false,
        reason: "gateway-restarting",
      });
      expect(getGatewaySuspendStatus(suspensionId, true)).toMatchObject({
        status: "draining",
        phase: "interrupting",
      });
      expect(isGatewayWorkAdmissionClosed()).toBe(true);
    });
  },
);
