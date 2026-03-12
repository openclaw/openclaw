import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const buildGatewayInstallPlan = vi.hoisted(() =>
  vi.fn(async () => ({
    programArguments: [],
    workingDirectory: "/tmp",
    environment: {},
  })),
);
const resolveGatewayInstallToken = vi.hoisted(() =>
  vi.fn(async () => ({
    token: undefined,
    tokenRefConfigured: true,
    warnings: [],
  })),
);
const waitForGatewayReachable = vi.hoisted(() => vi.fn(async () => {}));
const probeGateway = vi.hoisted(() =>
  vi.fn(async () => ({
    ok: false,
    close: { code: 1008, reason: "auth required" },
  })),
);
const inspectPortUsage = vi.hoisted(() =>
  vi.fn<
    (port: number) => Promise<{
      port: number;
      status: string;
      listeners: Array<{ pid?: number; ppid?: number; commandLine?: string }>;
      hints: string[];
      errors?: string[];
    }>
  >(async (port: number) => ({
    port,
    status: "busy",
    listeners: [{ pid: 4242, commandLine: "openclaw gateway run" }],
    hints: [],
  })),
);
const callGateway = vi.hoisted(() =>
  vi.fn<(params: { method: string; params?: Record<string, unknown> }) => Promise<unknown>>(
    async (params) => {
      if (params.method === "cron.list") {
        return { jobs: [] };
      }
      if (params.method === "cron.add") {
        return { id: "job-1" };
      }
      throw new Error(`Unexpected gateway method: ${params.method}`);
    },
  ),
);
const gatewayInstall = vi.hoisted(() => vi.fn(async () => {}));
const gatewayRestart = vi.hoisted(() => vi.fn(async () => {}));
const gatewayIsLoaded = vi.hoisted(() => vi.fn(async () => false));
const gatewayReadCommand = vi.hoisted(() =>
  vi.fn<
    () => Promise<{
      programArguments: string[];
      workingDirectory?: string;
      environment?: Record<string, string>;
    } | null>
  >(async () => null),
);
const gatewayReadRuntime = vi.hoisted(() =>
  vi.fn<
    () => Promise<{
      status: string;
      pid?: number;
      detail?: string;
      missingUnit?: boolean;
    }>
  >(async () => ({
    status: "running",
    pid: 4242,
  })),
);

vi.mock("../agents/workspace.js", () => ({
  ensureAgentWorkspace: vi.fn(async ({ dir }: { dir: string }) => ({ dir })),
}));

vi.mock("./daemon-install-helpers.js", () => ({
  buildGatewayInstallPlan,
  gatewayInstallErrorHint: vi.fn(() => "hint"),
}));

vi.mock("./gateway-install-token.js", () => ({
  resolveGatewayInstallToken,
}));

vi.mock("./onboard-helpers.js", () => ({
  randomToken: vi.fn(() => "generated-rescue-token"),
  waitForGatewayReachable,
}));

vi.mock("../gateway/probe.js", () => ({
  probeGateway,
}));

vi.mock("../infra/ports.js", () => ({
  inspectPortUsage,
  classifyPortListener: vi.fn(() => "gateway"),
  formatPortDiagnostics: vi.fn((usage: { port: number }) => [
    `Port ${usage.port} is already in use.`,
  ]),
}));

vi.mock("../gateway/call.js", () => ({
  callGateway,
}));

vi.mock("../daemon/service.js", () => ({
  resolveGatewayService: vi.fn(() => ({
    isLoaded: gatewayIsLoaded,
    install: gatewayInstall,
    restart: gatewayRestart,
    readCommand: gatewayReadCommand,
    readRuntime: gatewayReadRuntime,
  })),
}));

import { saveAuthProfileStore } from "../agents/auth-profiles.js";
import { setupRescueWatchdog } from "./onboard-rescue.js";

