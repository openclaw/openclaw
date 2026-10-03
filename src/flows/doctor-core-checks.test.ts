import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { SecretProviderConfig } from "../config/types.secrets.js";
import { withSecureTestNodeCommand } from "../secrets/test-node-command.test-support.js";
import type { SkillStatusEntry } from "../skills/discovery/status.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  CORE_HEALTH_CHECKS,
  createCoreHealthChecks,
  type CoreHealthCheckDeps,
} from "./doctor-core-checks.js";
import type { HealthCheck } from "./health-checks.js";

const mocks = vi.hoisted(() => ({
  loadModelCatalog: vi.fn(async () => []),
  callGateway: vi.fn(),
  collectClawStateHealthFindings: vi.fn(
    async (_options?: {
      cronGateway?: {
        list: (opts?: { includeDisabled?: boolean }) => Promise<readonly unknown[]>;
      };
    }) => [],
  ),
}));

vi.mock("../agents/prepared-model-catalog.js", () => ({
  loadProviderScopedThinkingCatalog: vi.fn(async () => []),
  readPreparedModelCatalog: mocks.loadModelCatalog,
}));

vi.mock("../claws/doctor.js", () => ({
  collectClawStateHealthFindings: mocks.collectClawStateHealthFindings,
}));

vi.mock("../gateway/call.js", () => ({
  callGateway: mocks.callGateway,
}));

const runtime = { log() {}, error() {}, exit() {} };

function gatewayTokenConfig(provider: SecretProviderConfig, id = "value"): OpenClawConfig {
  return {
    gateway: {
      mode: "local",
      auth: { mode: "token", token: { source: provider.source, provider: "default", id } },
    },
    secrets: { providers: { default: provider } },
  };
}

function createSkill(): SkillStatusEntry {
  return {
    name: "missing-tool",
    description: "Missing tool",
    source: "workspace",
    bundled: false,
    filePath: "/tmp/openclaw-test-workspace/skills/missing-tool/SKILL.md",
    baseDir: "/tmp/openclaw-test-workspace/skills/missing-tool",
    skillKey: "missing-tool",
    always: false,
    disabled: false,
    blockedByAllowlist: false,
    blockedByAgentFilter: false,
    eligible: false,
    platformIncompatible: false,
    modelVisible: false,
    userInvocable: true,
    commandVisible: false,
    requirements: {
      bins: ["openclaw-test-missing-skill-bin"],
      anyBins: [],
      env: [],
      config: [],
      os: [],
    },
    missing: {
      bins: ["openclaw-test-missing-skill-bin"],
      anyBins: [],
      env: [],
      config: [],
      os: [],
    },
    configChecks: [],
    install: [],
  };
}

function createDeps(overrides: Partial<CoreHealthCheckDeps> = {}): CoreHealthCheckDeps {
  return {
    detectUnavailableSkills: async () => [],
    collectSecurityWarnings: async () => [],
    collectWorkspaceSuggestionNotes: async () => [],
    collectRuntimeToolSchemaFindings: async () => [],
    collectProviderCatalogProjectionFindings: async () => [],
    collectLocalAudioAccelerationFindings: async () => [],
    collectGatewayHealthFindings: async () => [],
    collectGatewayDaemonFindings: async () => [],
    listGatewayCronJobs: async () => [],
    ...overrides,
  };
}

function getCheck(checks: readonly HealthCheck[], id: string): HealthCheck {
  const check = checks.find((entry) => entry.id === id);
  if (!check) {
    throw new Error(`Missing health check ${id}`);
  }
  return check;
}

