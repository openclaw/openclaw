import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  nativeUIPhases,
  nativeUISelectors,
} from "../../scripts/lib/installed-native-ui-contract.mts";
import { runInstalledNativeUIProof } from "../../scripts/lib/installed-native-ui-driver.mts";

const mocked = vi.hoisted(() => ({
  instance: undefined as unknown,
  providerStop: vi.fn(),
  instanceCleanup: vi.fn(),
  clientClose: vi.fn(),
  proxyStart: vi.fn(),
  matrixStart: vi.fn(),
}));
vi.mock("../../extensions/qa-lab/api.js", () => ({
  startQaMockOpenAiServer: async () => ({
    baseUrl: "http://127.0.0.1:9001",
    stop: mocked.providerStop,
  }),
  buildQaGatewayConfig: () => ({ agents: { entries: { qa: {} } }, tools: {} }),
}));
vi.mock("../../src/pairing/setup-code.js", () => ({
  decodePairingSetupCode: (url: string) => ({ url, bootstrapToken: "fixture-bootstrap" }),
}));
vi.mock("../e2e/qa-lab/runtime/cloud-worker-midturn-loss-fixture.js", () => ({
  MODEL_REF: "fixture/model",
}));
vi.mock("../e2e/qa-lab/runtime/skill-library-wire-fixture.js", () => ({
  SKILL_LIBRARY_ALICE: "alice@example.invalid",
  SKILL_LIBRARY_BOB: "bob@example.invalid",
  SKILL_LIBRARY_WRITER_SCOPES: ["operator.read", "operator.write"],
  createSkillLibraryWireInstance: async () => mocked.instance,
  SkillLibraryWireClient: {
    connect: async (_instance: unknown, options?: { email?: string; scopes?: string[] }) => ({
      hello: {
        auth: {
          scopes:
            options?.scopes ??
            (options?.email ? ["operator.read", "operator.write"] : ["operator.admin"]),
        },
        server: { buildId: "fixture-build" },
      },
      client: {
        close: mocked.clientClose,
        request: async (method: string, params: Record<string, unknown>) => {
          if (method === "users.self") {
            return { profile: { id: options?.email?.startsWith("alice") ? "alice" : "bob" } };
          }
          if (method === "device.pair.setupCode") {
            return { setupCode: params.publicUrl };
          }
          throw new Error("Unexpected driver request " + method);
        },
      },
    }),
  },
}));
vi.mock("../fixtures/qa-gateway-rpc-proxy.mjs", () => ({
  startQaGatewayRpcProxy: mocked.proxyStart,
}));
vi.mock("../../scripts/lib/installed-native-ui-matrix.mts", () => ({
  createInstalledNativeUIMatrix: mocked.matrixStart,
}));

