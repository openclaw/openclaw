import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { installPackageDir } from "./install-package-dir.js";
import { withTempDir } from "../test/test-utils.js"; // Assuming a common test util exists or we just create our own tmp dir

describe("installPackageDir", () => {
  it("preserves .env files from the previous installation during updates", async () => {
    // Create a temporary directory for our test
    const tmpBase = await fs.mkdtemp(path.join(process.cwd(), ".test-tmp-"));
    const sourceDir = path.join(tmpBase, "source");
    const targetDir = path.join(tmpBase, "target");

    try {
      // 1. Setup existing target with a .env file (simulating user modifying it)
      await fs.mkdir(targetDir, { recursive: true });
      await fs.writeFile(path.join(targetDir, "index.js"), "console.log('old');");
      await fs.writeFile(path.join(targetDir, ".env"), "USER_SECRET=12345\n");

      // 2. Setup incoming update source (which does NOT have the user's .env)
      await fs.mkdir(sourceDir, { recursive: true });
      await fs.writeFile(path.join(sourceDir, "index.js"), "console.log('new');");

      // 3. Run the update block
      const result = await installPackageDir({
        sourceDir,
        targetDir,
        mode: "update",
        timeoutMs: 10000,
        copyErrorPrefix: "test_err",
        hasDeps: false,
        depsLogMessage: "deps",
      });

      expect(result.ok).toBe(true);

      // 4. Verify the new code is there
      const newJs = await fs.readFile(path.join(targetDir, "index.js"), "utf-8");
      expect(newJs).toBe("console.log('new');");

      // 5. Verify the .env file SURVIVED the update
      const envContent = await fs.readFile(path.join(targetDir, ".env"), "utf-8");
      expect(envContent).toBe("USER_SECRET=12345\n");

    } finally {
      // Cleanup
      await fs.rm(tmpBase, { recursive: true, force: true }).catch(() => {});
    }
  });
});
