import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createMockGatewayService } from "../../daemon/service.test-helpers.js";
import { registerNodeCli } from "./register.js";

const mocks = vi.hoisted(() => ({
  runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn(), writeJson: vi.fn() },
  pin: vi.fn(),
  probe: vi.fn(),
}));
const service = createMockGatewayService();
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const observed = { revision: "observed", definition: "failed-node", stored: false };
const workingDirectory = "/retained/node-workspace";

vi.mock("../../runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime.js")>()),
  defaultRuntime: mocks.runtime,
}));
vi.mock("../../daemon/node-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../daemon/node-service.js")>()),
  resolveNodeService: () => service,
}));
vi.mock("../../daemon/runtime-pin-state.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../daemon/runtime-pin-state.js")>()),
  readDaemonRuntimePinForInstall: mocks.pin,
  readDaemonRuntimePin: mocks.pin,
}));
vi.mock("../../process/exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../process/exec.js")>()),
  runExec: mocks.probe,
}));
vi.mock("../../node-host/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../node-host/config.js")>()),
  loadNodeHostConfig: async () => null,
}));
vi.mock("../../daemon/runtime-paths.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../daemon/runtime-paths.js")>()),
  resolveSystemNodeInfo: async () => null,
}));
vi.mock("../../daemon/systemd.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../daemon/systemd.js")>()),
  isSystemdUserServiceAvailable: async () => false,
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
  vi.stubEnv("OPENCLAW_NIX_MODE", undefined);
  vi.stubEnv("OPENCLAW_WRAPPER", undefined);
  vi.stubEnv("OPENCLAW_UPDATE_IN_PROGRESS", undefined);
  mocks.pin.mockReturnValue(observed);
  mocks.probe.mockImplementation(async (executable: string) => ({
    stdout: JSON.stringify({
      nodeVersion: "26.8.1",
      bunVersion: path.basename(executable) === "bun" ? "1.4.2" : null,
      sqliteVersion: "3.53.4",
      sqliteProbe: { available: true, version: "3.53.4", text: true, blob: true, json: true },
    }),
    stderr: "",
  }));
  vi.mocked(service.isLoaded).mockResolvedValue(true);
  vi.mocked(service.readCommand).mockResolvedValue({
    programArguments: ["/failed/node", "/failed/openclaw.mjs", "node", "run"],
    workingDirectory,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it.each([
  { runtime: "node", pinned: false, changed: false },
  { runtime: "bun", pinned: true, changed: false },
  { runtime: "node", pinned: false, changed: true },
] as const)(
  "restores a retained $runtime CLI with pin=$pinned and changed custody=$changed",
  async ({ runtime, pinned, changed }) => {
    const root = tempDirs.make("openclaw-node-restore-");
    const cli = {
      executable: path.join(
        root,
        runtime === "node" && process.platform === "win32" ? "node.exe" : runtime,
      ),
      entrypoint: path.join(root, "dist", "index.js"),
      sqliteLibrary: pinned ? path.join(root, "libsqlite3.dylib") : null,
    };
    fs.mkdirSync(path.dirname(cli.entrypoint));
    for (const file of [cli.executable, cli.entrypoint, cli.sqliteLibrary]) {
      if (file) {
        fs.writeFileSync(file, "", { mode: 0o755 });
      }
    }
    vi.stubEnv("OPENCLAW_SQLITE_LIBRARY", "/controller/libsqlite3.dylib");
    const program = new Command().exitOverride();
    program.configureOutput({ writeErr: () => {}, writeOut: () => {} });
    registerNodeCli(program);
    await program.parseAsync([
      "node",
      "openclaw",
      "node",
      "install",
      "--host",
      "gateway.example",
      "--port",
      "18789",
      "--runtime",
      runtime,
      "--force",
      "--json",
      "--auth-from-env",
      "--expected-runtime-pin",
      JSON.stringify({
        revision: changed ? "stale" : observed.revision,
        definition: observed.definition,
      }),
      "--restore-service-cli",
      JSON.stringify(cli),
      ...(pinned ? ["--runtime-path", cli.executable] : []),
    ]);
    if (changed) {
      expect(service.install).not.toHaveBeenCalled();
      expect(mocks.runtime.writeJson).toHaveBeenCalledWith(
        expect.objectContaining({
          ok: false,
          error: expect.stringContaining("newer selection was preserved"),
        }),
      );
      return;
    }
    expect(service.install).toHaveBeenCalledOnce();
    const installed = vi.mocked(service.install).mock.calls[0]?.[0];
    const runtimeArgs = runtime === "bun" ? ["--no-install"] : [];
    expect(installed?.programArguments.slice(0, 4 + runtimeArgs.length)).toEqual([
      cli.executable,
      ...runtimeArgs,
      cli.entrypoint,
      "node",
      "run",
    ]);
    expect(installed?.runtimePinUpdate).toEqual({
      expected: observed,
      pin: pinned ? { runtime, path: cli.executable } : undefined,
      requireDefinitionMatch: true,
    });
    expect(installed?.workingDirectory).toBe(workingDirectory);
    expect(installed?.environment?.OPENCLAW_SQLITE_LIBRARY).toBe(cli.sqliteLibrary ?? undefined);
    expect(process.env.OPENCLAW_SQLITE_LIBRARY).toBe("/controller/libsqlite3.dylib");
  },
);

it.each([true, false])(
  "observes node runtime custody only from an inspected definition (%s)",
  async (known) => {
    if (!known) {
      vi.mocked(service.readCommand).mockRejectedValueOnce(new Error("inspection unavailable"));
    }
    const program = new Command().exitOverride();
    registerNodeCli(program);
    await program.parseAsync(["node", "openclaw", "node", "status", "--json"]);
    expect(mocks.runtime.writeJson).toHaveBeenCalledWith({
      service: expect.objectContaining({
        runtimeIntent: known ? { ...observed, status: "known" } : { status: "unknown" },
      }),
    });
    if (known) {
      expect(mocks.pin).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "node" }),
        expect.objectContaining({
          programArguments: ["/failed/node", "/failed/openclaw.mjs", "node", "run"],
        }),
      );
    } else {
      expect(mocks.pin).not.toHaveBeenCalled();
    }
  },
);
