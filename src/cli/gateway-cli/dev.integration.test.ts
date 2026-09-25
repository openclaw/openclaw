// Proves a fresh dev gateway can replace the synthetic implicit roster through real config IO.
import { constants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetConfigRuntimeState } from "../../config/config.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { nodeFilePath } from "../../test-utils/node-file-path.js";
import { ensureDevGatewayConfig } from "./dev.js";

describe("ensureDevGatewayConfig integration", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    resetConfigRuntimeState();
    await Promise.all(
      tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
  });

  it("writes the dedicated dev roster into a fresh state directory", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-dev-config-integration-"));
    tempDirs.push(root);
    const stateDir = path.join(root, "state");
    const configPath = path.join(stateDir, "openclaw.json");
    const workspace = path.join(root, "workspace");

    await withEnvAsync(
      {
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_WORKSPACE_DIR: workspace,
      },
      async () => {
        resetConfigRuntimeState();
        await ensureDevGatewayConfig({});
      },
    );

    const config = JSON.parse(await fs.readFile(configPath, "utf8")) as {
      agents?: { entries?: Record<string, { default?: boolean; workspace?: string }> };
    };
    expect(config.agents?.entries).toEqual({
      dev: { default: true, workspace: `${workspace}-dev`, identity: expect.any(Object) },
    });
  });

  it("can retry after a partial dev workspace write fails", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-dev-config-integration-"));
    tempDirs.push(root);
    const stateDir = path.join(root, "state");
    const configPath = path.join(stateDir, "openclaw.json");
    const workspace = path.join(root, "workspace");
    const devWorkspace = `${workspace}-dev`;
    const resolvedDevWorkspace = path.join(await fs.realpath(root), path.basename(devWorkspace));

    await withEnvAsync(
      {
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_WORKSPACE_DIR: workspace,
      },
      async () => {
        resetConfigRuntimeState();
        const realOpen = fs.open.bind(fs);
        let injected = false;
        const openSpy = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
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

        try {
          await expect(
            withEnvAsync({ FS_SAFE_NATIVE_MODE: "off" }, () => ensureDevGatewayConfig({})),
          ).rejects.toMatchObject({ cause: { code: "ENOSPC" } });
          expect(injected).toBe(true);
          await expect(fs.access(configPath)).rejects.toMatchObject({ code: "ENOENT" });
          await expect(fs.access(path.join(devWorkspace, "AGENTS.md"))).rejects.toMatchObject({
            code: "ENOENT",
          });
          expect(await fs.readdir(devWorkspace)).toEqual([]);
        } finally {
          openSpy.mockRestore();
        }

        await ensureDevGatewayConfig({});
        const agents = await fs.readFile(path.join(devWorkspace, "AGENTS.md"), "utf8");
        expect(agents).toContain("gateway --dev");
        expect(agents).not.toBe("# PARTIAL\n");
        await expect(fs.access(configPath)).resolves.toBeUndefined();
      },
    );
  });
});