describe("CORE_HEALTH_CHECKS", () => {
  let tmp: string | undefined;
  beforeEach(() => {
    mocks.loadModelCatalog.mockClear();
    mocks.loadModelCatalog.mockResolvedValue([]);
    mocks.callGateway.mockReset();
    mocks.collectClawStateHealthFindings.mockReset();
    mocks.collectClawStateHealthFindings.mockResolvedValue([]);
    tmp = undefined;
  });

  afterEach(async () => {
    if (tmp) {
      await fs.rm(tmp, { force: true, recursive: true });
    }
  });

  it.each([false, true])(
    "reads cron pages only from one stable inventory (changed=%s)",
    async (changed) => {
      vi.stubEnv("OPENCLAW_EXPERIMENTAL_CLAWS", "1");
      const jobs = [{ id: "job-1" }, { id: "job-2" }];
      for (const [offset, job] of jobs.entries()) {
        mocks.callGateway.mockResolvedValueOnce({
          jobs: [job],
          snapshotRevision: changed && offset === 1 ? "revision-2" : "revision-1",
          total: 2,
          offset,
          limit: 200,
          hasMore: offset === 0,
          nextOffset: offset === 0 ? 1 : null,
        });
      }
      let listedJobs: readonly unknown[] = [];
      mocks.collectClawStateHealthFindings.mockImplementationOnce(async (options) => {
        listedJobs = (await options?.cronGateway?.list({ includeDisabled: true })) ?? [];
        return [];
      });
      const result = getCheck(createCoreHealthChecks(), "core/doctor/claws-state").detect({
        mode: "doctor",
        runtime,
        cfg: {},
      });
      if (changed) {
        await expect(result).rejects.toThrow(
          "Gateway cron inventory changed while doctor was reading it.",
        );
      } else {
        await expect(result).resolves.toEqual([]);
        expect(listedJobs).toEqual(jobs);
        for (const offset of [0, 1]) {
          expect(mocks.callGateway).toHaveBeenNthCalledWith(
            offset + 1,
            expect.objectContaining({
              method: "cron.list",
              params: { includeDisabled: true, limit: 200, offset },
            }),
          );
        }
      }
    },
  );

  it("converts unavailable skills into scoped repair-capable findings", async () => {
    const detectUnavailableSkills = vi.fn(async () => [createSkill()]);
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          workspace: "/tmp/openclaw-test-workspace",
          skills: ["missing-tool"],
        },
      },
    };
    const check = getCheck(
      createCoreHealthChecks(createDeps({ detectUnavailableSkills })),
      "core/doctor/skills-readiness",
    );
    expect(check).toMatchObject({ defaultEnabled: false, repair: expect.any(Function) });
    await expect(
      check.detect({
        mode: "lint",
        runtime,
        cfg: { agents: { list: [{ id: "alpha", default: true }, { id: "beta" }] } },
      }),
    ).resolves.toEqual([]);
    expect(detectUnavailableSkills).not.toHaveBeenCalled();
    const ctx = { mode: "fix" as const, runtime, cfg, cwd: "/tmp/openclaw-test-workspace" };
    const findings = await check.detect({ ...ctx, mode: "lint" });
    const finding = expect.objectContaining({
      checkId: "core/doctor/skills-readiness",
      severity: "warning",
      path: "skills.entries.missing-tool.enabled",
    });
    expect(findings).toContainEqual(finding);
    await expect(
      check.detect(ctx, { paths: ["skills.entries.other-tool.enabled"] }),
    ).resolves.toEqual([]);
    await expect(
      check.detect(ctx, { paths: ["skills.entries.missing-tool.enabled"] }),
    ).resolves.toContainEqual(finding);
    const repaired = await check.repair?.(ctx, findings);
    expect(repaired?.config?.skills?.entries?.["missing-tool"]).toEqual({ enabled: false });
    expect(repaired?.changes).toContain("Disabled unavailable skill missing-tool.");
    expect(repaired?.effects).toContainEqual(
      expect.objectContaining({
        kind: "config",
        action: "disable-skill",
        target: "skills.entries.missing-tool.enabled",
      }),
    );
  });
  it("keeps one structured security condition as one health finding", async () => {
    const check = getCheck(
      createCoreHealthChecks(
        createDeps({
          collectSecurityWarnings: async () => [
            {
              checkId: "gateway.bind_no_auth",
              severity: "critical",
              title: "CRITICAL",
              detail:
                'Gateway bound to "lan" (0.0.0.0) without authentication.\nAnyone on your network can fully control your agent.',
              remediation:
                "Fix: openclaw config set gateway.bind loopback\nFix: openclaw doctor --fix to generate a token",
            },
          ],
        }),
      ),
      "core/doctor/security",
    );
    expect(
      await check.detect({
        mode: "lint",
        runtime,
        cfg: {
          gateway: { bind: "lan", auth: { mode: "none" } },
        },
      }),
    ).toEqual([
      expect.objectContaining({
        checkId: "core/doctor/security",
        severity: "error",
        message: 'CRITICAL: Gateway bound to "lan" (0.0.0.0) without authentication.',
        fixHint:
          "Anyone on your network can fully control your agent.\nFix: openclaw config set gateway.bind loopback\nFix: openclaw doctor --fix to generate a token",
      }),
    ]);
  });
  it("reports disabled Codex plugin routes as core health findings", async () => {
    const check = getCheck(
      createCoreHealthChecks(createDeps()),
      "core/doctor/codex-session-routes",
    );
    const codex = {
      enabled: false,
      config: { appServer: { command: "node -e process.exit(99)" } },
    };
    const findings = await check.detect({
      mode: "lint",
      runtime,
      cfg: {
        plugins: { entries: { codex } },
        agents: {
          defaults: {
            model: "openai-codex/gpt-5.5",
            params: { temperature: 0.7 },
          },
        },
      } as unknown as OpenClawConfig,
    });
    expect(findings.map((finding) => finding.message)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Codex plugin is disabled by config"),
        "Codex app-server command override includes inline arguments.",
        "Custom Codex app-server command bypasses OpenClaw's managed exact-version binary.",
        "Explicit native Codex model routes cannot reproduce authored request transport parameters.",
      ]),
    );
    expect(findings[0]).toMatchObject({
      path: "agents.defaults.model",
      target: "openai/gpt-5.5",
      requirement: "Codex plugin enabled for routes that use the Codex runtime.",
      fixHint:
        "Enable plugins.entries.codex and plugin loading, and remove codex from plugins.deny; or set the affected OpenAI models to an OpenClaw runtime policy.",
    });
  });

  it("uses the read-only model catalog for hooks.gmail.model checks", async () => {
    const cfg: OpenClawConfig = { hooks: { gmail: { model: "openai/gpt-5.5" } } };
    const check = getCheck(createCoreHealthChecks(createDeps()), "core/doctor/hooks-model");
    await check.detect({ mode: "lint", runtime, cfg });
    expect(mocks.loadModelCatalog).toHaveBeenCalledWith({
      config: cfg,
      readOnly: true,
      providerDiscoveryProviderIds: [],
    });
  });

  it("reports unresolved SecretRefs even when OPENCLAW_GATEWAY_TOKEN is set", async () => {
    const check = CORE_HEALTH_CHECKS.find((entry) => entry.id === "core/doctor/gateway-auth");
    await withEnvAsync(
      {
        OPENCLAW_GATEWAY_TOKEN: "fallback-token",
        OPENCLAW_MISSING_GATEWAY_REF_TOKEN: undefined,
      },
      async () => {
        const findings = await check?.detect({
          mode: "lint",
          runtime,
          cfg: gatewayTokenConfig({ source: "env" }, "OPENCLAW_MISSING_GATEWAY_REF_TOKEN"),
          cwd: tmp,
        });

        expect(findings).toContainEqual(
          expect.objectContaining({
            checkId: "core/doctor/gateway-auth",
            message: expect.stringContaining("Gateway token SecretRef could not be resolved:"),
          }),
        );
      },
    );
  });

  it("does not execute or warn for valid exec SecretRefs during default gateway auth lint checks", async () => {
    tmp = await fs.mkdtemp(join(tmpdir(), "openclaw-health-exec-ref-"));
    const markerPath = join(tmp, "exec-ran");
    const check = CORE_HEALTH_CHECKS.find((entry) => entry.id === "core/doctor/gateway-auth");

    const findings = await check?.detect({
      mode: "lint",
      runtime,
      cfg: gatewayTokenConfig({
        source: "exec",
        command: "/bin/sh",
        args: ["-c", `cat >/dev/null; printf executed > ${JSON.stringify(markerPath)}`],
        jsonOnly: false,
      }),
      cwd: tmp,
    });

    expect(findings).toEqual([]);
    await expect(fs.readFile(markerPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("executes exec SecretRefs when gateway auth lint explicitly allows exec checks", async () => {
    tmp = await fs.mkdtemp(join(tmpdir(), "openclaw-health-exec-ref-"));
    const markerPath = join(tmp, "exec-ran");
    const resolverPath = join(tmp, "resolve-token.cjs");
    await fs.writeFile(
      resolverPath,
      [
        "const fs = require('node:fs');",
        "process.stdin.resume();",
        "process.stdin.on('end', () => {",
        "  fs.writeFileSync(process.argv[2], 'executed');",
        "  process.stdout.write('resolved-token');",
        "});",
      ].join("\n"),
      "utf8",
    );
    const check = CORE_HEALTH_CHECKS.find((entry) => entry.id === "core/doctor/gateway-auth");

    const findings = await withSecureTestNodeCommand(async (command) =>
      check?.detect({
        mode: "lint",
        runtime,
        cfg: gatewayTokenConfig({
          source: "exec",
          command,
          args: [resolverPath, markerPath],
          jsonOnly: false,
          trustedDirs: [dirname(command), tmp!],
        }),
        cwd: tmp,
        allowExecSecretRefs: true,
      }),
    );

    expect(findings).toEqual([]);
    await expect(fs.readFile(markerPath, "utf8")).resolves.toBe("executed");
  });

  it("reports exec SecretRef failures when gateway auth lint explicitly allows exec checks", async () => {
    tmp = await fs.mkdtemp(join(tmpdir(), "openclaw-health-exec-ref-"));
    const resolverPath = join(tmp, "fail-token.cjs");
    await fs.writeFile(
      resolverPath,
      ["process.stdin.resume();", "process.stdin.on('end', () => process.exit(12));"].join("\n"),
      "utf8",
    );
    const check = CORE_HEALTH_CHECKS.find((entry) => entry.id === "core/doctor/gateway-auth");

    const findings = await withEnvAsync({ OPENCLAW_GATEWAY_TOKEN: "fallback-token" }, async () =>
      withSecureTestNodeCommand(async (command) =>
        check?.detect({
          mode: "lint",
          runtime,
          cfg: gatewayTokenConfig({
            source: "exec",
            command,
            args: [resolverPath],
            jsonOnly: false,
            trustedDirs: [dirname(command), tmp!],
          }),
          allowExecSecretRefs: true,
        }),
      ),
    );

    expect(findings).toContainEqual(
      expect.objectContaining({
        checkId: "core/doctor/gateway-auth",
        severity: "warning",
        message: expect.stringContaining("Gateway token SecretRef could not be resolved:"),
        fixHint:
          "Run `openclaw doctor --allow-exec` to verify exec SecretRefs during doctor, or `openclaw secrets audit --allow-exec` to audit all exec SecretRefs.",
      }),
    );
  });

  it("converts workspace suggestions into info findings", async () => {
    const check = getCheck(
      createCoreHealthChecks(
        createDeps({
          collectWorkspaceSuggestionNotes: async () => [
            "- Back up the workspace.",
            "Memory system not found in workspace.",
          ],
        }),
      ),
      "core/doctor/workspace-suggestions",
    );
    const findings = await check.detect({
      mode: "lint",
      runtime,
      cfg: { agents: { defaults: { workspace: "/tmp/openclaw-test-workspace" } } },
      cwd: "/tmp/openclaw-test-workspace",
    });
    for (const message of ["Back up the workspace.", "Memory system not found in workspace."]) {
      expect(findings).toContainEqual(
        expect.objectContaining({
          checkId: "core/doctor/workspace-suggestions",
          severity: "info",
          message,
        }),
      );
    }
  });

  it("distinguishes migratable model refs from unknown providers and unconfirmed models", async () => {
    const check = getCheck(createCoreHealthChecks(), "core/doctor/model-references");

    const findings = await check.detect({
      mode: "doctor",
      runtime,
      cfg: {
        agents: {
          defaults: {
            model: {
              primary: "openai-codex/gpt-5.6-sol",
              fallbacks: [
                "codex-cli/gpt-5.6-sol",
                "groq/llama3-70b-8192",
                "groq/llama-3.3-70b-versatile",
                "openai/not-in-the-local-catalog",
                "google/gemini-2.5-flash",
                "google/gemini-3.8-flash",
                "google-gemini-cli/gemini-2.5-pro",
                "openrouter/auto",
                "openrouter/deepseek/deepseek-v4-pro",
              ],
            },
            imageModel: { primary: "no-such-provider/no-such-model" },
          },
        },
      },
    });

    for (const [source, target, severity] of [
      ["openai-codex/gpt-5.6-sol", "openai/gpt-5.6-sol", "warning"],
      ["codex-cli/gpt-5.6-sol", "openai/gpt-5.6-sol", "warning"],
      ["groq/llama3-70b-8192", "groq/llama-3.3-70b-versatile", "info"],
      ["google-gemini-cli/gemini-2.5-pro", "google/gemini-2.5-pro", "info"],
    ] as const) {
      expect(findings).toContainEqual(
        expect.objectContaining({
          severity,
          target: source,
          message: `Configured model "${source}" is a legacy reference. Doctor can migrate it to "${target}".`,
          fixHint: `Run \`openclaw doctor --fix\` to migrate this model reference to "${target}".`,
        }),
      );
    }
    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: "info",
          target: "openai/not-in-the-local-catalog",
          fixHint:
            "Verify the model id with the provider, or rerun with --severity-min info after refreshing the local catalog.",
        }),
        expect.objectContaining({
          severity: "info",
          target: "google/gemini-3.8-flash",
          fixHint:
            "Verify the model id with the provider, or rerun with --severity-min info after refreshing the local catalog.",
        }),
        expect.objectContaining({
          severity: "warning",
          target: "no-such-provider/no-such-model",
          fixHint:
            "Install a plugin that declares this provider, configure it under models.providers, or remove the model reference.",
        }),
      ]),
    );
    expect(findings).not.toContainEqual(
      expect.objectContaining({ target: "groq/llama-3.3-70b-versatile" }),
    );
    expect(findings).not.toContainEqual(
      expect.objectContaining({ target: "google/gemini-2.5-flash" }),
    );
    // OpenRouter plans no catalog rows, so an unlisted id there is not a finding.
    for (const target of ["openrouter/openrouter/auto", "openrouter/deepseek/deepseek-v4-pro"]) {
      expect(findings).not.toContainEqual(expect.objectContaining({ target }));
    }
  });
});

