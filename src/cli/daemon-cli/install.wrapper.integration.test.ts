import fs from "node:fs/promises";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../../config/config.js";
import * as runtimePaths from "../../daemon/runtime-paths.js";
import { withDaemonRuntimePinStore } from "../../daemon/runtime-pin-store.js";
import { ServiceStartRefusalError } from "../../daemon/service-inspection-error.js";
import type {
  GatewayServiceCommandConfig,
  GatewayServiceInstallArgs,
} from "../../daemon/service-types.js";
import {
  GatewayServiceAuthorityError,
  withGatewayServiceUpdateAuthority,
} from "../../daemon/service-update-authority.js";
import { mockSystemAccountHome } from "../../daemon/service.test-helpers.js";
import { ExitError } from "../../runtime.js";
import { addGatewayServiceCommands } from "./register-service-commands.js";
import { createDaemonActionContext } from "./response.js";
import { runGatewayServiceUpdateCommand } from "./update-executor.js";

const { defaultRuntime, runtimeLogs, runtimeErrors, resetRuntimeCapture } = await vi.hoisted(
  async () => {
    const { createCliRuntimeCapture } = await import("../test-runtime-capture.js");
    return createCliRuntimeCapture();
  },
);
const service = vi.hoisted(() => ({
  label: "LaunchAgent",
  loadedText: "loaded",
  notLoadedText: "not loaded",
  install: vi.fn<(args: GatewayServiceInstallArgs) => Promise<void>>(),
  isLoaded: vi.fn(async () => true),
  readCommand: vi.fn<() => Promise<GatewayServiceCommandConfig | null>>(),
  readDefinitionMutationCapability: vi.fn(async () => ({ kind: "writable" as const })),
}));
const executor = vi.hoisted(() => ({ current: true }));

vi.mock("../../infra/openclaw-root.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/openclaw-root.js")>()),
  resolveOpenClawPackageRoot: async () => path.dirname(path.dirname(process.argv[1]!)),
}));
vi.mock("../update-cli/update-command-executor.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../update-cli/update-command-executor.js")>()),
  withDelegatedUpdateCommandExecutor: async (
    _grant: unknown,
    _runId: string,
    _root: string,
    operation: (fence: { assertCurrent: () => void }) => Promise<unknown>,
  ) =>
    operation({
      assertCurrent: () => {
        if (!executor.current) {
          throw new Error("executor fence lost");
        }
      },
    }),
}));

vi.mock("../../daemon/service.js", () => ({ resolveGatewayService: () => service }));
vi.mock("../../runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime.js")>()),
  defaultRuntime,
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let originalArgv: string[];
let entrypoint: string;
let exit: ExitError;
const originalExit = defaultRuntime.exit.getMockImplementation()!;
const sqliteCapabilities = {
  sqliteVersion: "3.53.4",
  nodeSharedSqlite: false,
  sqliteProbe: { available: true, version: "3.53.4", text: true, blob: true, json: true },
};

function parseInstall(args: string[]) {
  const program = new Command().name("openclaw");
  addGatewayServiceCommands(program.command("gateway"));
  return program.parseAsync(["gateway", "install", ...args], { from: "user" });
}

function expectExit(operation: () => Promise<unknown>) {
  return expect(operation()).rejects.toBe(exit);
}

