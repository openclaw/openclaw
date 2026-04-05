import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createExecTool } from "../src/agents/bash-tools.exec.js";
import { captureFullEnv } from "../src/test-utils/env.js";
import { spawnGatewayInstance, stopGatewayInstance } from "./helpers/gateway-e2e-harness.js";

const E2E_TIMEOUT_MS = 120_000;

function normalizeText(value?: string): string {
  return String(value ?? "")
    .replace(/\r\n/g, "\n")
    .trim();
}

describe("exec service runtime env e2e", () => {
  it(
    "strips leaked gateway service markers before running OpenClaw CLI commands",
    { timeout: E2E_TIMEOUT_MS },
    async () => {
      if (process.platform === "win32") {
        return;
      }

      const envSnapshot = captureFullEnv();
      const gateway = await spawnGatewayInstance("exec-service-runtime-env");

      try {
        const rawConfig = await fs.readFile(gateway.configPath, "utf8");
        const config = JSON.parse(rawConfig) as {
          gateway?: { auth?: { token?: string } };
        };
        if (!config.gateway?.auth) {
          throw new Error("missing gateway auth config in e2e fixture");
        }

        // Keep the running gateway on its original token while making the on-disk
        // config stale. This reproduces the exact precedence hazard caused by
        // leaked OPENCLAW_SERVICE_KIND=gateway in exec children.
        config.gateway.auth.token = "stale-config-token";
        await fs.writeFile(gateway.configPath, JSON.stringify(config, null, 2), "utf8");

        process.env.HOME = gateway.homeDir;
        process.env.USERPROFILE = gateway.homeDir;
        process.env.OPENCLAW_CONFIG_PATH = gateway.configPath;
        process.env.OPENCLAW_STATE_DIR = gateway.stateDir;
        process.env.OPENCLAW_GATEWAY_PORT = String(gateway.port);
        process.env.OPENCLAW_GATEWAY_TOKEN = gateway.gatewayToken;
        process.env.OPENCLAW_TEST_FAST = "1";
        process.env.OPENCLAW_SKIP_CHANNELS = "1";
        process.env.OPENCLAW_SKIP_PROVIDERS = "1";
        process.env.OPENCLAW_SKIP_GMAIL_WATCHER = "1";
        process.env.OPENCLAW_SKIP_BROWSER_CONTROL_SERVER = "1";
        process.env.OPENCLAW_SKIP_CANVAS_HOST = "1";
        process.env.OPENCLAW_SERVICE_MARKER = "openclaw";
        process.env.OPENCLAW_SERVICE_KIND = "gateway";
        process.env.OPENCLAW_SERVICE_VERSION = "2026.3.13";
        process.env.OPENCLAW_SYSTEMD_UNIT = "openclaw-gateway.service";
        process.env.OPENCLAW_LAUNCHD_LABEL = "ai.openclaw.gateway";
        process.env.OPENCLAW_WINDOWS_TASK_NAME = "OpenClaw Gateway";

        const entry = path.resolve(process.cwd(), "openclaw.mjs");
        const directCli = spawnSync(process.execPath, [entry, "cron", "list"], {
          cwd: process.cwd(),
          env: { ...process.env },
          encoding: "utf8",
          timeout: 30_000,
        });

        expect(directCli.status).toBe(1);
        expect(normalizeText(directCli.stdout)).toBe("");
        expect(directCli.stderr).toContain("gateway token mismatch");

        const execTool = createExecTool({ host: "gateway", security: "full", ask: "off" });
        const result = await execTool.execute("call-exec-service-runtime-env", {
          command: `${JSON.stringify(process.execPath)} ${JSON.stringify(entry)} cron list`,
        });
        const text = normalizeText(result.content.find((part) => part.type === "text")?.text);

        expect(result.details).toMatchObject({
          status: "completed",
          exitCode: 0,
        });
        expect(text.length).toBeGreaterThan(0);
        expect(text).not.toContain("gateway token mismatch");
      } finally {
        envSnapshot.restore();
        await stopGatewayInstance(gateway);
      }
    },
  );
});
