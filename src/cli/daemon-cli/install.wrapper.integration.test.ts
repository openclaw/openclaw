import fs from "node:fs/promises";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../../config/config.js";
import { resolveLaunchAgentLabel } from "../../daemon/launchd-label.js";
import { resolveLaunchAgentEnvWrapperPath } from "../../daemon/launchd-service-files.js";
import * as runtimePaths from "../../daemon/runtime-paths.js";
import * as runtimePins from "../../daemon/runtime-pin-state.js";
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

describe("registered gateway install runtime default", () => {
  it.each([
    { name: "Bun-only first install", node: undefined, explicit: false, supportedBun: true },
    { name: "explicit Node without Node", node: undefined, explicit: true, supportedBun: true },
    { name: "available Node", node: "/opt/node/bin/node", explicit: false, supportedBun: true },
    { name: "unsupported running Bun", node: undefined, explicit: false, supportedBun: false },
    { name: "recorded runtime", node: undefined, explicit: false, supportedBun: true },
    { name: "pinned runtime", node: undefined, explicit: false, supportedBun: true },
  ])("handles $name", async ({ name, node, explicit, supportedBun }) => {
    const execPath = Object.getOwnPropertyDescriptor(process, "execPath")!;
    const bunVersion = Object.getOwnPropertyDescriptor(process.versions, "bun");
    const bunPath = "/opt/app/runtime/bun";
    Object.defineProperty(process, "execPath", { configurable: true, value: bunPath });
    Object.defineProperty(process.versions, "bun", { configurable: true, value: "1.4.2" });
    vi.spyOn(runtimePaths, "resolvePreferredNodePath").mockResolvedValue(node);
    vi.spyOn(runtimePaths, "resolveSystemNodeInfo").mockResolvedValue(null);
    const supported = {
      status: "supported" as const,
      version: "1.4.2",
      sqliteVersion: "3.53.4",
      sqliteProbe: { available: true, version: "3.53.4", text: true, blob: true, json: true },
      nodeSharedSqlite: false,
    };
    const probe = vi.spyOn(runtimePaths, "resolveBunRuntimeInfo").mockResolvedValue({
      ...supported,
      status: supportedBun ? "supported" : "unsupported",
    });
    const retainedPath =
      name === "recorded runtime" || name === "pinned runtime" ? "/opt/prior/bun" : undefined;
    const pin =
      name === "pinned runtime" ? { runtime: "bun" as const, path: "/opt/prior/bun" } : undefined;
    if (retainedPath) {
      service.readCommand.mockResolvedValue({
        programArguments: [retainedPath, entrypoint, "gateway"],
      });
      vi.spyOn(runtimePaths, "resolveRecordedDaemonRuntime").mockResolvedValue({
        ...supported,
        runtime: "bun",
        path: retainedPath,
      });
    }
    if (pin) {
      vi.spyOn(runtimePins, "readDaemonRuntimePinForInstall").mockReturnValue({
        revision: "prior",
        stored: true,
        pin,
      });
      vi.spyOn(runtimePaths, "resolvePinnedDaemonRuntimePath").mockResolvedValue(pin.path);
    }
    try {
      const program = new Command().name("openclaw");
      addGatewayServiceCommands(program.command("gateway"));
      const install = program.parseAsync(
        [
          "gateway",
          "install",
          "--force",
          "--port",
          "29453",
          "--json",
          ...(explicit ? ["--runtime", "node"] : []),
        ],
        { from: "user" },
      );
      if (!node && (explicit || !supportedBun)) {
        await expect(install).rejects.toThrow("No supported Node runtime was selected");
        expect(service.install).not.toHaveBeenCalled();
      } else {
        await install;
        expect(runtimeErrors).toEqual([]);
        expect(service.install).toHaveBeenCalledOnce();
        const [installed] = service.install.mock.calls[0]!;
        expect(installed.programArguments[0]).toBe(retainedPath ?? node ?? bunPath);
        expect(installed.runtimePinUpdate?.pin).toEqual(pin);
        if (!node && !retainedPath) {
          expect(installed.programArguments).toEqual([
            bunPath,
            entrypoint,
            "gateway",
            "--port",
            "29453",
          ]);
          expect(probe).toHaveBeenCalledWith(bunPath, undefined, expect.any(Object));
          expect(JSON.parse(runtimeLogs.at(-1)!).warnings).toEqual([
            "No supported Node runtime was found; using the running Bun for the service.",
          ]);
        }
      }
      if (explicit || node || retainedPath) {
        expect(probe).not.toHaveBeenCalled();
      }
    } finally {
      Object.defineProperty(process, "execPath", execPath);
      if (bunVersion) {
        Object.defineProperty(process.versions, "bun", bunVersion);
      } else {
        delete process.versions.bun;
      }
    }
  });
});

