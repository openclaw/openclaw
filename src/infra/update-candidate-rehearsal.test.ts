import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { exitCodeFromFindings, runDoctorLintChecks } from "../flows/doctor-lint-flow.js";
import type { HealthCheck } from "../flows/health-checks.js";
import { loadBundledPluginFacade } from "../test-utils/bundled-plugin-public-surface.js";
import { prepareUpdateCandidateRehearsal } from "./update-candidate-rehearsal.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const { registerPolicyDoctorChecks } = await loadBundledPluginFacade<{
  registerPolicyDoctorChecks: (host: { registerHealthCheck: (check: HealthCheck) => void }) => void;
}>({ pluginId: "policy", artifactBasename: "api.ts" });

it.each(["token", "password"] as const)(
  "preserves policy rate limits while isolating %s authentication",
  async (mode) => {
    const root = tempDirs.make("candidate-policy-");
    const policyPath = path.join(root, "policy.jsonc");
    await fs.writeFile(
      policyPath,
      JSON.stringify({ gateway: { auth: { requireAuth: true, requireExplicitRateLimit: true } } }),
    );
    const config: OpenClawConfig = {
      plugins: { entries: { policy: { enabled: true, config: { path: policyPath } } } },
      gateway: {
        bind: "lan",
        port: 18789,
        auth: {
          mode,
          token: "synthetic-serving-token",
          password: { source: "env", provider: "default", id: "SYNTHETIC_SERVING_PASSWORD" },
          allowTailscale: true,
          rateLimit: { maxAttempts: 5, windowMs: 30_000, lockoutMs: 60_000, exemptLoopback: false },
          identityScopes: { "operator@example.invalid": ["operator.read"] },
          trustedProxy: {
            userHeader: "x-forwarded-user",
            allowUsers: ["operator@example.invalid"],
          },
        },
        trustedProxies: ["192.0.2.1"],
      },
    };
    const original = structuredClone(config);
    const checks: HealthCheck[] = [];
    registerPolicyDoctorChecks({ registerHealthCheck: (check) => checks.push(check) });
    const lint = (cfg: OpenClawConfig, configPath: string) =>
      runDoctorLintChecks(
        { mode: "lint", cfg, configPath, cwd: root, runtime: { log() {}, error() {}, exit() {} } },
        { checks },
      );
    expect((await lint(config, path.join(root, "openclaw.json"))).findings).toEqual([]);

    const rehearsal = await prepareUpdateCandidateRehearsal({
      config,
      stateDir: path.join(root, "source"),
      candidateRoot: root,
      env: {
        OPENCLAW_GATEWAY_TOKEN: "synthetic-environment-token",
        OPENCLAW_GATEWAY_PASSWORD: "synthetic-environment-password",
      },
    });
    try {
      const copied: OpenClawConfig = JSON.parse(await fs.readFile(rehearsal.configPath, "utf8"));
      const result = await lint(copied, rehearsal.configPath);
      expect(result.findings).toEqual([]);
      expect(exitCodeFromFindings(result.findings)).toBe(0);
      expect(copied.gateway).toMatchObject({
        bind: "loopback",
        port: rehearsal.port,
        trustedProxies: config.gateway?.trustedProxies,
        auth: {
          mode: "token",
          rateLimit: config.gateway?.auth?.rateLimit,
          identityScopes: config.gateway?.auth?.identityScopes,
          trustedProxy: config.gateway?.auth?.trustedProxy,
          allowTailscale: false,
        },
      });
      expect(copied.gateway?.auth?.token).toEqual(expect.any(String));
      expect(copied.gateway?.auth?.token).not.toBe(config.gateway?.auth?.token);
      expect(copied.gateway?.auth?.password).toBeUndefined();
      expect(rehearsal.env.OPENCLAW_GATEWAY_TOKEN).toBeUndefined();
      expect(rehearsal.env.OPENCLAW_GATEWAY_PASSWORD).toBeUndefined();
      expect(config).toEqual(original);
    } finally {
      await rehearsal.cleanup();
    }
  },
);
