import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import path from "node:path";
import { afterEach, assert, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it.runIf(process.platform === "darwin")(
  "resolves supported Node shims and reports failed probe reasons",
  { timeout: 180_000 },
  () => {
    const root = tempDirs.make("openclaw-protocol-plugin-");
    const node = fs.realpathSync(process.execPath);
    const pkg = path.join(root, "apps/shared/OpenClawKit");
    const write = (file: string, content: string, mode = 0o644) => {
      const target = path.join(root, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content, { mode });
    };
    const copy = (file: string) => write(file, fs.readFileSync(file, "utf8"));
    const shell = (file: string, body: string) => write(file, `#!/bin/sh\n${body}\n`, 0o755);
    copy("node-version.mjs");
    copy("apps/shared/OpenClawKit/Plugins/GenerateGatewayProtocol/plugin.swift");
    write(
      "apps/shared/OpenClawKit/Package.swift",
      `// swift-tools-version: 6.0
import PackageDescription
let package = Package(
    name: "OpenClawKit",
    targets: [
        .target(name: "OpenClawProtocol", plugins: ["GenerateGatewayProtocol"]),
        .plugin(name: "GenerateGatewayProtocol", capability: .buildTool()),
    ])
`,
    );
    write(
      "apps/shared/OpenClawKit/Sources/OpenClawProtocol/Consumer.swift",
      "public let generatorRuntime = generatedBy\n",
    );
    write(
      "scripts/prepare-native-protocol.mjs",
      `import { mkdirSync, writeFileSync } from "node:fs";
const out = process.argv[process.argv.indexOf("--out") + 1];
mkdirSync(out, { recursive: true });
const runtime = JSON.stringify(process.execPath + " " + process.version);
writeFileSync(out + "/GatewayModels.swift", "public let generatedBy = " + runtime + "\\n");
`,
      0o755,
    );
    // Skip unsupported Node and resolve an environment-dependent version-manager shim.
    write("old-node.mjs", 'Object.defineProperty(process, "version", { value: "v22.0.0" });\n');
    shell("old/node", `exec "${node}" --import "${path.join(root, "old-node.mjs")}" "$@"`);
    shell(
      "shims/node",
      '[ -n "$FIXTURE_NODE" ] || { echo "No version is set for shim: node" >&2; exit 1; }\nexec "$FIXTURE_NODE" "$@"',
    );
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      FIXTURE_NODE: node,
      // The plugin's Node probe must not inherit caller startup flags.
      NODE_OPTIONS: "--input-type=module",
      PATH: [path.join(root, "old"), path.join(root, "shims"), "/usr/bin", "/bin"].join(":"),
    };
    const scratch = path.join(root, "build");
    const args = ["build", "--package-path", pkg, "--scratch-path", scratch, "--configuration"];
    const build = (configuration: "debug" | "release") =>
      spawnSync("swift", [...args, configuration], {
        encoding: "utf8",
        env,
        // spawnSync blocks the worker, so the Vitest deadline cannot stop a stuck build.
        timeout: 150_000,
        killSignal: "SIGKILL",
      });
    const result = build("debug");
    expect(result.status, `${result.error ?? ""}\n${result.stdout}\n${result.stderr}`).toBe(0);
    const files = fs.readdirSync(scratch, { recursive: true, encoding: "utf8" });
    const output = files.find((file) =>
      file.endsWith("GenerateGatewayProtocol/GatewayModels.swift"),
    );
    assert(output, "SwiftPM did not run the Gateway protocol generator");
    expect(fs.readFileSync(path.join(scratch, output), "utf8")).toBe(
      `public let generatedBy = ${JSON.stringify(`${node} ${process.version}`)}\n`,
    );
    write("node-version.mjs", 'throw new Error("fixture Node probe import failed");\n');
    // A different configuration replans the build while reusing the compiled plugin.
    const failed = build("release");
    const diagnostic = `${failed.stdout}\n${failed.stderr}`;
    expect(failed.error).toBeUndefined();
    expect(failed.status, diagnostic).not.toBe(0);
    expect(diagnostic).toContain("fixture Node probe import failed");
    expect(diagnostic).toContain(`${path.join(root, "shims/node")} (exited with status 1 after `);
  },
);
