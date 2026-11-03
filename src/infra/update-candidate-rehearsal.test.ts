import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { validateConfigObject } from "../config/validation.js";
import { exitCodeFromFindings, runDoctorLintChecks } from "../flows/doctor-lint-flow.js";
import type { HealthCheck } from "../flows/health-checks.js";
import { loadBundledPluginFacade } from "../test-utils/bundled-plugin-public-surface.js";
import { prepareUpdateCandidateRehearsal } from "./update-candidate-rehearsal.js";
import { materializeUpdateCandidateStateWorker } from "./update-candidate-state.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const { registerPolicyDoctorChecks } = await loadBundledPluginFacade<{
  registerPolicyDoctorChecks: (host: { registerHealthCheck: (check: HealthCheck) => void }) => void;
}>({ pluginId: "policy", artifactBasename: "api.ts" });

it.each(["token", "password"] as const)(
  "preserves attested config and policy for %s authentication",
  async (mode) => {
    const root = tempDirs.make("candidate-policy-");
    await materializeUpdateCandidateStateWorker(root);
    const policyPath = path.join(root, "policy.jsonc");
    await fs.writeFile(
      policyPath,
      JSON.stringify({
        gateway: { auth: { requireAuth: true, requireExplicitRateLimit: true } },
        dataHandling: { sensitiveLogging: { requireRedaction: true } },
        secrets: { allowInsecureProviders: true },
      }),
    );
    const config: OpenClawConfig = {
      plugins: {
        entries: {
          policy: {
            enabled: true,
            config: {
              path: policyPath,
              expectedAttestationHash:
                mode === "token"
                  ? "sha256:4fdc3e88ded7ecdfcdec09f8b30be01337df919cf9e51211e92a7a4d664ae545"
                  : "sha256:ede6e4f088dd6d2177dc3e8bbafcc80388a051381fc75301f01d42fef9d42218",
            },
          },
        },
      },
      diagnostics: {
        enabled: true,
        otel: {
          enabled: true,
          captureContent: true,
          headers: { Authorization: "synthetic-otel-secret", "X-Reference": "${OTEL_SECRET}" },
        },
      },
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
        ...process.env,
        OPENCLAW_GATEWAY_TOKEN: "synthetic-environment-token",
        OPENCLAW_GATEWAY_PASSWORD: "synthetic-environment-password",
      },
    });
    try {
      const copied: OpenClawConfig = JSON.parse(await fs.readFile(rehearsal.configPath, "utf8"));
      const result = await lint(copied, rehearsal.configPath);
      expect(result.findings).toEqual([]);
      expect(exitCodeFromFindings(result.findings)).toBe(0);
      expect(copied.gateway).toEqual({
        ...config.gateway,
        auth: { ...config.gateway?.auth, token: expect.any(String) },
      });
      expect(copied.gateway?.auth?.token).not.toBe(config.gateway?.auth?.token);
      expect(copied.diagnostics).toEqual({
        ...config.diagnostics,
        otel: {
          ...config.diagnostics?.otel,
          headers: { Authorization: expect.any(String), "X-Reference": "${OTEL_SECRET}" },
        },
      });
      expect(copied.diagnostics?.otel?.headers?.Authorization).not.toBe("synthetic-otel-secret");
      expect(rehearsal.env.OPENCLAW_GATEWAY_TOKEN).toBeUndefined();
      expect(rehearsal.env.OPENCLAW_GATEWAY_PASSWORD).toBeUndefined();
      expect(config).toEqual(original);
      const refused = new Error("cleanup authority retired");
      await expect(
        rehearsal.cleanup(() => {
          throw refused;
        }),
      ).rejects.toBe(refused);
      expect(await fs.readFile(rehearsal.configPath, "utf8")).toBeTruthy();
    } finally {
      const checked: string[] = [];
      await rehearsal.cleanup((directory) => {
        checked.push(directory);
      });
      expect(checked).toEqual([rehearsal.stateDir, ...rehearsal.cleanupDirectories]);
    }
  },
);

it("keeps workspace-confined avatars as valid as the serving config", async () => {
  const root = tempDirs.make("candidate-avatar-");
  await materializeUpdateCandidateStateWorker(root);
  const workspace = (id: string) => path.join(root, "workspaces", id);
  const config: OpenClawConfig = {
    agents: {
      ownership: "explicit",
      entries: {
        main: { workspace: workspace("main"), identity: { avatar: `${workspace("main")}/a.png` } },
        relative: { workspace: workspace("relative"), identity: { avatar: "avatars/a.png" } },
        // Explicit local syntax must not be rewritten into a home or URI-like value.
        tilde: { workspace: workspace("tilde"), identity: { avatar: "./~a.png" } },
        colon: { workspace: workspace("colon"), identity: { avatar: "./custom:a.png" } },
        absoluteTilde: {
          workspace: workspace("absoluteTilde"),
          identity: { avatar: `${workspace("absoluteTilde")}/~a.png` },
        },
        remote: { identity: { avatar: "https://example.invalid/a.png" } },
        escaped: { workspace: workspace("escaped"), identity: { avatar: `${root}/a.png` } },
        // The candidate names workspaces by id, so ../<id> would land back inside it.
        renamed: {
          workspace: workspace("other"),
          identity: { avatar: `${workspace("renamed")}/a.png` },
        },
        aliased: { workspace: workspace("main"), identity: { avatar: "../main/a.png" } },
        climbed: {
          workspace: workspace("climbed"),
          identity: { avatar: "../../workspaces/climbed/a.png" },
        },
        relativeRenamed: {
          workspace: workspace("other"),
          identity: { avatar: "../relativeRenamed/a.png" },
        },
      },
    },
  };
  const issuePaths = (cfg: unknown) => {
    const result = validateConfigObject(cfg);
    return result.ok ? [] : result.issues.map((issue) => issue.path);
  };
  expect(issuePaths(config)).toEqual([
    "agents.entries.escaped.identity.avatar",
    "agents.entries.renamed.identity.avatar",
    "agents.entries.relativeRenamed.identity.avatar",
  ]);

  const rehearsal = await prepareUpdateCandidateRehearsal({
    config,
    stateDir: path.join(root, "source"),
    candidateRoot: root,
  });
  try {
    const copied: unknown = JSON.parse(await fs.readFile(rehearsal.configPath, "utf8"));
    expect(issuePaths(copied)).toEqual(issuePaths(config));
  } finally {
    await rehearsal.cleanup();
  }
});
