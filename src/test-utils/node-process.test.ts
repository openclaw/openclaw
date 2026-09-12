import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { withEnv } from "./env.js";
import { resolveTestNodeExecPath } from "./node-process.js";
import { withTempDir } from "./temp-dir.js";

it.skipIf(process.platform === "win32")(
  "skips a Bun node shim before the real Node executable",
  async () => {
    await withTempDir("openclaw-node-process-", async (tempDir) => {
      const shimPath = path.join(tempDir, "node");
      await fs.writeFile(shimPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });

      const bunVersionDescriptor = Object.getOwnPropertyDescriptor(process.versions, "bun");
      const nodeExecPath = resolveTestNodeExecPath();
      Object.defineProperty(process.versions, "bun", { value: "test", configurable: true });
      try {
        const resolved = withEnv(
          { PATH: [tempDir, path.dirname(nodeExecPath)].join(path.delimiter) },
          () => resolveTestNodeExecPath(),
        );
        expect(resolved).toBe(nodeExecPath);
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
