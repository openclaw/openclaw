import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withMockedWindowsPlatform } from "../test-utils/vitest-spies.js";
import {
  auditGatewayNodeVersionChange,
  describeGatewayNodePrefixSkew,
  describeGatewayNodeVersionRepair,
  formatGatewayNodePrefixStartupWarning,
  GATEWAY_NODE_PREFIX_SKEW,
  GATEWAY_NODE_VERSION_INSPECT_FAILED,
  GATEWAY_NODE_VERSION_MISSING,
} from "./node-version-prefix.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function makeRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-node-prefix-"));
  roots.push(root);
  return root;
}

async function writeFile(filePath: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, "");
}

function nvmNode(root: string, version: string): string {
  return path.join(root, ".nvm/versions/node", version, "bin/node");
}

function nvmScript(root: string, version: string): string {
  return path.join(root, ".nvm/versions/node", version, "lib/node_modules/openclaw/dist/index.js");
}

describe("gateway node version prefix", () => {
  it("stays quiet when the service Node owns the install", async () => {
    const root = await makeRoot();
    const nodePath = nvmNode(root, "v24.22.1");
    const entrypointPath = nvmScript(root, "v24.22.1");
    await writeFile(nodePath);
    await writeFile(entrypointPath);
    await expect(
      auditGatewayNodeVersionChange({ nodePath, entrypointPath }),
    ).resolves.toBeUndefined();
    expect(
      describeGatewayNodePrefixSkew({
        nodePath,
        packageRoot: path.dirname(path.dirname(path.dirname(entrypointPath))),
      }),
    ).toBeUndefined();
  });

  it("reports a live split between the service Node and the installed package", async () => {
    const root = await makeRoot();
    const nodePath = nvmNode(root, "v24.22.1");
    const entrypointPath = nvmScript(root, "v24.16.0");
    await writeFile(nodePath);
    await writeFile(entrypointPath);
    const issue = await auditGatewayNodeVersionChange({ nodePath, entrypointPath });
    expect(issue).toMatchObject({
      code: GATEWAY_NODE_PREFIX_SKEW,
      level: "recommended",
    });
    expect(issue?.message).toContain("v24.22.1");
    expect(issue?.message).toContain("v24.16.0");
    expect(issue?.message).toContain("stops the gateway before OpenClaw can start");
  });

  it("reports a missing package path while the other Node binary still exists", async () => {
    const root = await makeRoot();
    const nodePath = nvmNode(root, "v24.22.1");
    const entrypointPath = nvmScript(root, "v24.16.0");
    await writeFile(nodePath);
    const issue = await auditGatewayNodeVersionChange({ nodePath, entrypointPath });
    expect(issue).toMatchObject({
      code: GATEWAY_NODE_VERSION_MISSING,
      detail: expect.stringContaining(
        `${path.sep}.nvm${path.sep}versions${path.sep}node${path.sep}v24.16.0`,
      ),
    });
    expect(issue?.message).toContain(entrypointPath);
    expect(issue?.message).toContain(nodePath);
  });

  it("leaves a missing Node binary to the runtime audit", async () => {
    const root = await makeRoot();
    await expect(
      auditGatewayNodeVersionChange({
        nodePath: nvmNode(root, "v24.16.0"),
        entrypointPath: nvmScript(root, "v24.16.0"),
      }),
    ).resolves.toBeUndefined();
  });

  it("reports a missing package behind an entrypoint symlink in the service Node version", async () => {
    const root = await makeRoot();
    const nodePath = nvmNode(root, "v24.22.1");
    const entrypointPath = nvmScript(root, "v24.22.1");
    const target = nvmScript(root, "v24.16.0");
    await writeFile(nodePath);
    await writeFile(target);
    await fs.mkdir(path.dirname(entrypointPath), { recursive: true });
    await fs.symlink(target, entrypointPath);
    expect((await auditGatewayNodeVersionChange({ nodePath, entrypointPath }))?.code).toBe(
      GATEWAY_NODE_PREFIX_SKEW,
    );
    await fs.rm(target);
    expect((await auditGatewayNodeVersionChange({ nodePath, entrypointPath }))?.code).toBe(
      GATEWAY_NODE_VERSION_MISSING,
    );
  });

  it("selects the executable in a Windows fnm installation", () => {
    withMockedWindowsPlatform(() => {
      const repair = describeGatewayNodeVersionRepair({
        code: GATEWAY_NODE_PREFIX_SKEW,
        entrypointPath:
          "C:/Users/example/fnm/node-versions/v24.16.0/installation/node_modules/openclaw/dist/index.js",
        plannedNodePath: "C:/Users/example/fnm/node-versions/v24.22.1/installation/node.exe",
      });
      expect(repair.action).toContain(
        "openclaw gateway install --runtime-path C:/Users/example/fnm/node-versions/v24.16.0/installation/node.exe --force",
      );
    });
  });

  it("ignores package paths outside a version manager", async () => {
    const root = await makeRoot();
    const nodePath = path.join(root, "usr/bin/node");
    const entrypointPath = path.join(root, "usr/lib/node_modules/openclaw/dist/index.js");
    await writeFile(nodePath);
    await expect(
      auditGatewayNodeVersionChange({ nodePath, entrypointPath }),
    ).resolves.toBeUndefined();
  });

  it("treats a symlink back to the service Node's version as the same install", async () => {
    const root = await makeRoot();
    const nodePath = nvmNode(root, "v24.22.1");
    const realScript = nvmScript(root, "v24.22.1");
    const linkedScript = nvmScript(root, "v24.16.0");
    await writeFile(nodePath);
    await writeFile(realScript);
    await fs.mkdir(path.dirname(linkedScript), { recursive: true });
    await fs.symlink(realScript, linkedScript);
    await expect(
      auditGatewayNodeVersionChange({ nodePath, entrypointPath: linkedScript }),
    ).resolves.toBeUndefined();
  });

  it("reports fnm installs split across node-versions directories", () => {
    const message = describeGatewayNodePrefixSkew({
      nodePath: "/home/example/.local/share/fnm/node-versions/v24.22.1/installation/bin/node",
      packageRoot:
        "/home/example/.local/share/fnm/node-versions/v22.22.0/installation/lib/node_modules/openclaw",
    });
    expect(message).toContain("v24.22.1");
    expect(message).toContain("v22.22.0");
  });

  it.each([".fnm", "fnm"])(
    "reports a live %s split and a missing package under that root",
    async (directory) => {
      const root = await makeRoot();
      const nodePath = path.join(root, directory, "node-versions/v24.22.1/installation/bin/node");
      const entrypointPath = path.join(
        root,
        directory,
        "node-versions/v24.16.0/installation/lib/node_modules/openclaw/dist/index.js",
      );
      await writeFile(nodePath);
      await writeFile(entrypointPath);
      const live = await auditGatewayNodeVersionChange({ nodePath, entrypointPath });
      expect(live?.code).toBe(GATEWAY_NODE_PREFIX_SKEW);
      expect(live?.message).toContain(`${directory}/node-versions/v24.16.0`);
      const repair = describeGatewayNodeVersionRepair({
        code: GATEWAY_NODE_PREFIX_SKEW,
        entrypointPath,
        plannedNodePath: nodePath,
      });
      expect(repair.resolvesSplit).toBe(false);
      expect(repair.action).toContain(`${directory}/node-versions/v24.16.0/installation/bin/node`);
      await fs.rm(path.dirname(entrypointPath), { recursive: true, force: true });
      const missing = await auditGatewayNodeVersionChange({ nodePath, entrypointPath });
      expect(missing?.code).toBe(GATEWAY_NODE_VERSION_MISSING);
      expect(missing?.message).toContain(entrypointPath);
    },
  );

  it("reports an unreadable version directory instead of failing the audit", async () => {
    const root = await makeRoot();
    const nodePath = nvmNode(root, "v24.22.1");
    const versionDir = path.join(root, ".nvm/versions/node/v24.16.0");
    const entrypointPath = path.join(versionDir, "lib/node_modules/openclaw/dist/index.js");
    await writeFile(nodePath);
    await fs.mkdir(versionDir, { recursive: true });
    const stat = fs.stat.bind(fs);
    const statSpy = vi.spyOn(fs, "stat").mockImplementation(async (...args) => {
      if (args[0] === entrypointPath) {
        throw Object.assign(new Error("EACCES: fixture version directory is unreadable"), {
          code: "EACCES",
        });
      }
      return stat(...args);
    });
    try {
      const issue = await auditGatewayNodeVersionChange({ nodePath, entrypointPath });
      expect(issue).toMatchObject({
        code: GATEWAY_NODE_VERSION_INSPECT_FAILED,
        repair: "host",
      });
      expect(issue?.message).toContain("EACCES");
    } finally {
      statSpy.mockRestore();
    }
  });

  it("tells a startup warning to select the install Node explicitly", () => {
    const warning = formatGatewayNodePrefixStartupWarning({
      nodePath: "/home/example/.nvm/versions/node/v24.22.1/bin/node",
      packageRoot: "/home/example/.nvm/versions/node/v24.16.0/lib/node_modules/openclaw",
    });
    expect(warning).toContain("does not own this install");
    expect(warning).toContain("Doctor keeps this supported Node");
    expect(warning).toContain(
      "openclaw gateway install --runtime-path /home/example/.nvm/versions/node/v24.16.0/bin/node --force",
    );
    expect(warning).not.toContain("doctor --fix` to point");
  });
});