it("uses the running Bun on first install when Node is unavailable", async () => {
  const execPath = Object.getOwnPropertyDescriptor(process, "execPath")!;
  const bunVersion = Object.getOwnPropertyDescriptor(process.versions, "bun");
  const bunPath = "/opt/app/runtime/bun";
  Object.defineProperty(process, "execPath", { configurable: true, value: bunPath });
  Object.defineProperty(process.versions, "bun", { configurable: true, value: "1.4.3" });
  vi.spyOn(runtimePaths, "resolvePreferredNodePath").mockResolvedValue(undefined);
  vi.spyOn(runtimePaths, "resolveSystemNodeInfo").mockResolvedValue(null);
  const probe = vi.spyOn(runtimePaths, "resolveBunRuntimeInfo").mockResolvedValue({
    status: "supported" as const,
    version: "1.4.3",
    ...sqliteCapabilities,
  });
  try {
    await parseInstall(["--force", "--port", "29453", "--json"]);
    expect(runtimeErrors).toEqual([]);
    expect(service.install).toHaveBeenCalledOnce();
    const [installed] = service.install.mock.calls[0]!;
    expect(installed.runtimePinUpdate?.pin).toBeUndefined();
    expect(installed.programArguments).toEqual([
      bunPath,
      "--no-install",
      entrypoint,
      "gateway",
      "--port",
      "29453",
    ]);
    expect(probe).toHaveBeenCalledWith(bunPath, expect.any(Object));
    expect(JSON.parse(runtimeLogs.at(-1)!).warnings).toEqual([
      "No supported Node runtime was found; using the running Bun for the service.",
    ]);
  } finally {
    Object.defineProperty(process, "execPath", execPath);
    if (bunVersion) {
      Object.defineProperty(process.versions, "bun", bunVersion);
    } else {
      delete process.versions.bun;
    }
  }
});

beforeEach(async () => {
  originalArgv = process.argv;
  exit = new ExitError(1);
  defaultRuntime.exit.mockImplementation(() => {
    throw exit;
  });
  const home = tempDirs.make("openclaw-install-wrapper-");
  const state = path.join(home, ".openclaw-wrapper-test");
  for (const [key, value] of Object.entries({
    HOME: home,
    OPENCLAW_HOME: "",
    OPENCLAW_PROFILE: "wrapper-test",
    OPENCLAW_STATE_DIR: state,
    OPENCLAW_CONFIG_PATH: path.join(state, "openclaw.json"),
    OPENCLAW_WRAPPER: "",
    OPENCLAW_LAUNCHD_LABEL: "",
    OPENCLAW_GATEWAY_TOKEN: "",
    OPENCLAW_GATEWAY_PASSWORD: "",
  })) {
    vi.stubEnv(key, value);
  }
  await fs.mkdir(state);
  // Keep migration pending, but create private files before emulating another platform.
  withDaemonRuntimePinStore(process.env, true, () => undefined);
  vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
  mockSystemAccountHome();
  clearConfigCache();
  clearRuntimeConfigSnapshot();
  resetRuntimeCapture();
  executor.current = true;
  service.install.mockReset().mockResolvedValue(undefined);
  service.readCommand.mockReset().mockResolvedValue(null);
  await fs.writeFile(
    path.join(state, "openclaw.json"),
    JSON.stringify({ gateway: { mode: "local", auth: { mode: "none" } } }),
  );
  entrypoint = path.join(home, "dist", "index.js");
  await fs.mkdir(path.dirname(entrypoint));
  await fs.writeFile(entrypoint, "");
  process.argv = [process.execPath, entrypoint];
});

function supplyExecutorInput(rebind = false) {
  const root = path.dirname(path.dirname(entrypoint));
  const input = {
    action: "install",
    targetRoot: root,
    executor: {
      runId: "fixture-run",
      root,
      databasePath: path.join(root, "leases.sqlite"),
      databaseIdentity: {},
      childKey: "child",
      originalChildKey: "child",
      parent: { key: root },
      originalParent: { key: root },
      spawner: { key: root },
    },
    ...(rebind ? { originalDefinition: "a".repeat(64) } : {}),
  };
  vi.spyOn(process.stdin, Symbol.asyncIterator).mockImplementation(async function* () {
    yield Buffer.from(JSON.stringify(input));
    return undefined;
  });
}