describe("installed native UI driver custody", () => {
  let directory: string;
  let stops: Array<ReturnType<typeof vi.fn>>;
  let releases: Array<ReturnType<typeof vi.fn>>;
  beforeEach(async () => {
    vi.clearAllMocks();
    mocked.proxyStart.mockReset();
    mocked.matrixStart.mockReset();
    directory = await mkdtemp(path.join(os.tmpdir(), "native-ui-driver-"));
    await mkdir(path.join(directory, "dist/control-ui"), { recursive: true });
    await writeFile(path.join(directory, "dist/control-ui/index.html"), "fixture");
    await writeFile(path.join(directory, "app"), "compiled-app-fixture");
    const configPath = path.join(directory, "config.json");
    await writeFile(configPath, JSON.stringify({ gateway: { controlUi: { allowedOrigins: [] } } }));
    mocked.instance = {
      port: 9002,
      configPath,
      env: {},
      state: { envVars: {}, workspaceDir: directory, writeConfig: vi.fn() },
      startGateway: vi.fn(),
      cleanup: mocked.instanceCleanup,
    };
    stops = [];
    releases = [];
    mocked.proxyStart.mockImplementation(async () => {
      const stop = vi.fn(async () => {});
      stops.push(stop);
      return {
        url: "wss://127.0.0.1:" + (9010 + stops.length),
        controlUrl: "https://127.0.0.1:" + (9010 + stops.length) + "/__fixture",
        stop,
      };
    });
    mocked.matrixStart.mockImplementation(async () => {
      const releaseGates = vi.fn(async () => {});
      releases.push(releaseGates);
      return {
        primary: {},
        other: {},
        dashboard: {},
        controlURL: "http://127.0.0.1:9020/control",
        verifyComplete: vi.fn(),
        receipts: () => [],
        releaseGates,
        stop: vi.fn(async () => {}),
      };
    });
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  function setup() {
    const state = {
      sourceSHA: "a".repeat(40),
      sourceTree: "b".repeat(40),
      gatewaySourceSHA: "a".repeat(40),
      appSHA256: createHash("sha256").update("compiled-app-fixture").digest("hex"),
      nativePhases: { phone: [] as string[], tablet: [] as string[] },
      unjoinedWork: false,
      nativeUI: [] as Parameters<typeof runInstalledNativeUIProof>[0]["state"]["nativeUI"],
    };
    let created = 0;
    let current: "phone" | "tablet" = "phone";
    const command = vi.fn(
      async (bin: string, args: string[], options?: { nativeUI?: "phone" | "tablet" }) => {
        if (bin === "xcrun" && args[0] === "simctl" && args[1] === "list") {
          return JSON.stringify({ devices: {} });
        }
        if (bin === "xcrun" && args[0] === "simctl" && args[1] === "create") {
          created += 1;
          return "00000000-0000-0000-0000-" + String(created).padStart(12, "0");
        }
        if (options?.nativeUI) {
          current = options.nativeUI;
          state.nativePhases[current].push(...nativeUIPhases(current));
        }
        if (bin === "xcrun" && args[0] === "xcresulttool") {
          return JSON.stringify({
            testNodes: [
              {
                nodeType: "Test Case",
                nodeIdentifier: "OpenClawUITests/" + nativeUISelectors[current],
                result: "Passed",
              },
            ],
          });
        }
        return "";
      },
    );
    const options: Parameters<typeof runInstalledNativeUIProof>[0] = {
      root: directory,
      scratch: directory,
      appExecutable: path.join(directory, "app"),
      buildArgs: ["-destination", "platform=iOS Simulator,id=original", "-configuration", "Debug"],
      runtime: {
        identifier: "iOS27",
        supportedDeviceTypes: [
          { productFamily: "iPhone", identifier: "phone-type" },
          { productFamily: "iPad", identifier: "tablet-type" },
        ],
      },
      existingSimulator: "original",
      suffix: "fixture-attempt",
      command,
      state,
      setPhase: () => {},
    };
    return { state, command, options };
  }

  it("does not allocate a fixture or simulator after the required Control UI build fails", async () => {
    const failure = new Error("Control UI build failed");
    const { state, command, options } = setup();
    command.mockRejectedValueOnce(failure);
    await expect(runInstalledNativeUIProof(options)).rejects.toBe(failure);
    expect(command).toHaveBeenCalledTimes(1);
    expect(mocked.proxyStart).not.toHaveBeenCalled();
    expect(mocked.matrixStart).not.toHaveBeenCalled();
    expect(state.nativeUI).toEqual([]);
  });

  it("retains dependencies and device when matrix construction loses a seed acknowledgement", async () => {
    const failure = new Error("seed acknowledgement lost");
    mocked.matrixStart.mockRejectedValueOnce(failure);
    const { state, command, options } = setup();
    await expect(runInstalledNativeUIProof(options)).rejects.toThrow();
    expect(mocked.matrixStart).toHaveBeenCalledTimes(1);
    expect(state.unjoinedWork).toBe(true);
    expect(state.nativeUI).toHaveLength(1);
    expect(state.nativeUI[0]).toMatchObject({
      unjoinedWork: true,
      simulatorRetained: true,
      completed: false,
    });
    expect(stops.every((stop) => stop.mock.calls.length === 0)).toBe(true);
    expect(mocked.clientClose).not.toHaveBeenCalled();
    expect(mocked.instanceCleanup).not.toHaveBeenCalled();
    expect(mocked.providerStop).not.toHaveBeenCalled();
    expect(
      command.mock.calls.some(([, args]) => args.includes("shutdown") || args.includes("delete")),
    ).toBe(false);
  });

  it("releases prepare-owned listeners before dependencies when later preparation fails", async () => {
    const failure = new Error("second TLS listener failed");
    const order: string[] = [];
    mocked.proxyStart
      .mockImplementationOnce(async () => ({
        url: "wss://127.0.0.1:9011",
        controlUrl: "https://127.0.0.1:9011/control",
        stop: async () => {
          order.push("proxy");
        },
      }))
      .mockRejectedValueOnce(failure);
    mocked.instanceCleanup.mockImplementationOnce(async () => {
      order.push("gateway");
    });
    mocked.providerStop.mockImplementationOnce(async () => {
      order.push("provider");
    });
    const { state, options } = setup();
    await expect(runInstalledNativeUIProof(options)).rejects.toBe(failure);
    expect(order).toEqual(["proxy", "gateway", "provider"]);
    expect(mocked.matrixStart).not.toHaveBeenCalled();
    expect(state.nativeUI[0]).toMatchObject({
      simulatorShutdown: true,
      simulatorDeleted: true,
      unjoinedWork: false,
      completed: false,
    });
  });

  it("uses one supplied runner for both exact selectors and closes each fixture before its device", async () => {
    const { state, command, options } = setup();
    await runInstalledNativeUIProof(options);
    expect(state.nativeUI.map((row) => row.selectedTest)).toEqual([
      nativeUISelectors.phone,
      nativeUISelectors.tablet,
    ]);
    expect(
      state.nativeUI.every((row) => row.completed && row.fixtureClosed && row.simulatorDeleted),
    ).toBe(true);
    expect(releases).toHaveLength(2);
    expect(releases.every((release) => release.mock.calls.length === 1)).toBe(true);
    expect(stops).toHaveLength(4);
    expect(stops.every((stop) => stop.mock.calls.length === 1)).toBe(true);
    const tests = command.mock.calls.filter(([, args]) => args.includes("test-without-building"));
    expect(tests).toHaveLength(2);
    expect(tests.map((call) => call[2]?.nativeUI)).toEqual(["phone", "tablet"]);
    expect(command.mock.calls).toHaveLength(16);
    expect(command.mock.calls[0]!.slice(0, 2)).toEqual(["pnpm", ["ui:build"]]);
  });
});
