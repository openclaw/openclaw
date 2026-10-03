import { expect, it, type Mock } from "vitest";
import type { gatherDaemonStatus } from "./status.gather.js";
import { capturePrintedDaemonStatus } from "./status.gather.probes.test-support.js";

type ConfigIssue = { path: string; message: string };

export function registerStatusConfigReadTests(params: {
  gatherStatus: (
    overrides?: Partial<Parameters<typeof gatherDaemonStatus>[0]>,
  ) => ReturnType<typeof gatherDaemonStatus>;
  withStatusConfig: (
    rawConfig: string | undefined,
    run: (configPath: string) => Promise<void>,
    includeServiceEnv?: boolean,
  ) => Promise<void>;
  createConfigIOCalls: Mock;
  loadConfigCalls: Mock;
  setCliConfigIssues: (issues: ConfigIssue[]) => void;
  setCliConfig: (config: Record<string, unknown>) => void;
}): void {
  const { gatherStatus, withStatusConfig, createConfigIOCalls, loadConfigCalls } = params;

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

  it("reports invalid config issues for deep status instead of failing", async () => {
    await withStatusConfig(JSON.stringify({ gateway: { port: "abc" } }), async (configPath) => {
      const issues = [{ path: "gateway.port", message: "Expected number, received string" }];
      params.setCliConfigIssues(issues);

      const status = await gatherStatus({ probe: false, deep: true });

      expect(loadConfigCalls).not.toHaveBeenCalled();
      expect(status.config?.cli).toMatchObject({ path: configPath, valid: false });
      expect(status.config?.cli.issues).toEqual(issues);
      expect(status.gateway?.bindMode).toBe("loopback");
      const output = capturePrintedDaemonStatus(status, { json: false }).errors;
      expect(output).toContain("Expected number, received string");
    });
  });

  it("drops rejected values from an invalid deep config instead of rendering them", async () => {
    await withStatusConfig("{}", async () => {
      params.setCliConfig({ logging: { file: 42 }, gateway: { controlUi: { basePath: 42 } } });
      params.setCliConfigIssues([
        { path: "logging.file", message: "Invalid input: expected string, received number" },
        {
          path: "gateway.controlUi.basePath",
          message: "Invalid input: expected string, received number",
        },
      ]);

      const status = await gatherStatus({ probe: false, deep: true });

      expect(status.logFile).toEqual(expect.any(String));
      expect(status.config?.cli.controlUi).toEqual({});
      const output = capturePrintedDaemonStatus(status, { json: false }).errors;
      expect(output).toContain("gateway.controlUi.basePath");
    });
  });

  it("falls back to the default log file for a non-string fast-path logging.file", async () => {
    await withStatusConfig(JSON.stringify({ logging: { file: 42 } }), async () => {
      const status = await gatherStatus({ probe: false });

      expect(createConfigIOCalls).not.toHaveBeenCalled();
      expect(status.logFile).toEqual(expect.any(String));
    });
  });
}