describe("setupRescueWatchdog", () => {
  const previousEnv = {
    HOME: process.env.HOME,
    HTTP_PROXY: process.env.HTTP_PROXY,
    OPENCLAW_CONFIG_PATH: process.env.OPENCLAW_CONFIG_PATH,
    OPENCLAW_GATEWAY_PORT: process.env.OPENCLAW_GATEWAY_PORT,
    OPENCLAW_PROFILE: process.env.OPENCLAW_PROFILE,
    OPENCLAW_STATE_DIR: process.env.OPENCLAW_STATE_DIR,
    OPENCLAW_TEST_FAST: process.env.OPENCLAW_TEST_FAST,
  };

  let tempHome = "";

  beforeEach(async () => {
    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-rescue-"));
    buildGatewayInstallPlan.mockClear();
    resolveGatewayInstallToken.mockClear();
    waitForGatewayReachable.mockClear();
    probeGateway.mockClear();
    inspectPortUsage.mockReset();
    inspectPortUsage.mockImplementation(async (port: number) => ({
      port,
      status: "busy",
      listeners: [{ pid: 4242, commandLine: "openclaw gateway run" }],
      hints: [],
    }));
    callGateway.mockReset();
    callGateway.mockImplementation(async (params: { method: string }) => {
      if (params.method === "cron.list") {
        return { jobs: [] };
      }
      if (params.method === "cron.add") {
        return { id: "job-1" };
      }
      throw new Error(`Unexpected gateway method: ${params.method}`);
    });
    gatewayInstall.mockClear();
    gatewayRestart.mockClear();
    gatewayIsLoaded.mockReset();
    gatewayReadCommand.mockReset();
    gatewayReadRuntime.mockReset();
    gatewayIsLoaded.mockResolvedValue(false);
    gatewayReadCommand.mockResolvedValue(null);
    gatewayReadRuntime.mockResolvedValue({
      status: "running",
      pid: 4242,
    });
  });

  afterEach(async () => {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    if (tempHome) {
      await fs.rm(tempHome, { recursive: true, force: true });
    }
  });

  it("uses an isolated rescue state dir and preserves rescue-only auth profiles", async () => {
    const mainStateDir = path.join(tempHome, ".openclaw-work");
    const mainConfigPath = path.join(mainStateDir, "openclaw.json");
    const mainAgentDir = path.join(mainStateDir, "agents", "main", "agent");
    const rescueStateDir = path.join(tempHome, ".openclaw-work-rescue");
    const rescueConfigPath = path.join(rescueStateDir, "openclaw.json");
    const rescueAgentDir = path.join(rescueStateDir, "agents", "main", "agent");
    const mainWorkspace = path.join(tempHome, "workspace-work");

    process.env.HOME = tempHome;
    process.env.HTTP_PROXY = "http://proxy.internal:8080";
    process.env.OPENCLAW_TEST_FAST = "1";
    process.env.OPENCLAW_PROFILE = "work";
    process.env.OPENCLAW_STATE_DIR = mainStateDir;
    process.env.OPENCLAW_CONFIG_PATH = mainConfigPath;
    process.env.OPENCLAW_GATEWAY_PORT = "18789";

    await fs.mkdir(mainAgentDir, { recursive: true });
    await fs.mkdir(rescueAgentDir, { recursive: true });
    await fs.mkdir(mainStateDir, { recursive: true });
    await fs.writeFile(mainConfigPath, JSON.stringify({ wizard: { marker: "main" } }), "utf8");

    saveAuthProfileStore(
      {
        version: 1,
        profiles: {
          "main-key": {
            type: "api_key",
            provider: "openai",
            key: "main-secret", // pragma: allowlist secret
          },
        },
      },
      mainAgentDir,
    );
    saveAuthProfileStore(
      {
        version: 1,
        profiles: {
          "rescue-only": {
            type: "api_key",
            provider: "openai",
            key: "rescue-secret", // pragma: allowlist secret
          },
        },
      },
      rescueAgentDir,
    );

    const result = await setupRescueWatchdog({
      sourceConfig: {
        tools: { profile: "coding" },
      },
      workspaceDir: mainWorkspace,
      mainPort: 18_789,
      monitoredProfile: "work",
      runtime: "node",
      output: {
        log: vi.fn(),
      },
    });

    expect(result.rescueProfile).toBe("work-rescue");
    expect(result.rescuePort).toBeGreaterThanOrEqual(1024);
    expect(result.rescuePort).toBeLessThanOrEqual(65_535);
    expect(buildGatewayInstallPlan).toHaveBeenCalledWith(
      expect.objectContaining({
        env: expect.objectContaining({
          OPENCLAW_PROFILE: "work-rescue",
          OPENCLAW_STATE_DIR: rescueStateDir,
          OPENCLAW_CONFIG_PATH: rescueConfigPath,
          HOME: tempHome,
        }),
        port: result.rescuePort,
      }),
    );
    const rescuePlanCall = (buildGatewayInstallPlan.mock.calls as unknown[][]).at(0);
    const gatewayInstallCall = (gatewayInstall.mock.calls as unknown[][]).at(0);
    const rescuePlanArgs = rescuePlanCall?.[0] as
      | { env?: Record<string, string | undefined> }
      | undefined;
    const gatewayInstallArgs = gatewayInstallCall?.[0] as
      | { env?: Record<string, string | undefined> }
      | undefined;
    expect(rescuePlanArgs?.env).not.toHaveProperty("HTTP_PROXY");
    expect(gatewayInstallArgs?.env).not.toHaveProperty("HTTP_PROXY");

    const mainConfig = JSON.parse(await fs.readFile(mainConfigPath, "utf8")) as {
      wizard?: { marker?: string };
    };
    expect(mainConfig.wizard?.marker).toBe("main");

    const rescueConfig = JSON.parse(await fs.readFile(rescueConfigPath, "utf8")) as {
      agents?: { list?: Array<{ id?: string; tools?: { allow?: string[] } }> };
      gateway?: { port?: number };
      wizard?: {
        rescueWatchdog?: { managed?: boolean; monitoredProfile?: string; agentId?: string };
      };
    };
    expect(rescueConfig.gateway?.port).toBe(result.rescuePort);
    expect(rescueConfig.wizard?.rescueWatchdog).toEqual({
      managed: true,
      monitoredProfile: "work",
      agentId: "rescue-watchdog",
    });
    expect(rescueConfig.agents?.list).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "rescue-watchdog",
          tools: expect.objectContaining({
            allow: [],
            deny: ["*"],
          }),
        }),
      ]),
    );

    const rescueStore = JSON.parse(
      await fs.readFile(path.join(rescueAgentDir, "auth-profiles.json"), "utf8"),
    ) as {
      profiles: Record<string, unknown>;
    };
    expect(rescueStore.profiles).toHaveProperty("main-key");
    expect(rescueStore.profiles).toHaveProperty("rescue-only");
    expect(callGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "cron.add",
        params: expect.objectContaining({
          agentId: "rescue-watchdog",
          payload: expect.objectContaining({
            kind: "rescueWatchdog",
            monitoredProfile: "work",
          }),
        }),
      }),
    );
  });

  it("refreshes stale rescue auth entries from the primary profile on rerun", async () => {
    const mainStateDir = path.join(tempHome, ".openclaw-work");
    const mainConfigPath = path.join(mainStateDir, "openclaw.json");
    const mainAgentDir = path.join(mainStateDir, "agents", "main", "agent");
    const rescueStateDir = path.join(tempHome, ".openclaw-work-rescue");
    const rescueAgentDir = path.join(rescueStateDir, "agents", "main", "agent");

    process.env.HOME = tempHome;
    process.env.OPENCLAW_TEST_FAST = "1";
    process.env.OPENCLAW_PROFILE = "work";
    process.env.OPENCLAW_STATE_DIR = mainStateDir;
    process.env.OPENCLAW_CONFIG_PATH = mainConfigPath;
    process.env.OPENCLAW_GATEWAY_PORT = "18789";

    await fs.mkdir(mainAgentDir, { recursive: true });
    await fs.mkdir(rescueAgentDir, { recursive: true });
    await fs.mkdir(mainStateDir, { recursive: true });
    await fs.writeFile(mainConfigPath, JSON.stringify({ wizard: { marker: "main" } }), "utf8");

    saveAuthProfileStore(
      {
        version: 1,
        profiles: {
          "shared-key": {
            type: "api_key",
            provider: "openai",
            key: "rotated-main-secret", // pragma: allowlist secret
          },
        },
      },
      mainAgentDir,
    );
    saveAuthProfileStore(
      {
        version: 1,
        profiles: {
          "shared-key": {
            type: "api_key",
            provider: "openai",
            key: "stale-rescue-secret", // pragma: allowlist secret
          },
          "rescue-only": {
            type: "api_key",
            provider: "openai",
            key: "rescue-secret", // pragma: allowlist secret
          },
        },
      },
      rescueAgentDir,
    );

    await setupRescueWatchdog({
      sourceConfig: {
        tools: { profile: "coding" },
      },
      workspaceDir: path.join(tempHome, "workspace-work"),
      mainPort: 18_789,
      monitoredProfile: "work",
      runtime: "node",
      output: {
        log: vi.fn(),
      },
    });

    const rescueStore = JSON.parse(
      await fs.readFile(path.join(rescueAgentDir, "auth-profiles.json"), "utf8"),
    ) as {
      profiles: Record<string, { key?: string }>;
    };
    expect(rescueStore.profiles["shared-key"]?.key).toBe("rotated-main-secret");
    expect(rescueStore.profiles["rescue-only"]?.key).toBe("rescue-secret");
  });

  it("accepts a healthy rescue gateway when runtime metadata is unavailable", async () => {
    process.env.HOME = tempHome;
    process.env.OPENCLAW_TEST_FAST = "1";
    process.env.OPENCLAW_PROFILE = "work";

    gatewayReadRuntime.mockResolvedValue({
      status: "unknown",
    });
    inspectPortUsage.mockResolvedValue({
      port: 19_789,
      status: "unknown",
      listeners: [],
      hints: [],
      errors: [],
    });

    await expect(
      setupRescueWatchdog({
        sourceConfig: {
          tools: { profile: "coding" },
        },
        workspaceDir: path.join(tempHome, "workspace-work"),
        mainPort: 18_789,
        monitoredProfile: "work",
        runtime: "node",
        output: {
          log: vi.fn(),
        },
      }),
    ).resolves.toMatchObject({
      enabled: true,
      monitoredProfile: "work",
    });
  });

  it("reinstalls the rescue service when the installed command drifts", async () => {
    process.env.HOME = tempHome;
    process.env.OPENCLAW_TEST_FAST = "1";
    process.env.OPENCLAW_PROFILE = "work";

    gatewayIsLoaded.mockResolvedValue(true);
    gatewayReadCommand.mockResolvedValue({
      programArguments: ["openclaw", "gateway", "run", "--port", "18789"],
      workingDirectory: "/tmp/old",
      environment: {},
    });

    await setupRescueWatchdog({
      sourceConfig: {
        tools: { profile: "coding" },
      },
      workspaceDir: path.join(tempHome, "workspace-work"),
      mainPort: 18_789,
      monitoredProfile: "work",
      runtime: "node",
      output: {
        log: vi.fn(),
      },
    });

    expect(gatewayInstall).toHaveBeenCalledTimes(1);
    expect(gatewayRestart).not.toHaveBeenCalled();
  });

  it("pages cron.list before deciding to create the rescue watchdog job", async () => {
    process.env.HOME = tempHome;
    process.env.OPENCLAW_TEST_FAST = "1";
    process.env.OPENCLAW_PROFILE = "work";

    const jobName = "Rescue watchdog (work)";
    callGateway.mockImplementation(
      async (params: { method: string; params?: { offset?: number } }) => {
        if (params.method === "cron.list") {
          const offset = params.params?.offset ?? 0;
          if (offset === 0) {
            return {
              jobs: [{ id: "other-job", name: "Some other job" }],
              hasMore: true,
              nextOffset: 100,
            };
          }
          return {
            jobs: [
              {
                id: "existing-watchdog",
                name: jobName,
                payload: { kind: "rescueWatchdog", monitoredProfile: "work" },
              },
            ],
            hasMore: false,
            nextOffset: null,
          };
        }
        if (params.method === "cron.update") {
          return { ok: true };
        }
        if (params.method === "cron.add") {
          return { id: "unexpected-create" };
        }
        throw new Error(`Unexpected gateway method: ${params.method}`);
      },
    );

    const result = await setupRescueWatchdog({
      sourceConfig: {
        tools: { profile: "coding" },
      },
      workspaceDir: path.join(tempHome, "workspace-work"),
      mainPort: 18_789,
      monitoredProfile: "work",
      runtime: "node",
      output: {
        log: vi.fn(),
      },
    });

    expect(result.cronAction).toBe("updated");
    expect(result.cronJobId).toBe("existing-watchdog");
    expect(callGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "cron.list",
        params: expect.objectContaining({
          offset: 0,
          limit: 100,
        }),
      }),
    );
    expect(callGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "cron.list",
        params: expect.objectContaining({
          offset: 100,
          limit: 100,
        }),
      }),
    );
    expect(callGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "cron.update",
        params: expect.objectContaining({
          id: "existing-watchdog",
        }),
      }),
    );
    expect(callGateway).not.toHaveBeenCalledWith(
      expect.objectContaining({
        method: "cron.add",
      }),
    );
  });

  it("keeps paging when a same-name non-managed cron job appears before the managed watchdog", async () => {
    process.env.HOME = tempHome;
    process.env.OPENCLAW_TEST_FAST = "1";
    process.env.OPENCLAW_PROFILE = "work";

    const jobName = "Rescue watchdog (work)";
    callGateway.mockImplementation(
      async (params: { method: string; params?: { offset?: number } }) => {
        if (params.method === "cron.list") {
          const offset = params.params?.offset ?? 0;
          if (offset === 0) {
            return {
              jobs: [
                {
                  id: "user-job",
                  name: jobName,
                  payload: { kind: "note", monitoredProfile: "work" },
                },
              ],
              hasMore: true,
              nextOffset: 100,
            };
          }
          return {
            jobs: [
              {
                id: "managed-watchdog",
                name: jobName,
                payload: { kind: "rescueWatchdog", monitoredProfile: "work" },
              },
            ],
            hasMore: false,
            nextOffset: null,
          };
        }
        if (params.method === "cron.update") {
          return { ok: true };
        }
        if (params.method === "cron.add") {
          return { id: "unexpected-create" };
        }
        throw new Error(`Unexpected gateway method: ${params.method}`);
      },
    );

    const result = await setupRescueWatchdog({
      sourceConfig: {
        tools: { profile: "coding" },
      },
      workspaceDir: path.join(tempHome, "workspace-work"),
      mainPort: 18_789,
      monitoredProfile: "work",
      runtime: "node",
      output: {
        log: vi.fn(),
      },
    });

    expect(result.cronAction).toBe("updated");
    expect(result.cronJobId).toBe("managed-watchdog");
    expect(callGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "cron.update",
        params: expect.objectContaining({
          id: "managed-watchdog",
        }),
      }),
    );
    expect(callGateway).not.toHaveBeenCalledWith(
      expect.objectContaining({
        method: "cron.add",
      }),
    );
  });

  it("refuses to clobber an existing non-watchdog rescue profile", async () => {
    const mainStateDir = path.join(tempHome, ".openclaw-work");
    const mainConfigPath = path.join(mainStateDir, "openclaw.json");
    const rescueStateDir = path.join(tempHome, ".openclaw-work-rescue");
    const rescueConfigPath = path.join(rescueStateDir, "openclaw.json");

    process.env.HOME = tempHome;
    process.env.OPENCLAW_TEST_FAST = "1";
    process.env.OPENCLAW_PROFILE = "work";
    process.env.OPENCLAW_STATE_DIR = mainStateDir;
    process.env.OPENCLAW_CONFIG_PATH = mainConfigPath;
    process.env.OPENCLAW_GATEWAY_PORT = "18789";

    await fs.mkdir(mainStateDir, { recursive: true });
    await fs.mkdir(rescueStateDir, { recursive: true });
    await fs.writeFile(mainConfigPath, JSON.stringify({ wizard: { marker: "main" } }), "utf8");
    await fs.writeFile(
      rescueConfigPath,
      JSON.stringify({
        tools: { profile: "coding" },
      }),
      "utf8",
    );

    await expect(
      setupRescueWatchdog({
        sourceConfig: {
          tools: { profile: "coding" },
        },
        workspaceDir: path.join(tempHome, "workspace-work"),
        mainPort: 18_789,
        monitoredProfile: "work",
        runtime: "node",
        output: {
          log: vi.fn(),
        },
      }),
    ).rejects.toThrow('Rescue watchdog refused to overwrite the existing "work-rescue" profile.');

    expect(gatewayInstall).not.toHaveBeenCalled();
    expect(gatewayRestart).not.toHaveBeenCalled();
  });

  it("fails closed when an existing rescue config cannot be loaded", async () => {
    const mainStateDir = path.join(tempHome, ".openclaw-work");
    const mainConfigPath = path.join(mainStateDir, "openclaw.json");
    const rescueStateDir = path.join(tempHome, ".openclaw-work-rescue");
    const rescueConfigPath = path.join(rescueStateDir, "openclaw.json");

    process.env.HOME = tempHome;
    process.env.OPENCLAW_TEST_FAST = "1";
    process.env.OPENCLAW_PROFILE = "work";
    process.env.OPENCLAW_STATE_DIR = mainStateDir;
    process.env.OPENCLAW_CONFIG_PATH = mainConfigPath;
    process.env.OPENCLAW_GATEWAY_PORT = "18789";

    await fs.mkdir(mainStateDir, { recursive: true });
    await fs.mkdir(rescueStateDir, { recursive: true });
    await fs.writeFile(mainConfigPath, JSON.stringify({ wizard: { marker: "main" } }), "utf8");
    await fs.writeFile(rescueConfigPath, "{ invalid json", "utf8");

    await expect(
      setupRescueWatchdog({
        sourceConfig: {
          tools: { profile: "coding" },
        },
        workspaceDir: path.join(tempHome, "workspace-work"),
        mainPort: 18_789,
        monitoredProfile: "work",
        runtime: "node",
        output: {
          log: vi.fn(),
        },
      }),
    ).rejects.toThrow(
      `Rescue watchdog setup failed: existing rescue profile config at "${rescueConfigPath}" could not be loaded:`,
    );

    expect(gatewayInstall).not.toHaveBeenCalled();
    expect(gatewayRestart).not.toHaveBeenCalled();
  });
});
