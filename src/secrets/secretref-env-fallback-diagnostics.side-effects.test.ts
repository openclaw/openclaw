/**
 * Side-effect coverage: routine SecretRef env-fallback diagnostics must not spawn
 * configured exec SecretRef providers without explicit allowExec.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { CORE_HEALTH_CHECKS } from "../flows/doctor-core-checks.js";
import { collectSecretRefEnvFallbackFindings } from "../security/audit-secretref-env-fallback.js";
import { withEnvAsync } from "../test-utils/env.js";
import { collectSecretRefEnvFallbackDiagnostics } from "./secretref-env-fallback-diagnostics.js";

function buildExecGatewayConfig(markerPath: string): OpenClawConfig {
  return {
    gateway: {
      mode: "local",
      auth: {
        mode: "token",
        token: {
          source: "exec",
          provider: "default",
          id: "value",
        },
      },
    },
    secrets: {
      providers: {
        default: {
          source: "exec",
          command: "/bin/sh",
          args: ["-c", `cat >/dev/null; printf executed > ${JSON.stringify(markerPath)}`],
          jsonOnly: false,
          allowInsecurePath: true,
        },
      },
    },
  } satisfies OpenClawConfig;
}

describe("SecretRef env-fallback exec side effects", () => {
  let tmp: string | undefined;

  afterEach(async () => {
    if (tmp) {
      await fs.rm(tmp, { recursive: true, force: true });
      tmp = undefined;
    }
  });

  it("does not spawn exec SecretRef commands from default diagnostics", async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-secretref-fallback-diag-"));
    const markerPath = path.join(tmp, "exec-ran");
    const cfg = buildExecGatewayConfig(markerPath);

    const diagnostics = await collectSecretRefEnvFallbackDiagnostics({
      cfg,
      env: {
        OPENCLAW_GATEWAY_TOKEN: "env-fallback-token",
      } as NodeJS.ProcessEnv,
    });

    expect(diagnostics).toEqual([]);
    await expect(fs.readFile(markerPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not spawn exec SecretRef commands from security audit findings by default", async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-secretref-fallback-audit-"));
    const markerPath = path.join(tmp, "exec-ran");
    const cfg = buildExecGatewayConfig(markerPath);

    const findings = await collectSecretRefEnvFallbackFindings({
      cfg,
      env: {
        OPENCLAW_GATEWAY_TOKEN: "env-fallback-token",
      } as NodeJS.ProcessEnv,
    });

    expect(findings).toEqual([]);
    await expect(fs.readFile(markerPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not spawn exec SecretRef commands from doctor lint by default", async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-secretref-fallback-doctor-"));
    const markerPath = path.join(tmp, "exec-ran");
    const cfg = buildExecGatewayConfig(markerPath);
    const check = CORE_HEALTH_CHECKS.find(
      (entry) => entry.id === "core/doctor/secretref-env-fallback",
    );
    expect(check).toBeDefined();

    const findings = await withEnvAsync(
      { OPENCLAW_GATEWAY_TOKEN: "env-fallback-token" },
      async () =>
        await check?.detect({
          mode: "lint",
          runtime: { log() {}, error() {}, exit() {} },
          cfg,
          cwd: tmp,
        }),
    );

    expect(findings).toEqual([]);
    await expect(fs.readFile(markerPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});
