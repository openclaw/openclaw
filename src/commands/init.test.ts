import fs from "node:fs/promises";
import path from "node:path";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it, vi } from "vitest";
import { createConfigIO } from "../config/io.js";
import { replaceConfigFile } from "../config/mutate.js";
import { TEAMMATE_SLA } from "../teammate/profile.js";
import { initCommand } from "./init.js";
import { createTestRuntime } from "./test-runtime-config-helpers.js";

describe("initCommand teammate mode", () => {
  it("rejects missing --mode teammate without writing a profile", async () => {
    const runtime = createTestRuntime();
    await initCommand({ json: true }, runtime);
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(String(runtime.log.mock.calls.at(-1)?.[0])).toContain("openclaw init --mode teammate");
  });

  it("rejects unknown backends", async () => {
    const runtime = createTestRuntime();
    await initCommand({ mode: "teammate", backend: "lambda", json: true }, runtime);
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it("writes a worker bind that never execs on the gateway host", async () => {
    await withTempHome(async (home) => {
      const runtime = createTestRuntime();
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(configPath, "{}\n", "utf8");

      const configIO = createConfigIO({
        configPath,
        env: { OPENCLAW_TEST_FAST: "1", OPENCLAW_STATE_DIR: path.join(home, ".openclaw") },
        homedir: () => home,
        logger: { error: vi.fn(), warn: vi.fn() },
      });

      await initCommand(
        { mode: "teammate", json: true },
        runtime,
        {
          setup: async () => {
            await replaceConfigFile({
              nextConfig: {
                agents: { defaults: { workspace: path.join(home, ".openclaw", "workspace") } },
                gateway: { mode: "local" },
              },
              snapshot: (await configIO.readConfigFileSnapshotForWrite()).snapshot,
            });
          },
        },
      );

      const payload = JSON.parse(String(runtime.log.mock.calls.at(-1)?.[0])) as {
        ok: boolean;
        gatewayExec: boolean;
        execHost: string;
        sla: string;
        backend: string;
      };
      expect(payload.ok).toBe(true);
      expect(payload.execHost).toBe("sandbox");
      expect(payload.gatewayExec).toBe(false);
      expect(payload.backend).toBe("docker");
      expect(payload.sla).toBe(TEAMMATE_SLA);

      const raw = JSON.parse(await fs.readFile(configPath, "utf8")) as {
        meta?: { installProfile?: string };
        tools?: { exec?: { host?: string } };
      };
      expect(raw.meta?.installProfile).toBe("teammate");
      expect(raw.tools?.exec?.host).toBe("sandbox");
    });
  });
});
