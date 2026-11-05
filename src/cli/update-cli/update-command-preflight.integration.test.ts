import { once } from "node:events";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { isUpdateAdmissionAuthorityEnvKey } from "../../infra/update-admission-contract.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import { resolveTestNodeExecPath } from "../../test-utils/node-process.js";

it(
  "preflights the built CLI without changing the serving profile or taking its port",
  {
    timeout: 330_000,
  },
  async () => {
    const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "preflight-boundary-")));
    const stateDir = path.join(home, "state");
    const configPath = path.join(stateDir, "openclaw.json");
    const serving = createServer((_request, response) => response.end("serving"));
    try {
      serving.listen(0, "127.0.0.1");
      await once(serving, "listening");
      const address = serving.address();
      if (!address || typeof address === "string") {
        throw new Error("Expected a serving TCP listener");
      }
      await fs.mkdir(stateDir);
      const original = JSON.stringify({ gateway: { mode: "local", port: address.port } });
      await fs.writeFile(configPath, original);
      const env = Object.fromEntries(
        Object.entries(process.env).filter(
          ([key]) =>
            !isUpdateAdmissionAuthorityEnvKey(key) &&
            !key.startsWith("VITEST") &&
            !key.startsWith("OPENCLAW_VITEST") &&
            !key.startsWith("OPENCLAW_TEST_") &&
            key !== "NODE_ENV",
        ),
      );
      Object.assign(env, {
        HOME: home,
        USERPROFILE: home,
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_LOG_LEVEL: "debug",
        NODE_DISABLE_COMPILE_CACHE: "1",
      });
      const invoke = () =>
        runCommandWithTimeout(
          [
            resolveTestNodeExecPath(),
            path.join(process.cwd(), "openclaw.mjs"),
            "update",
            "preflight",
            "--json",
            "--timeout",
            "120",
          ],
          {
            cwd: process.cwd(),
            baseEnv: env,
            timeoutMs: 300_000,
            maxOutputBytes: 256 * 1024,
            killProcessTree: true,
            requireProcessTreeExtinction: true,
          },
        );
      const ready = await invoke();
      expect(ready.code, ready.stderr).toBe(0);
      expect(JSON.parse(ready.stdout)).toMatchObject({
        protocol: 1,
        mode: "preflight",
        status: "ready",
        phase: "readiness",
        coverage: "isolated-core-startup",
      });
      expect(await fs.readFile(configPath, "utf8")).toBe(original);
      expect(await fs.readdir(stateDir)).toEqual(["openclaw.json"]);
      expect(await (await fetch(`http://127.0.0.1:${address.port}`)).text()).toBe("serving");

      // An unreadable configuration must not become an empty, apparently ready profile.
      for (const invalid of ["{ broken", "[]"]) {
        await fs.writeFile(configPath, invalid);
        const blocked = await invoke();
        expect(blocked.code, blocked.stderr).toBe(3);
        expect(JSON.parse(blocked.stdout)).toMatchObject({
          status: "blocked",
          phase: "config",
          reason: "config-source-invalid",
        });
        expect(await fs.readFile(configPath, "utf8")).toBe(invalid);
        expect(await fs.readdir(stateDir)).toEqual(["openclaw.json"]);
        expect(await (await fetch(`http://127.0.0.1:${address.port}`)).text()).toBe("serving");
      }
    } finally {
      await new Promise<void>((resolve, reject) => {
        serving.close((error) => (error ? reject(error) : resolve()));
      });
      await fs.rm(home, { recursive: true, force: true });
    }
  },
);
