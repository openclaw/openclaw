import { Command } from "commander";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { captureEnv } from "../test-utils/env.js";

const loadConfigMock = vi.hoisted(() => vi.fn());
const readConfigFileSnapshotMock = vi.hoisted(() => vi.fn());
const resolveGatewayPortMock = vi.hoisted(() => vi.fn(() => 18789));
const copyToClipboardMock = vi.hoisted(() => vi.fn(async () => false));

const runtimeLogs: string[] = [];
const runtimeErrors: string[] = [];
const runtime = vi.hoisted(() => ({
  log: (message: string) => runtimeLogs.push(message),
  error: (message: string) => runtimeErrors.push(message),
  exit: (code: number) => {
    throw new Error(`__exit__:${code}`);
  },
}));

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    loadConfig: loadConfigMock,
    readConfigFileSnapshot: readConfigFileSnapshotMock,
    resolveGatewayPort: resolveGatewayPortMock,
  };
});

vi.mock("../infra/clipboard.js", () => ({
  copyToClipboard: copyToClipboardMock,
}));

vi.mock("../runtime.js", () => ({
  defaultRuntime: runtime,
}));

const { registerQrCli } = await import("./qr-cli.js");
const { registerMaintenanceCommands } = await import("./program/register.maintenance.js");

function createGatewayTokenRefFixture() {
  return {
    secrets: {
      providers: {
        default: {
          source: "env",
        },
      },
      defaults: {
        env: "default",
      },
    },
    gateway: {
      bind: "custom",
      customBindHost: "gateway.local",
      port: 18789,
      auth: {
        mode: "token",
        token: {
          source: "env",
          provider: "default",
          id: "SHARED_GATEWAY_TOKEN",
        },
      },
    },
  };
}

function decodeSetupCode(setupCode: string): {
  url?: string;
  bootstrapToken?: string;
} {
  const padded = setupCode.replace(/-/g, "+").replace(/_/g, "/");
  const padLength = (4 - (padded.length % 4)) % 4;
  const normalized = padded + "=".repeat(padLength);
  const json = Buffer.from(normalized, "base64").toString("utf8");
  return JSON.parse(json) as {
    url?: string;
    bootstrapToken?: string;
  };
}

async function runCli(args: string[]): Promise<void> {
  const program = new Command();
  registerQrCli(program);
  registerMaintenanceCommands(program);
  await program.parseAsync(args, { from: "user" });
}

describe("cli integration: qr + dashboard token SecretRef", () => {
  let envSnapshot: ReturnType<typeof captureEnv>;

  beforeAll(() => {
    envSnapshot = captureEnv([
      "SHARED_GATEWAY_TOKEN",
      "OPENCLAW_GATEWAY_TOKEN",
      "CLAWDBOT_GATEWAY_TOKEN",
      "OPENCLAW_GATEWAY_PASSWORD",
      "CLAWDBOT_GATEWAY_PASSWORD",
    ]);
  });

  afterAll(() => {
    envSnapshot.restore();
  });

  beforeEach(() => {
    runtimeLogs.length = 0;
    runtimeErrors.length = 0;
    vi.clearAllMocks();
    delete process.env.OPENCLAW_GATEWAY_TOKEN;
    delete process.env.CLAWDBOT_GATEWAY_TOKEN;
    delete process.env.OPENCLAW_GATEWAY_PASSWORD;
    delete process.env.CLAWDBOT_GATEWAY_PASSWORD;
    delete process.env.SHARED_GATEWAY_TOKEN;
  });

  it("uses the same resolved token SecretRef for qr auth validation and dashboard commands", async () => {
    const fixture = createGatewayTokenRefFixture();
    process.env.SHARED_GATEWAY_TOKEN = "shared-token-123";
    loadConfigMock.mockReturnValue(fixture);
    readConfigFileSnapshotMock.mockResolvedValue({
      path: "/tmp/openclaw.json",
      exists: true,
      valid: true,
      issues: [],
      config: fixture,
    });

    await runCli(["qr", "--setup-code-only"]);
    const setupCode = runtimeLogs.at(-1);
    expect(setupCode).toBeTruthy();
    const payload = decodeSetupCode(setupCode ?? "");
    expect(payload.url).toBe("ws://gateway.local:18789");
    expect(payload.bootstrapToken).toBeTruthy();
    expect(runtimeErrors).toEqual([]);

    runtimeLogs.length = 0;
    runtimeErrors.length = 0;
    await runCli(["dashboard", "--no-open"]);
    const joined = runtimeLogs.join("\n");
    expect(joined).toContain("Dashboard URL: http://127.0.0.1:18789/");
    expect(joined).not.toContain("#token=");
    expect(joined).toContain(
      "Token auto-auth is disabled for SecretRef-managed gateway.auth.token",
    );
    expect(joined).not.toContain("Token auto-auth unavailable");
    expect(runtimeErrors).toEqual([]);
  });

  it("fails qr but keeps dashboard actionable when the shared token SecretRef is unresolved", async () => {
    const fixture = createGatewayTokenRefFixture();
    loadConfigMock.mockReturnValue(fixture);
    readConfigFileSnapshotMock.mockResolvedValue({
      path: "/tmp/openclaw.json",
      exists: true,
      valid: true,
      issues: [],
      config: fixture,
    });

    await expect(runCli(["qr", "--setup-code-only"])).rejects.toThrow("__exit__:1");
    expect(runtimeErrors.join("\n")).toMatch(/SHARED_GATEWAY_TOKEN/);

    runtimeLogs.length = 0;
    runtimeErrors.length = 0;
    await runCli(["dashboard", "--no-open"]);
    const joined = runtimeLogs.join("\n");
    expect(joined).toContain("Dashboard URL: http://127.0.0.1:18789/");
    expect(joined).not.toContain("#token=");
    expect(joined).toContain("Token auto-auth unavailable");
    expect(joined).toContain("Set OPENCLAW_GATEWAY_TOKEN");
  });
});