beforeEach(async () => {
  originalArgv = process.argv;
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
  vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
  mockSystemAccountHome();
  clearConfigCache();
  clearRuntimeConfigSnapshot();
  resetRuntimeCapture();
  executor.current = true;
  service.install.mockReset();
  service.install.mockResolvedValue(undefined);
  service.readCommand.mockReset();
  service.readCommand.mockResolvedValue(null);
  await fs.mkdir(state);
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

describe("update executor failure reporting", () => {
  it.each([false, true])("retains a pre-write install refusal (rebind=%s)", async (rebind) => {
    supplyExecutorInput(rebind);
    // T sanitizes a plain inspection rejection before the install action reports it.
    service.readCommand.mockRejectedValue(
      new Error("SERVICE_DEFINITION_UNKNOWN: inspection failed"),
    );
    const exit = new ExitError(1);
    await defaultRuntime.exit.withImplementation(
      () => {
        throw exit;
      },
      async () => {
        const program = new Command().name("openclaw");
        addGatewayServiceCommands(program.command("gateway"));
        await expect(
          program.parseAsync(
            ["gateway", "install", "--force", "--json", "--update-executor", "run"],
            { from: "user" },
          ),
        ).rejects.toBe(exit);
      },
    );
    expect(JSON.parse(runtimeLogs[0]!)).toMatchObject({
      ok: false,
      error: "SERVICE_DEFINITION_UNKNOWN: Service definition cannot be safely inspected.",
    });
    expect(runtimeErrors).toEqual([]);
    expect(service.install).not.toHaveBeenCalled();
  });

  it("labels an operation exit after its executor fence is lost", async () => {
    supplyExecutorInput();
    await expect(
      runGatewayServiceUpdateCommand("run", "install", async () => {
        executor.current = false;
        throw new ExitError(1);
      }),
    ).rejects.toThrow("UPDATE_NATIVE_AUTHORITY: executor fence lost");
  });

  it.each(["closed scope", "recovery unverified"])(
    "retains a reported nested authority loss with a current executor: %s",
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
      const exit = new ExitError(1);
      await defaultRuntime.exit.withImplementation(
        () => {
          throw exit;
        },
        async () => {
          await expect(
            runGatewayServiceUpdateCommand("run", "install", async () => {
              createDaemonActionContext({ action: "install", json: true }).fail(String(error));
            }),
          ).rejects.toBe(exit);
        },
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

  it("does not unwrap an operation exit from an aggregate failure", async () => {
    supplyExecutorInput();
    await expect(
      runGatewayServiceUpdateCommand("run", "install", async () => {
        throw new AggregateError([new ExitError(1)], "settlement failed");
      }),
    ).rejects.toThrow("UPDATE_NATIVE_AUTHORITY: settlement failed");
  });
});

afterEach(() => {
  process.argv = originalArgv;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  clearConfigCache();
  clearRuntimeConfigSnapshot();
});

describe("registered gateway install --force wrapper selection", () => {
  it.each(["explicit", "persisted", "custom"] as const)(
    "selects a runnable service command for a %s wrapper",
    async (source) => {
      const wrapper =
        source === "custom"
          ? path.join(process.env.HOME!, "custom-wrapper.sh")
          : resolveLaunchAgentEnvWrapperPath(process.env, resolveLaunchAgentLabel(process.env));
      await fs.mkdir(path.dirname(wrapper), { recursive: true });
      await fs.writeFile(wrapper, '#!/bin/sh\nexec "$@"\n', { mode: 0o700 });
      if (source === "persisted") {
        vi.stubEnv("OPENCLAW_WRAPPER", undefined);
        service.readCommand.mockResolvedValue({
          programArguments: [wrapper, "gateway", "--port", "29453"],
          environment: { OPENCLAW_WRAPPER: wrapper, WRAPPER_TEST_VALUE: "retained" },
        });
      }
      const program = new Command().name("openclaw");
      addGatewayServiceCommands(program.command("gateway"));
      await program.parseAsync(
        [
          "gateway",
          "install",
          "--force",
          "--runtime",
          "node",
          "--port",
          "29453",
          "--json",
          ...(source === "persisted" ? [] : ["--wrapper", wrapper]),
        ],
        { from: "user" },
      );
      expect(runtimeErrors).toEqual([]);
      expect(service.install).toHaveBeenCalledOnce();
      const [installed] = service.install.mock.calls[0]!;
      if (source === "custom") {
        expect(installed.programArguments).toEqual([wrapper, "gateway", "--port", "29453"]);
        expect(installed.environment?.OPENCLAW_WRAPPER).toBe(wrapper);
      } else {
        expect(installed.programArguments).toContain(entrypoint);
        expect(installed.programArguments).not.toContain(wrapper);
        expect(installed.environment?.OPENCLAW_WRAPPER).toBeUndefined();
      }
      if (source === "persisted") {
        expect(installed.environment?.WRAPPER_TEST_VALUE).toBe("retained");
      }
    },
  );
});
