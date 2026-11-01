import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  auditGatewayNodeVersionChange,
  describeGatewayNodePrefixSkew,
  GATEWAY_NODE_PREFIX_SKEW,
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
});
