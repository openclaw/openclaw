import "./service-definition-backup.mocks.test-support.js";
import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { fixture, native } from "./service-definition-backup.test-support.js";
import { buildSystemdUnit } from "./systemd-unit.js";

vi.mock("./service-audit.js", () => ({
  auditGatewayServiceConfig: async () => ({ issues: [], definitionDrift: [] }),
}));

it.each([false, true])(
  "reconciles only the active pnpm root after generation deletion (foreign=%s)",
  async (foreign) => {
    const f = await fixture("linux");
    const home = path.join(f.env.HOME!, "pnpm");
    const globalRoot = path.join(home, "global/v11");
    const project = path.join(globalRoot, "active");
    const activeRoot = path.join(project, "node_modules/openclaw");
    await fs.mkdir(activeRoot, { recursive: true });
    await fs.writeFile(
      path.join(activeRoot, "package.json"),
      JSON.stringify({ name: "openclaw", version: "2026.11.5" }),
    );
    await fs.writeFile(
      path.join(project, "package.json"),
      JSON.stringify({ dependencies: { openclaw: "2026.11.5" } }),
    );
    await fs.writeFile(path.join(project, "pnpm-lock.yaml"), "lockfileVersion: 9\n");
    await fs.symlink(project, path.join(globalRoot, "hash-active"), "dir");
    const oldGlobal = foreign ? path.join(f.env.HOME!, "foreign/global/v11") : globalRoot;
    const retired = path.join(
      oldGlobal,
      "active/node_modules/.pnpm/openclaw@2026.8.35/node_modules/openclaw",
    );
    f.command.programArguments = ["/usr/bin/node", path.join(retired, "dist/index.js"), "gateway"];
    await fs.writeFile(f.sourcePath, buildSystemdUnit(f.command));
    const original = await fs.readFile(f.sourcePath);
    const install = vi.fn(f.install);
    vi.doMock("./service.js", () => ({
      resolveGatewayService: () => ({ readCommand: native.command }),
      readGatewayServiceState: async () => ({
        command: await native.command(),
        runtime: { status: "stopped", systemd: { managerUid: process.getuid?.() } },
        loadState: { status: "loaded" },
        env: f.env,
      }),
    }));
    const { reconcileGatewayServiceDefinition } = await import("./service-reconciliation.js");
    const result = reconcileGatewayServiceDefinition({
      env: f.env,
      root: activeRoot,
      command: f.command,
      expectedCommand: f.command,
      install,
      warn: () => {},
    });
    if (foreign) {
      await expect(result).rejects.toThrow("SERVICE_DEFINITION_UNKNOWN");
      expect(install).not.toHaveBeenCalled();
      expect(await fs.readFile(f.sourcePath)).toEqual(original);
    } else {
      await expect(result).resolves.toMatchObject({ files: expect.any(Array) });
      expect(install).toHaveBeenCalledOnce();
      expect(await fs.readFile(f.sourcePath, "utf8")).toContain("/new/index.js");
    }
  },
);
