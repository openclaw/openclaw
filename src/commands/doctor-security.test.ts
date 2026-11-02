import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelPlugin } from "../channels/plugins/types.plugin.js";
import type { OpenClawConfig } from "../config/config.js";
import { createConfigIO } from "../config/io.factory.js";
import type { OpenClawConfigWithLegacyRoster } from "../config/legacy.roster.js";
import { REDACTED_SENTINEL } from "../config/redact-snapshot.js";
import { runAuthProfileMigration } from "../flows/doctor-auth-health.js";
import type { ExecApprovalsFile } from "../infra/exec-approvals-core.js";
import {
  saveExecApprovals,
  testing as execApprovalsStoreTesting,
} from "../infra/exec-approvals-store.test-support.js";
import { runSecretsAudit } from "../secrets/audit.js";
import { readSecretStoreValue, writeSecretStoreEntry } from "../secrets/store/secret-store.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { withTestDir } from "../test-helpers/temp-dir.js";

const note = vi.hoisted(() => vi.fn());
const pluginRegistry = vi.hoisted(() => ({ list: [] as unknown[] }));
const listReadOnlyChannelPluginsForConfigMock = vi.hoisted(() => vi.fn());

// mock-isolation: Capture Doctor warnings without rendering terminal UI.
vi.mock("../../packages/terminal-core/src/note.js", () => ({ note }));

vi.mock("../channels/plugins/read-only.js", () => ({
  listReadOnlyChannelPluginsForConfig: listReadOnlyChannelPluginsForConfigMock,
}));

vi.mock("../channels/read-only-account-inspect.js", () => ({
  inspectReadOnlyChannelAccount: vi.fn(async () => null),
}));

// These doctor assertions cover core secret fields. Registry integration tests
// own plugin-derived targets, so avoid compiling every bundled plugin here.
vi.mock("../secrets/target-registry-data.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../secrets/target-registry-data.js")>();
  return { ...actual, getSecretTargetRegistry: actual.getCoreSecretTargetRegistry };
});

import { writeFixtureJson } from "../cli/cli-fixtures.test-support.js";
import {
  createDoctorHealthFlowContext,
  createDoctorPrompterFixture as makePrompter,
} from "../flows/doctor-health-context.test-support.js";
import { collectSecurityWarnings, noteSecurityWarnings } from "./doctor-security.js";

