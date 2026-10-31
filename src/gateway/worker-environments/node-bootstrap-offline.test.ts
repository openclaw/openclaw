import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import * as tar from "tar";
import { describe, expect, it } from "vitest";
import {
  useNodeBootstrapArtifactFixtures,
  write,
  writeFiles,
  extract,
  readText,
} from "./node-bootstrap-artifact.test-support.js";
const { fixture, createProvider } = useNodeBootstrapArtifactFixtures();
describe("offline node bootstrap", () => {
  it("carries qualified target dependencies without copying the source installation", async () => {
    const { root, packageRoot, options, sourcePackage } = await fixture("package");
    const platform = process.platform === "linux" ? "darwin" : "linux";
    const arch = "arm64";
    const target = platform + "-" + arch;
    const input = path.join(packageRoot, "node-runtime-dependencies", target);
    await write(packageRoot, "pnpm-lock.yaml", "fixture-frozen-lock");
    await fs.mkdir(input, { recursive: true });
    await fs.cp(path.join(packageRoot, "node_modules"), path.join(input, "node_modules"), {
      recursive: true,
      dereference: true,
    });
    await writeFiles(input, {
      "package.json": sourcePackage,
      "runtime-input.json": {
        platform,
        arch,
        packageJsonSha256: createHash("sha256")
          .update(await fs.readFile(path.join(packageRoot, "package.json")))
          .digest("hex"),
        lockfileSha256: createHash("sha256").update("fixture-frozen-lock").digest("hex"),
      },
      "node_modules/native-runtime/index.js": "module.exports = 'target-native';",
    });
    const artifact = await createProvider({ ...options, install: "bundle" }).prepare();
    const installed = await extract(root, artifact);
    expect(JSON.parse(await readText(installed, "node-runtime.json"))).toMatchObject({
      install: "bundle",
      platforms: [
        { platform: process.platform, arch: process.arch, prefix: "" },
        { platform, arch, prefix: "runtime-dependencies/" + target + "/" },
      ],
    });
    expect(
      await readText(
        installed,
        "runtime-dependencies/" + target + "/node_modules/native-runtime/index.js",
      ),
    ).toBe("module.exports = 'target-native';");
    expect(JSON.parse(await readText(installed, "package.json")).scripts).toBeUndefined();
    expect(
      createHash("sha256")
        .update(await readText(installed, "node-runtime.manifest.json"))
        .digest("hex"),
    ).toBe(artifact.manifestSha256);
    await expect(
      fs.access(path.join(installed, "node-runtime-dependencies")),
    ).rejects.toHaveProperty("code", "ENOENT");
  });
  it("runs nested builtin-name package versions and plugin-owned dependencies despite a Gateway dev shadow", async () => {
    const { root, packageRoot, sourcePackage, options } = await fixture();
    await write(packageRoot, "package.json", {
      ...sourcePackage,
      dependencies: {
        ...sourcePackage.dependencies,
        "registry-runtime": "1.0.0",
        string_decoder: "2.0.0",
      },
    });
    await write(packageRoot, "node_modules/registry-runtime/package.json", {
      name: "registry-runtime",
      version: "1.0.0",
      main: "index.js",
      dependencies: { string_decoder: "1.0.0" },
    });
    await write(
      packageRoot,
      "node_modules/registry-runtime/index.js",
      'module.exports = require("string_decoder/");',
    );
    for (const [prefix, dependencyVersion] of [
      ["", "2.0.0"],
      ["registry-runtime/node_modules/", "1.0.0"],
    ]) {
      await write(packageRoot, `node_modules/${prefix}string_decoder/package.json`, {
        name: "string_decoder",
        version: dependencyVersion,
        main: "index.js",
      });
      await write(
        packageRoot,
        `node_modules/${prefix}string_decoder/index.js`,
        `module.exports = "${dependencyVersion}";`,
      );
    }
    await writeFiles(packageRoot, {
      "node_modules/native-runtime/package.json": {
        name: "native-runtime",
        version: "9.0.0",
        main: "index.js",
      },
      "extensions/remote-runtime/node_modules/native-runtime/index.js":
        "module.exports = 'plugin-owned';",
      "dist/extensions/remote-runtime/index.js":
        'import answer from "native-runtime"; export { answer };',
    });
    await write(
      packageRoot,
      "dist/entry.js",
      'import nested from "registry-runtime"; import root from "string_decoder/index.js"; import { answer } from "./extensions/remote-runtime/index.js"; console.log(nested + ":" + root + ":" + answer);',
    );
    const artifact = await createProvider({ ...options, install: "bundle" }).prepare();
    const installed = path.join(root, "directly-extracted");
    await fs.mkdir(installed);
    await tar.extract({ file: artifact.tarballPath, cwd: installed });
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [path.join(installed, "package/openclaw.mjs")],
      { env: { PATH: "", npm_config_registry: "http://127.0.0.1:9" } },
    );
    expect(stdout.trim()).toBe("1.0.0:2.0.0:plugin-owned");
  });
  it.each(["mismatched", "non-object"])("rejects a %s target dependency receipt", async (kind) => {
    const { packageRoot, sourcePackage, options } = await fixture();
    const target = process.platform === "linux" ? "darwin-arm64" : "linux-x64";
    const input = path.join(packageRoot, "node-runtime-dependencies", target);
    const receipt = {
      platform: target.split("-")[0],
      arch: target.split("-")[1],
      packageJsonSha256: "0".repeat(64),
      lockfileSha256: "0".repeat(64),
    };
    await write(input, "package.json", sourcePackage);
    await write(input, "runtime-input.json", kind === "non-object" ? "null" : receipt);
    await expect(createProvider({ ...options, install: "bundle" }).prepare()).rejects.toThrow(
      "does not match the running source/dependencies",
    );
  });
});