it.each([false, true])("retains a pre-write install refusal (rebind=%s)", async (rebind) => {
  supplyExecutorInput(rebind);
  const message =
    "Service definition inspection or backup failed; the definition was preserved: inspection failed";
  service.readCommand.mockRejectedValue(
    new ServiceStartRefusalError({ reason: "disabled-no-start", message }),
  );
  await expectExit(() => parseInstall(["--force", "--json", "--update-executor", "run"]));
  expect(JSON.parse(runtimeLogs[0]!)).toMatchObject({
    ok: false,
    error: `SERVICE_DEFINITION_UNKNOWN: ${message}`,
  });
  expect(runtimeErrors).toEqual([]);
  expect(service.install).not.toHaveBeenCalled();
});

it.each([
  { failure: "fence", message: "executor fence lost" },
  { failure: "aggregate", message: "settlement failed" },
])("preserves $failure operation failures", async ({ failure, message }) => {
  supplyExecutorInput();
  await expect(
    runGatewayServiceUpdateCommand("run", "install", async () => {
      if (failure === "fence") {
        executor.current = false;
        throw new ExitError(1);
      }
      throw new AggregateError([new ExitError(1)], message);
    }),
  ).rejects.toThrow(`UPDATE_NATIVE_AUTHORITY: ${message}`);
});

it.each(["closed scope", "recovery unverified"])(
  "preserves nested authority loss: %s",
  async (failure) => {
    supplyExecutorInput();
    let error: unknown;
    if (failure === "closed scope") {
      let assertClosed!: () => void;
      await withGatewayServiceUpdateAuthority(undefined, async (assertCurrent) => {
        assertClosed = assertCurrent;
      });
      try {
        assertClosed();
      } catch (cause) {
        error = cause;
      }
    } else {
      error = new GatewayServiceAuthorityError(
        new GatewayServiceAuthorityError(
          new Error("UPDATE_NATIVE_AUTHORITY: Service definition recovery is unverified"),
          "recovery-pending",
        ),
        "recovery-pending",
      );
    }
    await expectExit(() =>
      runGatewayServiceUpdateCommand("run", "install", async () => {
        createDaemonActionContext({ action: "install", json: true }).fail(String(error));
      }),
    );
    const reported = JSON.parse(runtimeLogs[0]!).error;
    expect(reported).toContain(
      failure === "closed scope"
        ? "UPDATE_NATIVE_AUTHORITY: Native service authority has closed."
        : "UPDATE_NATIVE_AUTHORITY: Service definition recovery is unverified",
    );
    expect(reported.match(/UPDATE_NATIVE_AUTHORITY:/g)).toHaveLength(1);
    expect(runtimeErrors).toEqual([]);
  },
);

afterEach(() => {
  process.argv = originalArgv;
  defaultRuntime.exit.mockImplementation(originalExit);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  clearConfigCache();
  clearRuntimeConfigSnapshot();
});

it.each(["blank-wrapper", "missing-replacement-runtime"] as const)(
  "reports %s once",
  async (reason) => {
    if (reason === "missing-replacement-runtime") {
      service.readCommand.mockResolvedValue({
        programArguments: ["/opt/prior/node", entrypoint, "gateway"],
      });
      vi.spyOn(runtimePaths, "resolveRecordedDaemonRuntime").mockResolvedValue({
        status: "unsupported",
        runtime: "node",
        path: "/opt/prior/node",
        version: "20.0.0",
        ...sqliteCapabilities,
      });
      vi.spyOn(runtimePaths, "resolvePreferredNodePath").mockResolvedValue(undefined);
    }
    defaultRuntime.exit.mockClear();
    await expectExit(() =>
      parseInstall([
        "--force",
        "--json",
        ...(reason === "blank-wrapper" ? ["--wrapper", " "] : ["--runtime", "node"]),
      ]),
    );
    expect(defaultRuntime.exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(runtimeLogs).toHaveLength(1);
    expect(JSON.parse(runtimeLogs[0]!)).toMatchObject({
      ok: false,
      action: "install",
      error:
        reason === "blank-wrapper"
          ? "Invalid --wrapper"
          : expect.stringContaining("No supported Node runtime is available."),
    });
    expect(service.install).not.toHaveBeenCalled();
  },
);
