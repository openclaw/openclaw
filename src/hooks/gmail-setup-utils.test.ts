import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
});

describe("resolvePythonExecutablePath", () => {
  it("resolves a working python path and caches the result", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "clawdis-python-"));
    const originalPath = process.env.PATH;
    try {
      const realPython = path.join(tmp, "python-real");
      await fs.writeFile(realPython, "#!/bin/sh\nexit 0\n", "utf-8");
      await fs.chmod(realPython, 0o755);

      const shimDir = path.join(tmp, "shims");
      await fs.mkdir(shimDir, { recursive: true });
      const shim = path.join(shimDir, "python3");
      await fs.writeFile(
        shim,
        `#!/bin/sh\nif [ \"$1\" = \"-c\" ]; then\n  echo \"${realPython}\"\n  exit 0\nfi\nexit 1\n`,
        "utf-8",
      );
      await fs.chmod(shim, 0o755);

      process.env.PATH = `${shimDir}${path.delimiter}/usr/bin`;

      const { resolvePythonExecutablePath } = await import(
        "./gmail-setup-utils.js"
      );

      const resolved = await resolvePythonExecutablePath();
      expect(resolved).toBe(realPython);

      process.env.PATH = "/bin";
      const cached = await resolvePythonExecutablePath();
      expect(cached).toBe(realPython);
    } finally {
      process.env.PATH = originalPath;
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});
