import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { SecretProviderConfig } from "../config/types.secrets.js";
import { withSecureTestNodeCommand } from "../secrets/test-node-command.test-support.js";
import type { SecurityAuditFinding } from "../security/audit.types.js";
import type { SkillStatusEntry } from "../skills/discovery/status.js";
import { withEnvAsync } from "../test-utils/env.js";
import { CORE_HEALTH_CHECKS, createCoreHealthChecks } from "./doctor-core-checks.js";
import type { HealthCheck, HealthFinding } from "./health-checks.js";

const mocks = vi.hoisted(() => ({
  loadModelCatalog: vi.fn(async () => []),
  detectUnavailableSkills: vi.fn<() => Promise<SkillStatusEntry[]>>(async () => []),
  collectSecurityWarnings: vi.fn<() => Promise<SecurityAuditFinding[]>>(async () => []),
  collectWorkspaceSuggestionNotes: vi.fn<() => string[]>(() => []),
}));

vi.mock("./doctor-core-checks.runtime.js", () => ({
  detectUnavailableSkills: mocks.detectUnavailableSkills,
}));

vi.mock("../commands/doctor-security.js", () => ({
  collectSecurityWarnings: mocks.collectSecurityWarnings,
}));

vi.mock("../commands/doctor-workspace-suggestions.js", () => ({
  async *collectWorkspaceSuggestionNotes() {
    yield* mocks.collectWorkspaceSuggestionNotes();
  },
}));

vi.mock("../agents/prepared-model-catalog.js", () => ({
  loadProviderScopedThinkingCatalog: vi.fn(async () => []),
  readPreparedModelCatalog: mocks.loadModelCatalog,
}));

const runtime = { log() {}, error() {}, exit() {} };
const context = (cfg: OpenClawConfig) => ({ mode: "lint" as const, runtime, cfg });
function expectFinding(
  findings: readonly HealthFinding[] | undefined,
  fields: Partial<HealthFinding>,
) {
  expect(findings).toContainEqual(expect.objectContaining(fields));
}

function gatewayTokenConfig(provider: SecretProviderConfig, id = "value"): OpenClawConfig {
  return {
    gateway: {
      mode: "local",
      auth: { mode: "token", token: { source: provider.source, provider: "default", id } },
    },
    secrets: { providers: { default: provider } },
  };
}

const getCheck = (checks: readonly HealthCheck[], id: string) =>
  checks.find((entry) => entry.id === id)!;

