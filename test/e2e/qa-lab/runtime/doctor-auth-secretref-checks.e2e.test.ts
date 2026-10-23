// QA Lab product proof for doctor gateway auth and SecretRef behavior.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { stripAnsiSequences } from "../../../../packages/terminal-core/src/ansi.js";
import { createConfigIO } from "../../../../src/config/io.js";
import type { OpenClawConfig } from "../../../../src/config/types.openclaw.js";
import { withSecureTestNodeCommand } from "../../../../src/secrets/test-node-command.test-support.js";
import { createOpenClawTestInstance } from "../../../helpers/openclaw-test-instance.js";

type GatewayToken = NonNullable<NonNullable<OpenClawConfig["gateway"]>["auth"]>["token"];
const DOCTOR_CLI_TIMEOUT_MS = 120_000;
const DOCTOR_CLI_CALL_COUNT = 6;
// Entry-point preparation can precede the first CLI timeout; reserve one more
// command budget for instance and config setup across the scenario.
const DOCTOR_SCENARIO_TIMEOUT_MS = DOCTOR_CLI_TIMEOUT_MS * (DOCTOR_CLI_CALL_COUNT + 2);
let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

async function createDoctorFixture() {
  const instance = await createOpenClawTestInstance({
    name: "qa-doctor-auth-secretref",
    reserveIdlePort: false,
  });
  cleanup = () => instance.cleanup();
  async function doctor(...flags: string[]): Promise<string> {
    const result = await instance.cli(
      ["doctor", "--non-interactive", "--no-workspace-suggestions", ...flags],
      { timeoutMs: DOCTOR_CLI_TIMEOUT_MS },
    );
    expect(result.code).toBe(0);
    return `${result.stdout}\n${result.stderr}`;
  }

  function normalized(output: string): string {
    return stripAnsiSequences(output).replaceAll("│", " ").replace(/\s+/g, " ").trim();
  }

  async function readToken() {
    const config: OpenClawConfig = JSON.parse(await fs.readFile(instance.configPath, "utf8"));
    return config.gateway?.auth?.token;
  }

  async function writeConfig(config: OpenClawConfig): Promise<void> {
    const io = createConfigIO({
      env: instance.env,
      configPath: instance.configPath,
      homedir: () => instance.homeDir,
    });
    // Keep Doctor-authored fields so the next scenario is not a config-clobber recovery.
    await io.writeConfigFile({ ...(await io.readSourceConfigBestEffort()), ...config });
  }

  function localGatewayConfig(
    token?: GatewayToken,
    providers?: NonNullable<OpenClawConfig["secrets"]>["providers"],
  ): OpenClawConfig {
    return {
      gateway: {
        mode: "local",
        port: instance.port,
        bind: "loopback",
        auth: { mode: "token", ...(token === undefined ? {} : { token }) },
        controlUi: { enabled: false },
      },
      ...(providers ? { secrets: { providers } } : {}),
    };
  }
  return { instance, doctor, normalized, readToken, writeConfig, localGatewayConfig };
}

// Windows ACL failure diagnostics are owned by focused resolver and Doctor
// tests; this broad process proof owns the platform-neutral product flow.
it.skipIf(process.platform === "win32")(
  "preserves SecretRef ownership while proving resolution, fallback, exec gating, and token generation",
  { timeout: DOCTOR_SCENARIO_TIMEOUT_MS },
  async () => {
    const { instance, doctor, normalized, readToken, writeConfig, localGatewayConfig } =
      await createDoctorFixture();

    const resolvedValue = "qa-resolved-gateway-value";
    instance.env.QA_DOCTOR_GATEWAY_TOKEN = resolvedValue;
    await writeConfig(
      localGatewayConfig({
        source: "env",
        provider: "default",
        id: "QA_DOCTOR_GATEWAY_TOKEN",
      }),
    );
    const resolvedOutput = await doctor();
    expect(resolvedOutput).not.toContain("Gateway token SecretRef could not be resolved");
    expect(resolvedOutput).not.toContain(resolvedValue);

    delete instance.env.QA_DOCTOR_MISSING_GATEWAY_TOKEN;
    instance.env.OPENCLAW_GATEWAY_TOKEN = "qa-ambient-token-must-not-win";
    const unresolvedRef = {
      source: "env" as const,
      provider: "default",
      id: "QA_DOCTOR_MISSING_GATEWAY_TOKEN",
    };
    await writeConfig(localGatewayConfig(unresolvedRef));
    const unresolvedOutput = await doctor("--repair", "--yes", "--generate-gateway-token");
    expect(unresolvedOutput).toContain("Gateway token SecretRef could not be resolved");
    expect(unresolvedOutput).toContain(
      "Doctor will not overwrite gateway.auth.token with a plaintext value.",
    );
    expect(unresolvedOutput).not.toContain("qa-ambient-token-must-not-win");
    expect(await readToken()).toEqual(unresolvedRef);

    const filePath = path.join(instance.stateDir, "doctor-file-secretref.json");
    const fileSecret = "qa-file-token";
    await fs.writeFile(filePath, JSON.stringify({ gateway: { token: fileSecret } }), {
      mode: 0o600,
    });
    await writeConfig(
      localGatewayConfig(
        { source: "file", provider: "filemain", id: "/gateway/token" },
        { filemain: { source: "file", path: filePath } },
      ),
    );
    const fileOutput = normalized(await doctor());
    expect(fileOutput).not.toContain("Gateway token SecretRef could not be resolved");
    expect(fileOutput).not.toContain(fileSecret);

    const execMarker = path.join(instance.stateDir, "doctor-exec-secretref.marker");
    const execScript = [
      "const fs = require('node:fs');",
      `fs.writeFileSync(${JSON.stringify(execMarker)}, 'executed');`,
      "process.stdout.write(JSON.stringify({ protocolVersion: 1, values: { 'gateway/token': 'qa-exec-token' } }));",
    ].join("");
    await withSecureTestNodeCommand(async (command) => {
      await writeConfig(
        localGatewayConfig(
          { source: "exec", provider: "execmain", id: "gateway/token" },
          {
            execmain: {
              source: "exec",
              command,
              args: ["-e", execScript],
              trustedDirs: [path.dirname(command)],
            },
          },
        ),
      );
      expect(normalized(await doctor())).toMatch(
        /Gateway health checks skipped because gateway credentials use an exec(?:\s|│)*SecretRef\./,
      );
      await expect(fs.access(execMarker)).rejects.toThrow();

      const execAllowedOutput = normalized(await doctor("--allow-exec"));
      await expect(fs.readFile(execMarker, "utf8")).resolves.toBe("executed");
      expect(execAllowedOutput).not.toContain("qa-exec-token");
    });

    delete instance.env.OPENCLAW_GATEWAY_TOKEN;
    await writeConfig(localGatewayConfig());
    await doctor("--repair", "--yes", "--generate-gateway-token");
    const token = await readToken();
    expect(typeof token).toBe("string");
    expect(token).toEqual(expect.stringMatching(/^.{21,}$/u));
  },
);
