import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { withEnv } from "./env.js";
import { execNodeEvalSync, resolveTestNodeExecPath } from "./node-process.js";
import { withTempDir } from "./temp-dir.js";

it.skipIf(process.platform === "win32").each(["Bun shim", "unsupported Node"])(
  "skips %s and resolves supported Node from the child environment",
  async (candidate) => {
    await withTempDir("openclaw-node-process-", async (tempDir) => {
      const nodeExecPath = resolveTestNodeExecPath();
      const shimPath = path.join(tempDir, "node");
      await fs.writeFile(
        shimPath,
        candidate === "Bun shim"
          ? "#!/bin/sh\nexit 0\n"
          : `#!${nodeExecPath}\nObject.defineProperty(process.versions, "node", { value: "20.20.2" });\nprocess.argv.splice(1, 1);\nimport(require("node:url").pathToFileURL(process.argv[1]).href);\n`,
        { mode: 0o755 },
      );

      const bunVersionDescriptor = Object.getOwnPropertyDescriptor(process.versions, "bun");
      Object.defineProperty(process.versions, "bun", { value: "test", configurable: true });
      try {
        const resolved = withEnv(
          { PATH: [tempDir, path.dirname(nodeExecPath)].join(path.delimiter) },
          () => resolveTestNodeExecPath(),
        );
        expect(resolved).toBe(nodeExecPath);
        const selectedBin = path.join(tempDir, "selected");
        const selectedProbe = path.join(tempDir, "selected-probe");
        await fs.mkdir(selectedBin);
        await fs.writeFile(
          path.join(selectedBin, "node"),
          `#!${nodeExecPath}\nrequire("node:fs").writeFileSync(${JSON.stringify(selectedProbe)}, "selected");\nrequire("node:child_process").execFileSync(${JSON.stringify(nodeExecPath)}, process.argv.slice(2), { stdio: "inherit" });\n`,
          { mode: 0o755 },
        );
        expect(
          execNodeEvalSync('process.stdout.write("child")', {
            env: { PATH: [tempDir, selectedBin].join(path.delimiter) },
          }),
        ).toBe("child");
        expect(await fs.readFile(selectedProbe, "utf8")).toBe("selected");
      } finally {
        if (bunVersionDescriptor) {
          Object.defineProperty(process.versions, "bun", bunVersionDescriptor);
        } else {
          Reflect.deleteProperty(process.versions, "bun");
        }
      }
    });
  },
);
