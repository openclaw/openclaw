import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function writeExecutable(file: string, content: string) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
  chmodSync(file, 0o755);
}

describe("GenerateGatewayProtocol SwiftPM plugin", () => {
  it.runIf(process.platform === "darwin")(
    "runs generation with a supported concrete Node when shims and old Node lead PATH",
    { timeout: 180_000 },
    () => {
      const root = tempDirs.make("openclaw-protocol-plugin-");
      const node = realpathSync(process.execPath);
      const pkg = path.join(root, "apps/shared/OpenClawKit");
      copyFileSync("node-version.mjs", path.join(root, "node-version.mjs"));
      mkdirSync(path.join(pkg, "Plugins/GenerateGatewayProtocol"), { recursive: true });
      copyFileSync(
        "apps/shared/OpenClawKit/Plugins/GenerateGatewayProtocol/plugin.swift",
        path.join(pkg, "Plugins/GenerateGatewayProtocol/plugin.swift"),
      );
      writeFileSync(
        path.join(pkg, "Package.swift"),
        `// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "OpenClawKit",
    platforms: [.macOS(.v15)],
    targets: [
        .target(name: "OpenClawProtocol", plugins: ["GenerateGatewayProtocol"]),
        .plugin(name: "GenerateGatewayProtocol", capability: .buildTool()),
    ])
`,
      );
      mkdirSync(path.join(pkg, "Sources/OpenClawProtocol"), { recursive: true });
      writeFileSync(
        path.join(pkg, "Sources/OpenClawProtocol/Consumer.swift"),
        "public let generatorRuntime = generatedBy\n",
      );
      writeExecutable(
        path.join(root, "scripts/prepare-native-protocol.mjs"),
        `import { mkdirSync, writeFileSync } from "node:fs";
const out = process.argv[process.argv.indexOf("--out") + 1];
mkdirSync(out, { recursive: true });
const runtime = JSON.stringify(process.execPath + " " + process.version);
writeFileSync(out + "/GatewayModels.swift", "public let generatedBy = " + runtime + "\\n");
`,
      );
      // An unsupported Node binary comes first and must be skipped.
      writeFileSync(
        path.join(root, "old-node.mjs"),
        'Object.defineProperty(process, "version", { value: "v22.0.0" });\n',
      );
      writeExecutable(
        path.join(root, "old/node"),
        `#!/bin/sh\nexec "${node}" --import "${path.join(root, "old-node.mjs")}" "$@"\n`,
      );
      // Like mise and asdf shims, this one needs the caller's environment to find Node.
      writeExecutable(
        path.join(root, "shims/node"),
        '#!/bin/sh\n[ -n "$FIXTURE_NODE" ] || { echo "No version is set for shim: node" >&2; exit 1; }\nexec "$FIXTURE_NODE" "$@"\n',
      );
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        FIXTURE_NODE: node,
        // The plugin's Node probe must not inherit caller startup flags.
        NODE_OPTIONS: "--input-type=module",
        PATH: [path.join(root, "old"), path.join(root, "shims"), "/usr/bin", "/bin"].join(":"),
      };

      const scratch = path.join(root, "build");
      const result = spawnSync(
        "swift",
        ["build", "--package-path", pkg, "--scratch-path", scratch],
        {
          encoding: "utf8",
          env,
          // spawnSync blocks the worker, so the Vitest deadline cannot stop a stuck build.
          timeout: 150_000,
          killSignal: "SIGKILL",
        },
      );

      expect(result.status, `${result.error ?? ""}\n${result.stdout}\n${result.stderr}`).toBe(0);
      const generated = readdirSync(scratch, { recursive: true, encoding: "utf8" }).find((file) =>
        file.endsWith("GenerateGatewayProtocol/GatewayModels.swift"),
      );
      if (!generated) {
        throw new Error("SwiftPM did not run the Gateway protocol generator");
      }
      expect(readFileSync(path.join(scratch, generated), "utf8")).toBe(
        `public let generatedBy = ${JSON.stringify(`${node} ${process.version}`)}\n`,
      );
    },
  );
});
