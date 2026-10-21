import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as nodeService from "../../daemon/node-service.js";
import * as runtimePaths from "../../daemon/runtime-paths.js";
import { createMockGatewayService } from "../../daemon/service.test-helpers.js";
import * as nodeConfig from "../../node-host/config.js";
import * as exec from "../../process/exec.js";
import { nodeProbeOutput } from "../daemon-cli/install.test-helpers.js";
import { expectPartialCall } from "../daemon-cli/lifecycle-assertions.test-support.js";
import { registerNodeCli } from "./register.js";

const mocks = vi.hoisted(() => ({
  runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn(), writeJson: vi.fn() },
  pin: vi.fn(),
  pending: vi.fn(),
}));
const service = createMockGatewayService();
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const observed = { revision: "observed", definition: "failed-node", stored: false };
const workingDirectory = "/retained/node-workspace";
const programArguments = ["/failed/node", "/failed/openclaw.mjs", "node", "run"];

async function runNode(command: string, ...args: string[]) {
  const program = new Command().exitOverride();
  registerNodeCli(program);
  await program.parseAsync(["node", "openclaw", "node", ...command.split(" "), ...args]);
}

vi.mock("../../runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime.js")>()),
  defaultRuntime: mocks.runtime,
}));
vi.mock("../../daemon/runtime-pin-state.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../daemon/runtime-pin-state.js")>()),
  withDaemonRuntimePinMigration: async <T>(_env: NodeJS.ProcessEnv, run: () => T) => run(),
  readDaemonRuntimePinForInstall: mocks.pin,
  readDaemonRuntimePin: mocks.pin,
  readDaemonRuntimePinMigrationPending: mocks.pending,
}));
beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(nodeService, "resolveNodeService").mockReturnValue(service);
  vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
  vi.stubEnv("OPENCLAW_NIX_MODE", undefined);
  vi.stubEnv("OPENCLAW_WRAPPER", undefined);
  vi.stubEnv("OPENCLAW_UPDATE_IN_PROGRESS", undefined);
  mocks.pin.mockReturnValue(observed);
  mocks.pending.mockReturnValue(false);
  vi.spyOn(nodeConfig, "loadNodeHostConfig").mockResolvedValue(null);
  vi.spyOn(runtimePaths, "resolveSystemNodeInfo").mockResolvedValue(null);
  vi.spyOn(exec, "runExec").mockImplementation(async (executable) => ({
    stderr: "",
    stdout: JSON.stringify({
      ...JSON.parse(nodeProbeOutput("26.8.1").stdout),
      bunVersion: path.basename(executable) === "bun" ? "1.4.3" : null,
    }),
  }));
  vi.mocked(service.isLoaded).mockResolvedValue(true);
  vi.mocked(service.readCommand).mockResolvedValue({ programArguments, workingDirectory });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it.each([
  { runtime: "node", pinned: false, changed: false, launcher: "openclaw.mjs" },
  { runtime: "bun", pinned: true, changed: false, launcher: "openclaw.mjs" },
  { runtime: "node", pinned: false, changed: false, launcher: "dist/entry.js" },
  { runtime: "node", pinned: false, changed: true, launcher: "openclaw.mjs" },
] as const)(
  "restores $runtime via $launcher (pin=$pinned, changed=$changed)",
  async ({ runtime, pinned, changed, launcher }) => {
    const root = tempDirs.make("openclaw-node-restore-");
    const cli = {
      executable: path.join(root, runtime),
      entrypoint: path.join(root, "dist", "index.js"),
      sqliteLibrary: pinned ? path.join(root, "libsqlite3.dylib") : null,
    };
    const launcherPath = path.join(root, launcher);
    fs.mkdirSync(path.dirname(cli.entrypoint));
    for (const file of [cli.executable, cli.entrypoint, launcherPath, cli.sqliteLibrary]) {
      if (file) {
        fs.writeFileSync(file, "", { mode: 0o755 });
      }
    }
    vi.stubEnv("OPENCLAW_SQLITE_LIBRARY", "/controller/libsqlite3.dylib");
    await runNode(
      "install --host=gateway.example --port=18789 --force --json --auth-from-env",
      `--runtime=${runtime}`,
      "--expected-runtime-pin",
      JSON.stringify({
        revision: changed ? "stale" : observed.revision,
        definition: observed.definition,
      }),
      "--restore-service-cli",
      JSON.stringify(cli),
      ...(pinned ? ["--runtime-path", cli.executable] : []),
    );
    if (changed) {
      expect(service.install).not.toHaveBeenCalled();
      expectPartialCall(mocks.runtime.writeJson, {
        ok: false,
        error: expect.stringContaining("newer selection was preserved"),
      });
      return;
    }
    expect(service.install).toHaveBeenCalledOnce();
    const installed = vi.mocked(service.install).mock.calls[0]?.[0];
    const runtimeArgs = runtime === "bun" ? ["--no-install"] : [];
    const prefix = [cli.executable, ...runtimeArgs, launcherPath, "node", "run"];
    expect(installed?.programArguments.slice(0, prefix.length)).toEqual(prefix);
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

it.each([
  { status: "known", ...observed },
  { status: "unknown" },
  { status: "migrationPending", nextStep: "run openclaw doctor" },
])("reports $status node runtime custody", async (runtimeIntent) => {
  const { status } = runtimeIntent;
  if (status === "unknown") {
    vi.mocked(service.readCommand).mockRejectedValueOnce(new Error("inspection unavailable"));
  }
  mocks.pending.mockReturnValue(status === "migrationPending");
  await runNode("status --json");
  expect(mocks.runtime.writeJson).toHaveBeenCalledWith({
    service: expect.objectContaining({ runtimeIntent }),
  });
  if (status === "known") {
    expect(mocks.pin).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "node" }),
      expect.objectContaining({ programArguments }),
    );
  } else {
    expect(mocks.pin).not.toHaveBeenCalled();
  }
});