const gatewayAuthCheck = () =>
  CORE_HEALTH_CHECKS.find((entry) => entry.id === "core/doctor/gateway-auth");

async function detectFindings(
  token: NonNullable<NonNullable<OpenClawConfig["gateway"]>["auth"]>["token"],
  mode: "token" | "password" | "none" = "token",
  env: NodeJS.ProcessEnv = {},
) {
  return await gatewayAuthCheck()?.detect({
    mode: "lint",
    runtime: { log() {}, error() {}, exit() {} },
    cfg: {
      gateway: {
        mode: "local",
        auth: { mode, token, ...(mode === "password" ? { password: "synthetic-password" } : {}) },
      },
    },
    cwd: process.cwd(),
    env,
  });
}

describe("doctor gateway auth placeholder token", () => {
  it.each(["undefined", "null", "  undefined  ", "", "  "])(
    'reports the literal token "%s" as an error',
    async (token) => {
      expect(await detectFindings(token)).toEqual([
        expect.objectContaining({
          checkId: "core/doctor/gateway-auth",
          severity: "error",
          path: "gateway.auth.token",
          message: expect.stringContaining("not a usable secret"),
          fixHint: expect.stringContaining("--generate-gateway-token"),
        }),
      ]);
    },
  );

  it.each(["password", "none"] as const)(
    "leaves %s auth authoritative over an inactive placeholder token",
    async (mode) => {
      expect(await detectFindings("undefined", mode)).toEqual([]);
    },
  );

  it("keeps a SecretRef authoritative over an ambient placeholder", async () => {
    expect(
      await detectFindings({ source: "env", provider: "default", id: "SYNTHETIC_TOKEN" }, "token", {
        SYNTHETIC_TOKEN: "synthetic-valid-token",
        OPENCLAW_GATEWAY_TOKEN: "undefined",
      }),
    ).toEqual([]);
  });

  it("reports a placeholder from a SecretRef without proposing plaintext rotation", async () => {
    expect(
      await detectFindings({ source: "env", provider: "default", id: "SYNTHETIC_TOKEN" }, "token", {
        SYNTHETIC_TOKEN: "undefined",
      }),
    ).toEqual([
      expect.objectContaining({ fixHint: expect.stringContaining("external secret source") }),
    ]);
  });

  it("accepts a real token that merely contains the word undefined", async () => {
    expect(await detectFindings("undefined-but-actually-a-long-real-token")).toEqual([]);
  });
});
