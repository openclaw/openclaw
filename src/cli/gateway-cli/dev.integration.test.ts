import { constants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetConfigRuntimeState } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.js";
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

  it("can retry after a partial dev workspace write fails", async () => {
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

    await ensureDevGatewayConfig({});
    const agents = await fs.readFile(path.join(devWorkspace, "AGENTS.md"), "utf8");
    expect(agents).toContain("gateway --dev");
    expect(agents).not.toBe("# PARTIAL\n");
    await fs.access(configPath);
  });
});
