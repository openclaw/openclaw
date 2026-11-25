import { constants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_AGENTS_FILENAME } from "../../agents/workspace-bootstrap-policy.js";
import type {
  WorkspaceFilesystemCommand,
  WorkspaceFilesystemReadCommand,
  WorkspaceFilesystemReadReply,
  WorkspaceFilesystemReply,
} from "../../agents/workspace-filesystem.types.js";
import { executeWorkspaceFilesystemOperation } from "../../agents/workspace-filesystem.worker.js";
import { resetConfigRuntimeState } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.js";
import type {
  FsSafeStoreCommand,
  FsSafeStoreReply,
} from "../../infra/fs-safe-copy-worker-contract.js";
import * as filesystemWorker from "../../infra/fs-safe-filesystem-worker.js";
import { withWorkerFsSafeNativeMode } from "../../infra/worker-fs-safe.js";
import { workerMutationAssertion } from "../../infra/worker-mutation-authority.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { nodeFilePath } from "../../test-utils/node-file-path.js";
import { ensureDevGatewayConfig } from "./dev.js";

describe("ensureDevGatewayConfig integration", () => {
  let root: string;
  let configPath: string;
  let workspace: string;
  let devWorkspace: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-dev-config-integration-"));
    const stateDir = path.join(root, "state");
    configPath = path.join(stateDir, "openclaw.json");
    workspace = path.join(root, "workspace");
    devWorkspace = `${workspace}-dev`;
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
    vi.stubEnv("OPENCLAW_WORKSPACE_DIR", workspace);
    resetConfigRuntimeState();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    resetConfigRuntimeState();
    vi.unstubAllEnvs();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("writes the dedicated dev roster into a fresh state directory", async () => {
    await ensureDevGatewayConfig({});
    const config = JSON.parse(await fs.readFile(configPath, "utf8")) as OpenClawConfig;
    expect(config.gateway).toEqual({ mode: "local", bind: "loopback" });
    expect(config.agents?.defaults).toMatchObject({
      workspace: `${workspace}-dev`,
      skipBootstrap: true,
    });
    expect(config.agents?.entries).toEqual({
      dev: {
        workspace: `${workspace}-dev`,
        identity: { name: "C3-PO", theme: "protocol droid", emoji: "🤖" },
      },
    });
  });

  it("can retry after a partial dev workspace write fails", async ({ signal }) => {
    const resolvedDevWorkspace = path.join(await fs.realpath(root), path.basename(devWorkspace));
    const realOpen = fs.open.bind(fs);
    let injected = false;
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await realOpen(...args);
      const rawPath = nodeFilePath(args[0]);
      const exclusiveCreate =
        typeof args[1] === "number" &&
        (args[1] & constants.O_CREAT) !== 0 &&
        (args[1] & constants.O_EXCL) !== 0;
      if (
        !injected &&
        rawPath &&
        path.dirname(path.resolve(rawPath)) === resolvedDevWorkspace &&
        exclusiveCreate
      ) {
        vi.spyOn(handle, "write").mockImplementationOnce(async () => {
          injected = true;
          await handle.writeFile("# PARTIAL\n");
          throw Object.assign(new Error("ENOSPC"), { code: "ENOSPC" });
        });
      }
      return handle;
    });

    const run = filesystemWorker.runFsSafeFilesystemTask;
    type Options = Parameters<typeof run>[1];
    function intercept(
      command: WorkspaceFilesystemReadCommand,
      options?: Options,
    ): Promise<WorkspaceFilesystemReadReply>;
    function intercept(
      command: WorkspaceFilesystemCommand,
      options?: Options,
    ): Promise<WorkspaceFilesystemReply>;
    function intercept(command: FsSafeStoreCommand, options?: Options): Promise<FsSafeStoreReply>;
    function intercept(
      command: WorkspaceFilesystemReadCommand | WorkspaceFilesystemCommand | FsSafeStoreCommand,
      options?: Options,
    ) {
      if (command.type === "workspace") {
        const operation = command.operation;
        if (
          operation.kind === "publish" &&
          operation.dir === devWorkspace &&
          operation.name === DEFAULT_AGENTS_FILENAME &&
          !injected
        ) {
          const notify = options?.onNotification;
          if (!notify) {
            throw new Error("Bootstrap publication must retain its live authority callback");
          }
          // Keep the actual publication/cleanup owner in the isolate with the injected I/O failure.
          return withWorkerFsSafeNativeMode(command.nativeMode, () =>
            executeWorkspaceFilesystemOperation(
              command,
              workerMutationAssertion(
                command.decision,
                () => notify("authority"),
                () => signal.throwIfAborted(),
              ),
            ),
          );
        }
        return run(command, options);
      }
      return command.type === "workspace-read" ? run(command, options) : run(command, options);
    }
    const dispatch = vi
      .spyOn(filesystemWorker, "runFsSafeFilesystemTask")
      .mockImplementation(intercept);

    await expect(
      withEnvAsync({ FS_SAFE_NATIVE_MODE: "off" }, () => ensureDevGatewayConfig({})),
    ).rejects.toMatchObject({ cause: { code: "ENOSPC" } });
    expect(injected).toBe(true);
    await expect(fs.access(configPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.access(path.join(devWorkspace, "AGENTS.md"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await fs.readdir(devWorkspace)).toEqual([]);
    vi.mocked(fs.open).mockRestore();
    dispatch.mockRestore();

    await ensureDevGatewayConfig({});
    const agents = await fs.readFile(path.join(devWorkspace, "AGENTS.md"), "utf8");
    expect(agents).toContain("gateway --dev");
    expect(agents).not.toBe("# PARTIAL\n");
    await fs.access(configPath);
  });
});
