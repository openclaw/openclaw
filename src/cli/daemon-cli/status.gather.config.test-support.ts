import { expect, it } from "vitest";
import type { gatherDaemonStatus } from "./status.gather.js";
import {
  capturePrintedDaemonStatus,
  type GatewayStatusProbeOptions,
} from "./status.gather.probes.test-support.js";

type MockCalls = { mock: { calls: unknown[][] } };

export function registerStatusConfigReadTests(params: {
  gatherStatus: (
    overrides?: Partial<Parameters<typeof gatherDaemonStatus>[0]>,
  ) => ReturnType<typeof gatherDaemonStatus>;
  withStatusConfig: (
    raw: string | undefined,
    run: (path: string) => Promise<void>,
    includeServiceEnv?: boolean,
  ) => Promise<void>;
  createConfigIOCalls: MockCalls;
  readConfigFileSnapshotCalls: MockCalls;
  loadConfigCalls: MockCalls;
  probeInput: () => GatewayStatusProbeOptions;
  setInvalidConfig: (config: Record<string, unknown>) => void;
}) {
  const {
    gatherStatus,
    withStatusConfig,
    createConfigIOCalls,
    readConfigFileSnapshotCalls,
    loadConfigCalls,
    probeInput,
  } = params;
  it("uses the fast config path for plain same-file status reads", async () => {
    await withStatusConfig(
      JSON.stringify({
        gateway: {
          bind: "custom",
          customBindHost: "10.0.0.5",
          controlUi: { enabled: true },
        },
      }),
      async (configPath) => {
        const status = await gatherStatus({ probe: false });

        expect(createConfigIOCalls).not.toHaveBeenCalled();
        expect(readConfigFileSnapshotCalls).not.toHaveBeenCalled();
        expect(loadConfigCalls).not.toHaveBeenCalled();
        expect(status.config?.cli.path).toBe(configPath);
        expect(status.config?.cli.exists).toBe(true);
        expect(status.config?.cli.valid).toBe(true);
        expect(status.config?.cli.controlUi).toEqual({ enabled: true });
        expect(status.config?.daemon).toBe(status.config?.cli);
        expect(status.gateway?.bindMode).toBe("custom");
        expect(status.gateway?.customBindHost).toBe("10.0.0.5");
      },
      true,
    );
  });

  it("uses the fast config path when the config file is missing", async () => {
    await withStatusConfig(
      undefined,
      async (configPath) => {
        const status = await gatherStatus({ probe: false });

        expect(createConfigIOCalls).not.toHaveBeenCalled();
        expect(status.config?.cli).toEqual({
          path: configPath,
          exists: false,
          valid: true,
        });
        expect(status.config?.daemon).toBe(status.config?.cli);
        expect(status.gateway).toMatchObject({
          bindMode: "loopback",
          port: 19001,
        });
      },
      true,
    );
  });

  it("keeps malformed JSON5 on the fast invalid-summary path", async () => {
    await withStatusConfig(
      "{ gateway:",
      async (configPath) => {
        const status = await gatherStatus({ probe: false });

        expect(createConfigIOCalls).not.toHaveBeenCalled();
        expect(status.config?.cli).toMatchObject({
          path: configPath,
          exists: true,
          valid: false,
        });
        expect(status.config?.cli.issues?.[0]?.message).toContain("JSON5 parse failed");
        expect(status.config?.daemon).toBe(status.config?.cli);
      },
      true,
    );
  });

  it.each([
    { mode: "environment", deep: false, full: true, invalidGateway: false },
    { mode: "fast malformed gateway", deep: false, full: false, invalidGateway: true },
  ])(
    "reports service status despite invalid config through the $mode path",
    async ({ deep, full, invalidGateway }) => {
      const cliLoadedConfig = {
        gateway: invalidGateway
          ? {
              bind: "invalid",
              customBindHost: 123,
              auth: { mode: "token", token: "status-token" },
              tls: { enabled: true },
            }
          : { bind: "loopback", auth: { mode: "token", token: "status-token" } },
        agents: { defaults: { retiredSetting: true } },
        logging: { file: 123 },
        ...(full ? { env: {} } : {}),
      };
      await withStatusConfig(JSON.stringify(cliLoadedConfig), async () => {
        params.setInvalidConfig(cliLoadedConfig);

        const status = await gatherStatus({ deep });

        expect(status.service.runtime?.status).toBe("running");
        expect(status.gateway?.port).toBe(19001);
        expect(status.config?.cli.valid).toBe(false);
        expect(probeInput().token).toBe("status-token");
        if (invalidGateway) {
          expect(probeInput().url).toBe("wss://127.0.0.1:19001");
        }
        const output = capturePrintedDaemonStatus(status, { json: false }).errors;
        expect(output).toContain("retiredSetting");
        expect(output).toContain("Warning: Config issue:");
        expect(output).toContain("openclaw doctor --fix");
      });
    },
  );
}