describe("CORE_HEALTH_CHECKS", () => {
  let tmp: string | undefined;
  const dirs = useAutoCleanupTempDirTracker(afterEach);
  async function execRef(script: string[], marker = false) {
    tmp = dirs.make("openclaw-health-exec-ref-");
    const markerPath = join(tmp, "exec-ran");
    const resolverPath = join(tmp, "resolve-token.cjs");
    await fs.writeFile(resolverPath, script.join("\n"), "utf8");
    const findings = await withSecureTestNodeCommand(async (command) =>
      getCheck(CORE_HEALTH_CHECKS, "core/doctor/gateway-auth").detect({
        ...context(
          gatewayTokenConfig({
            source: "exec",
            command,
            args: [resolverPath, ...(marker ? [markerPath] : [])],
            jsonOnly: false,
            trustedDirs: [dirname(command), tmp!],
          }),
        ),
        cwd: tmp,
        allowExecSecretRefs: true,
      }),
    );
    return { findings, markerPath };
  }
  beforeEach(() => {
    mocks.loadModelCatalog.mockClear();
    mocks.loadModelCatalog.mockResolvedValue([]);
    mocks.detectUnavailableSkills.mockReset();
    mocks.collectSecurityWarnings.mockReset();
    mocks.collectWorkspaceSuggestionNotes.mockReset();
    tmp = undefined;
  });

  it("does not discover unavailable skills without an unambiguous workspace", async () => {
    const check = getCheck(createCoreHealthChecks(), "core/doctor/skills-readiness");
    expect(check).toMatchObject({ defaultEnabled: false, repair: expect.any(Function) });
    await expect(
      check.detect(context({ agents: { entries: { alpha: {}, beta: {} } } })),
    ).resolves.toEqual([]);
    expect(mocks.detectUnavailableSkills).not.toHaveBeenCalled();
  });
  it("keeps one structured security condition as one health finding", async () => {
    mocks.collectSecurityWarnings.mockResolvedValue([
      {
        checkId: "gateway.bind_no_auth",
        severity: "critical",
        title: "CRITICAL",
        detail: "Gateway is exposed.\nAnyone can control it.",
        remediation: "Bind to loopback.\nGenerate a token.",
      },
    ]);
    const check = getCheck(createCoreHealthChecks(), "core/doctor/security");
    expect(
      await check.detect(context({ gateway: { bind: "lan", auth: { mode: "none" } } })),
    ).toEqual([
      expect.objectContaining({
        checkId: "core/doctor/security",
        severity: "error",
        message: "CRITICAL: Gateway is exposed.",
        fixHint: "Anyone can control it.\nBind to loopback.\nGenerate a token.",
      }),
    ]);
  });
  it("reports disabled Codex plugin routes as core health findings", async () => {
    const check = getCheck(createCoreHealthChecks(), "core/doctor/codex-session-routes");
    const codex = {
      enabled: false,
      config: { appServer: { command: "node -e process.exit(99)" } },
    };
    const findings = await check.detect(
      context({
        plugins: { entries: { codex } },
        agents: {
          defaults: {
            model: "openai-codex/gpt-5.5",
            params: { temperature: 0.7 },
          },
        },
      } as unknown as OpenClawConfig),
    );
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
    const check = getCheck(createCoreHealthChecks(), "core/doctor/hooks-model");
    await check.detect(context(cfg));
    expect(mocks.loadModelCatalog).toHaveBeenCalledWith({
      config: cfg,
      readOnly: true,
      providerDiscoveryProviderIds: [],
    });
  });

  it("reports unresolved SecretRefs even when OPENCLAW_GATEWAY_TOKEN is set", async () => {
    const check = getCheck(CORE_HEALTH_CHECKS, "core/doctor/gateway-auth");
    await withEnvAsync(
      {
        OPENCLAW_GATEWAY_TOKEN: "fallback-token",
        OPENCLAW_MISSING_GATEWAY_REF_TOKEN: undefined,
      },
      async () => {
        const findings = await check?.detect({
          ...context(gatewayTokenConfig({ source: "env" }, "OPENCLAW_MISSING_GATEWAY_REF_TOKEN")),
          cwd: tmp,
        });

        expectFinding(findings, {
          checkId: "core/doctor/gateway-auth",
          message: expect.stringContaining("Gateway token SecretRef could not be resolved:"),
        });
      },
    );
  });

  it("does not execute or warn for valid exec SecretRefs during default gateway auth lint checks", async () => {
    tmp = dirs.make("openclaw-health-exec-ref-");
    const markerPath = join(tmp, "exec-ran");
    const check = getCheck(CORE_HEALTH_CHECKS, "core/doctor/gateway-auth");

    const findings = await check?.detect({
      ...context(
        gatewayTokenConfig({
          source: "exec",
          command: "/bin/sh",
          args: ["-c", `cat >/dev/null; printf executed > ${JSON.stringify(markerPath)}`],
          jsonOnly: false,
        }),
      ),
      cwd: tmp,
    });

    expect(findings).toEqual([]);
    await expect(fs.readFile(markerPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("executes exec SecretRefs when gateway auth lint explicitly allows exec checks", async () => {
    const { findings, markerPath } = await execRef(
      [
        "const fs = require('node:fs');",
        "process.stdin.resume();",
        "process.stdin.on('end', () => {",
        "  fs.writeFileSync(process.argv[2], 'executed');",
        "  process.stdout.write('resolved-token');",
        "});",
      ],
      true,
    );

    expect(findings).toEqual([]);
    await expect(fs.readFile(markerPath, "utf8")).resolves.toBe("executed");
  });

  it("reports exec SecretRef failures when gateway auth lint explicitly allows exec checks", async () => {
    const { findings } = await withEnvAsync({ OPENCLAW_GATEWAY_TOKEN: "fallback-token" }, () =>
      execRef(["process.stdin.resume();", "process.stdin.on('end', () => process.exit(12));"]),
    );

    expectFinding(findings, {
      checkId: "core/doctor/gateway-auth",
      severity: "warning",
      message: expect.stringContaining("Gateway token SecretRef could not be resolved:"),
      fixHint:
        "Run `openclaw doctor --allow-exec` to verify exec SecretRefs during doctor, or `openclaw secrets audit --allow-exec` to audit all exec SecretRefs.",
    });
  });

  it("converts workspace suggestions into info findings", async () => {
    const messages = ["Back up the workspace.", "Memory system not found in workspace."] as const;
    mocks.collectWorkspaceSuggestionNotes.mockReturnValue([`- ${messages[0]}`, messages[1]]);
    const check = getCheck(createCoreHealthChecks(), "core/doctor/workspace-suggestions");
    const findings = await check.detect(
      context({ agents: { defaults: { workspace: "/tmp/openclaw-test-workspace" } } }),
    );
    for (const message of messages) {
      expectFinding(findings, {
        checkId: "core/doctor/workspace-suggestions",
        severity: "info",
        message,
      });
    }
  });

  it("distinguishes migratable model refs from unknown providers and unconfirmed models", async () => {
    const check = getCheck(createCoreHealthChecks(), "core/doctor/model-references");
    const migrations = [
      ["openai-codex/gpt-5.6-sol", "openai/gpt-5.6-sol", "warning"],
      ["codex-cli/gpt-5.6-sol", "openai/gpt-5.6-sol", "warning"],
      ["google-gemini-cli/gemini-2.5-pro", "google/gemini-2.5-pro", "info"],
    ] as const;
    const unconfirmed = [
      "groq/llama3-70b-8192",
      "groq/llama-3.3-70b-versatile",
      "openai/not-in-the-local-catalog",
      "google/not-in-the-local-catalog",
    ];
    // OpenRouter's decision-only seed rows do not establish a conversational catalog.
    const accepted = [
      "groq/openai/gpt-oss-120b",
      "google/gemini-2.5-flash",
      "google/gemini-3.8-flash",
      "openrouter/auto",
      "openrouter/deepseek/deepseek-v4-pro",
    ];
    const findings = await check.detect({
      ...context({
        agents: {
          defaults: {
            model: {
              primary: migrations[0][0],
              fallbacks: [
                ...migrations.slice(1).map(([source]) => source),
                ...unconfirmed,
                ...accepted,
              ],
            },
            imageModel: { primary: "no-such-provider/no-such-model" },
          },
        },
      }),
      mode: "doctor",
    });

    for (const [source, target, severity] of migrations) {
      expectFinding(findings, {
        severity,
        target: source,
        message: `Configured model "${source}" is a legacy reference. Doctor can migrate it to "${target}".`,
        fixHint: `Run \`openclaw doctor --fix\` to migrate this model reference to "${target}".`,
      });
    }
    for (const target of unconfirmed) {
      expectFinding(findings, {
        severity: "info",
        target,
        fixHint:
          "Verify the model id with the provider, or rerun with --severity-min info after refreshing the local catalog.",
      });
    }
    expectFinding(findings, {
      severity: "warning",
      target: "no-such-provider/no-such-model",
      fixHint:
        "Install a plugin that declares this provider, configure it under models.providers, or remove the model reference.",
    });
    for (const target of accepted.map((ref) =>
      ref === "openrouter/auto" ? "openrouter/openrouter/auto" : ref,
    )) {
      expect(findings).not.toContainEqual(expect.objectContaining({ target }));
    }
  });
});

const gatewayAuthCheck = () => getCheck(CORE_HEALTH_CHECKS, "core/doctor/gateway-auth");

async function detectFindings(
  token: NonNullable<NonNullable<OpenClawConfig["gateway"]>["auth"]>["token"],
  mode: "token" | "password" | "none" = "token",
  env: NodeJS.ProcessEnv = {},
) {
  return await gatewayAuthCheck()?.detect({
    mode: "lint",
    runtime,
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
  it('reports the literal token "undefined" as an error', async () => {
    expect(await detectFindings("undefined")).toEqual([
      expect.objectContaining({
        checkId: "core/doctor/gateway-auth",
        severity: "error",
        path: "gateway.auth.token",
        message: expect.stringContaining("not a usable secret"),
        fixHint: expect.stringContaining("--generate-gateway-token"),
      }),
    ]);
  });

  it("leaves password auth authoritative over an inactive placeholder token", async () => {
    expect(await detectFindings("undefined", "password")).toEqual([]);
  });

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
});