describe("noteSecurityWarnings gateway exposure", () => {
  beforeEach(() => {
    note.mockClear();
    listReadOnlyChannelPluginsForConfigMock.mockReset();
    listReadOnlyChannelPluginsForConfigMock.mockImplementation(() => pluginRegistry.list);
    pluginRegistry.list = [];
    vi.stubEnv("OPENCLAW_GATEWAY_TOKEN", undefined);
    vi.stubEnv("OPENCLAW_GATEWAY_PASSWORD", undefined);
    vi.stubEnv("OPENCLAW_SERVICE_KIND", undefined);
  });

  afterEach(() => vi.unstubAllEnvs());

  const lastMessage = () => String(note.mock.calls[note.mock.calls.length - 1]?.[0] ?? "");
  function expectMessage(...parts: string[]) {
    for (const part of parts) {
      expect(lastMessage()).toContain(part);
    }
  }

  it.each([
    { name: "resolved env shorthand", token: "${GATEWAY_AUTH_TOKEN_FAKE_A}", plaintext: false },
    {
      name: "explicit env reference",
      token: { source: "env", provider: "default", id: "GATEWAY_AUTH_TOKEN_FAKE_A" },
      plaintext: false,
    },
    { name: "literal token", token: "synthetic-gateway-token", plaintext: true },
  ])("classifies $name after auth-profile migration", async ({ token, plaintext }) => {
    await withExecApprovalsFile({ version: 1 }, async () => {
      vi.stubEnv("GATEWAY_AUTH_TOKEN_FAKE_A", "synthetic-gateway-token");
      const configPath = path.join(process.env.OPENCLAW_STATE_DIR!, "openclaw.json");
      await writeFixtureJson(configPath, {
        plugins: { enabled: false },
        // Match this suite's core-only secret registry; channel targets are plugin-owned.
        gateway: { auth: { mode: "token", token } },
      });
      const snapshot = await createConfigIO({
        configPath,
        observe: false,
      }).readConfigFileSnapshot();
      expect(snapshot.valid).toBe(true);
      const ctx = createDoctorHealthFlowContext({
        cfg: snapshot.config,
        configResult: { confirmedConfigSource: undefined },
        configPath,
        options: { nonInteractive: true },
        prompter: makePrompter(false, true),
        env: process.env,
      });

      await runAuthProfileMigration(ctx);
      const findings = await collectSecurityWarnings(ctx.cfg);

      expect(findings.some((finding) => finding.checkId === "config.plaintext_secrets")).toBe(
        plaintext,
      );
    });
  });

  it("does not let pending legacy exec approvals abort Doctor security checks", async () => {
    await withTestDir({ prefix: "openclaw-doctor-security-legacy-" }, async (home) => {
      const stateDir = path.join(home, ".openclaw");
      vi.stubEnv("HOME", home);
      vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
      await fs.mkdir(stateDir, { recursive: true });
      await fs.writeFile(
        path.join(stateDir, "exec-approvals.json"),
        `${JSON.stringify({ version: 1 })}\n`,
        "utf8",
      );
      await closeOpenClawStateDatabaseAsync();
      execApprovalsStoreTesting.reset();

      const findings = await collectSecurityWarnings({ approvals: { exec: { enabled: false } } });

      expect(findings).toContainEqual(
        expect.objectContaining({ checkId: "doctor.approval_forwarding_disabled" }),
      );
    });
  });

  async function withExecApprovalsFile(
    file: ExecApprovalsFile,
    run: () => Promise<void>,
  ): Promise<void> {
    await withTestDir({ prefix: "openclaw-doctor-security-" }, async (home) => {
      vi.stubEnv("HOME", home);
      vi.stubEnv("OPENCLAW_STATE_DIR", path.join(home, ".openclaw"));
      await closeOpenClawStateDatabaseAsync();
      execApprovalsStoreTesting.reset();
      saveExecApprovals(file);
      try {
        await run();
      } finally {
        await closeOpenClawStateDatabaseAsync();
        execApprovalsStoreTesting.reset();
      }
    });
  }

  it("retains rendered security warnings for update finalization", async () => {
    const { runSecurityHealth } =
      await import("../flows/doctor-health-contribution-runners.gateway.js");
    const ctx = createDoctorHealthFlowContext({
      cfg: { gateway: { bind: "lan", auth: { mode: "token", token: "SYNTHETIC_GATEWAY_TOKEN" } } },
      env: {},
    });
    await runSecurityHealth(ctx);
    expect(ctx.updateWarnings).toEqual(
      expect.arrayContaining([expect.stringContaining("network-accessible")]),
    );
  });

  it("warns when OPENCLAW_GATEWAY_TOKEN env conflicts with gateway.auth.token config (#74271)", async () => {
    vi.stubEnv("OPENCLAW_GATEWAY_TOKEN", "env-token-123");
    await noteSecurityWarnings({ gateway: { auth: { token: "config-token-456" } } });
    expectMessage(
      "OPENCLAW_GATEWAY_TOKEN conflicts with gateway.auth.token",
      "Configured local Gateway clients",
      "~/.openclaw/.env",
    );
  });

  it("treats whitespace token as missing", async () => {
    await noteSecurityWarnings({ gateway: { bind: "lan", auth: { mode: "token", token: "   " } } });
    expectMessage("CRITICAL");
  });

  it("explains how to renew inactive generated exec approvals", async () => {
    await withExecApprovalsFile(
      {
        version: 1,
        agents: {
          main: {
            allowlist: [
              {
                pattern: "/usr/bin/git",
                source: "allow-always",
                argPattern: "sha256:argv:obsolete",
              },
              { pattern: "/usr/bin/python3", argPattern: "^script\\.py$" },
            ],
          },
        },
      },
      async () => {
        const findings = await collectSecurityWarnings({} as OpenClawConfig, {});
        const finding = findings.find(
          (candidate) => candidate.checkId === "doctor.exec_approvals_require_cwd_renewal",
        );
        expect(finding?.detail).toContain("1 older generated approval is inactive");
        expect(finding?.remediation).toContain("openclaw doctor --fix");
        expect(finding?.remediation).toContain('choose "Always allow here"');
        expect(finding?.remediation).toContain("Manual allowlist rules are unchanged");
      },
    );
  });

  it("warns when filesystem tools are disabled but exec remains available", async () => {
    await noteSecurityWarnings({
      tools: { allow: ["read", "exec", "process"], deny: ["write", "edit", "apply_patch"] },
    });

    expectMessage(
      "filesystem write tools are disabled, but exec is still available",
      "Runtime tools: exec, process",
      'sandbox.mode="off"',
      "also deny exec/process",
    );
  });

  it("agrees with secrets audit for a sensitive header", async () => {
    await withExecApprovalsFile({ version: 1 }, async () => {
      const cfg: OpenClawConfig = {
        models: {
          providers: {
            ollama: {
              api: "ollama",
              baseUrl: "http://127.0.0.1:11434",
              models: [],
              headers: { Authorization: "Bearer synthetic-key" },
            },
          },
        },
      };
      const env = {
        OPENCLAW_STATE_DIR: process.env.OPENCLAW_STATE_DIR,
        OPENCLAW_CONFIG_PATH: path.join(process.env.OPENCLAW_STATE_DIR!, "openclaw.json"),
        OLLAMA_API_KEY: "synthetic-resolved-key",
      };
      await writeFixtureJson(env.OPENCLAW_CONFIG_PATH, cfg);
      const report = await runSecretsAudit({ env });
      const auditPaths = report.findings
        .filter((finding) => finding.code === "PLAINTEXT_FOUND")
        .map((finding) => finding.jsonPath);
      expect(auditPaths).toEqual(["models.providers.ollama.headers.Authorization"]);
      expect(report.summary.plaintextCount).toBe(1);
      const findings = await collectSecurityWarnings(cfg, env);
      const doctorPaths = findings
        .filter((finding) => finding.checkId === "config.plaintext_secrets")
        .flatMap((finding) => finding.remediation?.match(/^Paths: (.+)$/m)?.[1]?.split(", ") ?? []);
      expect(doctorPaths).toEqual(auditPaths);
    });
  });

  it("names non-generatable redacted store credentials and leaves them unavailable until replaced", async () => {
    await withExecApprovalsFile({ version: 1 }, async () => {
      const entry = { scope: { kind: "team" as const }, name: "SYNTHETIC_PROVIDER_KEY" };
      await writeSecretStoreEntry({
        ...entry,
        value: "synthetic-initial-key",
        kind: "secret",
        updatedBy: "fixture",
      });
      openOpenClawStateDatabase()
        .db.prepare("UPDATE secret_store_entries SET value = ? WHERE name = ?")
        .run(REDACTED_SENTINEL, entry.name);

      const findings = await noteSecurityWarnings({});

      expect(findings).toContainEqual(
        expect.objectContaining({
          checkId: "doctor.secret_store_redacted_value",
          detail: expect.stringContaining(entry.name),
          remediation: expect.stringContaining(`openclaw secrets store set ${entry.name}`),
        }),
      );
      expectMessage("unavailable until replaced");
      expect(await readSecretStoreValue(entry)).toEqual({ ok: true, value: REDACTED_SENTINEL });
    });
  });

  it("does not warn when model provider API keys are stored as SecretRefs", async () => {
    await noteSecurityWarnings({
      secrets: { providers: { default: { source: "env" } } },
      models: { providers: { openai: { apiKey: "${OPENAI_API_KEY}" } } },
    } as unknown as OpenClawConfig);

    const message = lastMessage();
    expect(message).not.toContain("plaintext secret-bearing config fields");
  });

  it.each([false, true])(
    "warns about broader agent exec policy (inherited=%s)",
    async (inherited) => {
      await withExecApprovalsFile(
        { version: 1, agents: { runner: { security: "allowlist", ask: "always" } } },
        async () => {
          await noteSecurityWarnings({
            ...(inherited ? { tools: { exec: { mode: "full" as const } } } : {}),
            agents: { entries: { runner: inherited ? {} : { tools: { exec: { mode: "full" } } } } },
          });
        },
      );

      expectMessage("agents.entries.runner.tools.exec is broader than the host exec policy");
      if (inherited) {
        expectMessage('tools.exec.mode="full"');
      }
      expectMessage('agents.runner.security="allowlist"', 'agents.runner.ask="always"');
    },
  );

  it("warns when heartbeat delivery relies on implicit directPolicy defaults", async () => {
    const cfg = {
      agents: {
        defaults: {
          heartbeat: {
            target: "last",
          },
        },
      },
    } as OpenClawConfig;
    await noteSecurityWarnings(cfg);
    const message = lastMessage();
    expect(message).toContain("Heartbeat defaults");
    expect(message).toContain("agents.defaults.heartbeat.directPolicy");
    expect(message).toContain("direct/DM targets by default");
  });

  it("warns at the legacy agent config path for implicit heartbeat directPolicy", async () => {
    const cfg: OpenClawConfigWithLegacyRoster = {
      agents: { list: [{ id: "ops", heartbeat: { target: "last" } }] },
    };
    await noteSecurityWarnings(cfg);

    expectMessage(
      'Heartbeat agent "ops"',
      'heartbeat.directPolicy for agent "ops"',
      "direct/DM targets by default",
    );
  });

  it("keeps intentional Discord open groupPolicy advisory in Doctor and update lint", async () => {
    const { loadBundledPluginFacade } =
      await import("../test-utils/bundled-plugin-public-surface.js");
    const { discordPlugin: channelPlugin } = await loadBundledPluginFacade<{
      discordPlugin: ChannelPlugin;
    }>({ pluginId: "discord", artifactBasename: "api.js" });
    const { createCoreHealthChecks } = await import("../flows/doctor-core-checks.js");
    const { exitCodeFromFindings } = await import("../flows/doctor-lint-flow.js");

    pluginRegistry.list = [
      {
        id: "discord",
        meta: { label: "Discord" },
        config: {
          listAccountIds: () => ["default"],
          resolveAccount: channelPlugin.config.resolveAccount,
          isEnabled: () => true,
          isConfigured: () => true,
        },
        security: { collectWarnings: channelPlugin.security?.collectWarnings },
      },
    ];

    const cfg: OpenClawConfig = { channels: { discord: { groupPolicy: "open" } } };

    const plainFindings = await noteSecurityWarnings(cfg);

    const securityCheck = createCoreHealthChecks().find(
      (check) => check.id === "core/doctor/security",
    );
    const healthFindings = await securityCheck!.detect({
      mode: "lint",
      runtime: { log() {}, error() {}, exit() {} },
      cfg,
    });
    expect(exitCodeFromFindings(healthFindings, "error")).toBe(0);
    expect(
      plainFindings.filter((finding) => finding.detail.includes('groupPolicy="open"')),
    ).toEqual([expect.objectContaining({ severity: "warn" })]);
    expect(lastMessage()).toContain("openclaw security audit --deep");

    const openGroupFindings = healthFindings.filter((finding) =>
      finding.message.includes('groupPolicy="open"'),
    );
    expect(openGroupFindings).toEqual([
      expect.objectContaining({
        checkId: "core/doctor/security",
        severity: "warning",
        message: expect.stringContaining("Discord security warning"),
      }),
    ]);
    expect(exitCodeFromFindings(openGroupFindings, "warning")).toBe(1);
  });
});
