import fs from "node:fs/promises";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../../config/config.js";
import * as runtimePaths from "../../daemon/runtime-paths.js";
import type {
  GatewayServiceCommandConfig,
  GatewayServiceInstallArgs,
} from "../../daemon/service-types.js";
import { mockSystemAccountHome } from "../../daemon/service.test-helpers.js";
import { ExitError } from "../../runtime.js";
import { addGatewayServiceCommands } from "./register-service-commands.js";

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

vi.mock("../../daemon/service.js", () => ({ resolveGatewayService: () => service }));
vi.mock("../../runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime.js")>()),
  defaultRuntime,
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let originalArgv: string[];
let entrypoint: string;

describe("registered gateway install runtime default", () => {
  it("uses the running Bun on first install when Node is unavailable", async () => {
    const execPath = Object.getOwnPropertyDescriptor(process, "execPath")!;
    const bunVersion = Object.getOwnPropertyDescriptor(process.versions, "bun");
    const bunPath = "/opt/app/runtime/bun";
    Object.defineProperty(process, "execPath", { configurable: true, value: bunPath });
    Object.defineProperty(process.versions, "bun", { configurable: true, value: "1.4.2" });
    vi.spyOn(runtimePaths, "resolvePreferredNodePath").mockResolvedValue(undefined);
    vi.spyOn(runtimePaths, "resolveSystemNodeInfo").mockResolvedValue(null);
    const supported = {
      status: "supported" as const,
      version: "1.4.2",
      sqliteVersion: "3.53.4",
      sqliteProbe: { available: true, version: "3.53.4", text: true, blob: true, json: true },
      nodeSharedSqlite: false,
    };
    const probe = vi.spyOn(runtimePaths, "resolveBunRuntimeInfo").mockResolvedValue(supported);
    try {
      const program = new Command().name("openclaw");
      addGatewayServiceCommands(program.command("gateway"));
      await program.parseAsync(["gateway", "install", "--force", "--port", "29453", "--json"], {
        from: "user",
      });
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
      expect(probe).toHaveBeenCalledWith(bunPath, undefined, expect.any(Object));
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

afterEach(() => {
  process.argv = originalArgv;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  clearConfigCache();
  clearRuntimeConfigSnapshot();
});

describe("registered gateway install --force wrapper selection", () => {
  it.each(["blank-wrapper", "missing-replacement-runtime"] as const)(
    "reports %s only once with an exiting runtime",
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
          sqliteVersion: "3.53.4",
          nodeSharedSqlite: false,
          sqliteProbe: { available: true, version: "3.53.4", text: true, blob: true, json: true },
        });
        vi.spyOn(runtimePaths, "resolvePreferredNodePath").mockResolvedValue(undefined);
      }
      defaultRuntime.exit.mockClear();
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
              [
                "gateway",
                "install",
                "--force",
                "--json",
                ...(reason === "blank-wrapper" ? ["--wrapper", " "] : ["--runtime", "node"]),
              ],
              { from: "user" },
            ),
          ).rejects.toBe(exit);
        },
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
});
