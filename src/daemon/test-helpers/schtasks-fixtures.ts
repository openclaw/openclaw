import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { vi } from "vitest";
import { resolveConfigPath } from "../../config/config.js";
import type { PortUsage } from "../../infra/ports-types.js";
import type { killProcessTree as killProcessTreeImpl } from "../../process/kill-tree.js";
import type { MockFn } from "../../test-utils/vitest-mock-fn.js";
import { resolveGatewayStateDir } from "../paths.js";
import { resolveTaskScriptPath } from "../schtasks.js";

export const schtasksResponses: Array<{ code: number; stdout: string; stderr: string }> = [];
export const schtasksCalls: string[][] = [];

export const inspectPortUsage: MockFn<(port: number) => Promise<PortUsage>> = vi.fn();
export const killProcessTree: MockFn<typeof killProcessTreeImpl> = vi.fn();

export async function withWindowsEnv(
  prefix: string,
  run: (params: { tmpDir: string; env: Record<string, string> }) => Promise<void>,
) {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const env = {
    USERPROFILE: tmpDir,
    APPDATA: path.join(tmpDir, "AppData", "Roaming"),
    OPENCLAW_PROFILE: "default",
    OPENCLAW_GATEWAY_PORT: "18789",
  };
  try {
    await run({ tmpDir, env });
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

export function resetSchtasksBaseMocks() {
  schtasksResponses.length = 0;
  schtasksCalls.length = 0;
  inspectPortUsage.mockReset();
  killProcessTree.mockReset();
}

export async function writeGatewayScript(
  env: Record<string, string>,
  port = Number(env.OPENCLAW_GATEWAY_PORT || "18789"),
  options: {
    includePortEnv?: boolean;
    includePortFlag?: boolean;
    extraEnv?: Record<string, string>;
  } = {},
) {
  const includePortEnv = options.includePortEnv ?? true;
  const includePortFlag = options.includePortFlag ?? true;
  const scriptPath = resolveTaskScriptPath(env);
  await fs.mkdir(path.dirname(scriptPath), { recursive: true });
  const command = [
    `"C:\\Program Files\\nodejs\\node.exe"`,
    `"C:\\Users\\steipete\\AppData\\Roaming\\npm\\node_modules\\openclaw\\dist\\index.js"`,
    "gateway",
    ...(includePortFlag ? ["--port", String(port)] : []),
  ].join(" ");
  await fs.writeFile(
    scriptPath,
    [
      "@echo off",
      ...Object.entries(options.extraEnv ?? {}).map(([key, value]) => `set "${key}=${value}"`),
      ...(includePortEnv ? [`set "OPENCLAW_GATEWAY_PORT=${port}"`] : []),
      command,
      "",
    ].join("\r\n"),
    "utf8",
  );
}

export async function writeGatewayConfig(env: Record<string, string>, port = 18789) {
  const configPath = resolveConfigPath(env, resolveGatewayStateDir(env));
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(
    configPath,
    JSON.stringify(
      {
        gateway: {
          port,
        },
      },
      null,
      2,
    ),
    "utf8",
  );
  return configPath;
}
