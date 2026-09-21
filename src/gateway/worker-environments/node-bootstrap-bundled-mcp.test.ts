import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { promisify } from "node:util";
import * as tar from "tar";
import { expect, it } from "vitest";
import { useNodeBootstrapArtifactFixtures, write } from "./node-bootstrap-artifact.test-support.js";

const { fixture, createProvider } = useNodeBootstrapArtifactFixtures();

it("bootstraps the patched browser distribution without treating optional vendor imports as missing runtime files", async () => {
  const source = path.dirname(
    createRequire(import.meta.url).resolve("chrome-devtools-mcp/package.json"),
  );
  const { root, packageRoot, provider, options, sourcePackage } = await fixture();
  await write(packageRoot, "package.json", {
    ...sourcePackage,
    dependencies: { ...sourcePackage.dependencies, "chrome-devtools-mcp": "1.8.0" },
    bundleDependencies: ["chrome-devtools-mcp"],
  });
  const bundled = path.join(packageRoot, "node_modules/chrome-devtools-mcp");
  await fs.cp(source, bundled, { recursive: true });
  const artifact = await provider.prepare();
  const installed = path.join(root, "node");
  await fs.mkdir(installed);
  await tar.extract({ file: artifact.tarballPath, cwd: installed });
  const target = path.join(installed, "package/node_modules/chrome-devtools-mcp");
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [path.join(target, "build/src/bin/chrome-devtools-mcp.js"), "--version"],
    {
      env: {
        ...process.env,
        CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: "1",
        CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS: "1",
      },
    },
  );
  expect(stdout.trim()).toBe("1.8.0");
  for (const file of [
    "build/src/TextSnapshot.js",
    "build/src/McpPage.js",
    "build/src/third_party/index.js",
    "build/src/OPENCLAW_PATCH_NOTICE.md",
    "LICENSE",
  ]) {
    expect(
      (await fs.readFile(path.join(target, file))).equals(
        await fs.readFile(path.join(source, file)),
      ),
      file,
    ).toBe(true);
  }
  await fs.appendFile(path.join(bundled, "build/src/TextSnapshot.js"), "\n");
  await expect(createProvider(options).prepare()).rejects.toThrow(
    "unpatched or changed runtime entry build/src/TextSnapshot.js",
  );
});
