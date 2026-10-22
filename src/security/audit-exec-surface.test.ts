import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/config.js";
import { saveExecApprovals } from "../infra/exec-approvals-store.test-support.js";
import { captureEnv } from "../test-utils/env.js";
import { collectMinimalProfileOverrideFindings } from "./audit-extra.sync.js";
import { collectPluginsTrustFindings } from "./audit-plugins-trust.js";
import { runSecurityAuditCore } from "./audit.js";
import { collectSecurityAuditFindings } from "./audit.test-support.js";
import type { SecurityAuditFinding } from "./audit.types.js";

const execFileAsync = promisify(execFile);

const mcporterConfig = (): OpenClawConfig => ({
  agents: {
    entries: {
      "asset-agent": {
        skills: ["asset-lifecycle-tracking"],
        tools: { exec: { host: "gateway", mode: "full" } },
      },
    },
  },
});

const fsToolsDisabled = () => ({
  allow: ["read", "exec", "process"],
  deny: ["write", "edit", "apply_patch"],
});

function hasFinding(
  checkId:
    | "tools.exec.auto_allow_skills_enabled"
    | "tools.exec.allowlist_interpreter_without_strict_inline_eval"
    | "security.exposure.open_channels_with_exec"
    | "tools.exec.security_full_configured"
    | "tools.exec.fs_tools_disabled_but_exec_enabled",
  severity: "warn" | "critical",
  findings: SecurityAuditFinding[],
) {
  return findings.some((finding) => finding.checkId === checkId && finding.severity === severity);
}

function requireFinding(
  findings: SecurityAuditFinding[],
  checkId: string,
  expected: Partial<SecurityAuditFinding> = {},
) {
  const finding = expectDefined(
    findings.find((entry) => entry.checkId === checkId),
    checkId,
  );
  expect(finding).toMatchObject(expected);
  return finding;
}

describe("security audit exec surface findings", () => {
  // Redirect every home source so approvals never touch the real host state.
  const tempDirs = useAutoCleanupTempDirTracker(afterAll);
  let envSnapshot: ReturnType<typeof captureEnv> | undefined;

  beforeEach(async () => {
    envSnapshot = captureEnv(["OPENCLAW_HOME", "HOME", "USERPROFILE"]);
    const tempDir = tempDirs.make("openclaw-exec-approvals-");
    await fs.mkdir(path.join(tempDir, ".openclaw"), { recursive: true });
    process.env.OPENCLAW_HOME = tempDir;
    process.env.HOME = tempDir;
    process.env.USERPROFILE = tempDir;
  });

  afterEach(() => {
    saveExecApprovals({ version: 1, agents: {} });
    envSnapshot?.restore();
    envSnapshot = undefined;
  });

  it("warns when exec approvals enable autoAllowSkills", async () => {
    saveExecApprovals({
      version: 1,
      defaults: { autoAllowSkills: true },
      agents: {},
    });

    requireFinding(await collectSecurityAuditFindings({}), "tools.exec.auto_allow_skills_enabled", {
      severity: "warn",
    });
  });

  it.each([
    ["global default", {}, false],
    ["agent override", { tools: { exec: { strictInlineEval: false } } }, true],
  ] as const)("honors strictInlineEval from %s", async (_name, ops, warns) => {
    saveExecApprovals({
      version: 1,
      agents: { ops: { allowlist: [{ pattern: "/usr/bin/python3" }] } },
    });

    expect(
      hasFinding(
        "tools.exec.allowlist_interpreter_without_strict_inline_eval",
        "warn",
        await collectSecurityAuditFindings({
          agents: { entries: { ops } },
          tools: { exec: { strictInlineEval: true } },
        }),
      ),
    ).toBe(warns);
  });

  it.each([
    [{ discord: { groupPolicy: "open" } }, { mode: "allowlist", host: "gateway" }, "warn"],
    [{ slack: { dmPolicy: "open" } }, { mode: "full" }, "critical"],
  ] as const)("reports open channel exec exposure: %j", async (channels, exec, severity) => {
    const findings = await collectSecurityAuditFindings({ channels, tools: { exec } });
    expect(hasFinding("security.exposure.open_channels_with_exec", severity, findings)).toBe(true);
    if (severity === "critical") {
      expect(hasFinding("tools.exec.security_full_configured", severity, findings)).toBe(true);
    }
  });

  it("uses configured plugin and selected channel policies throughout the audit", async () => {
    const stateDir = path.join(process.env.OPENCLAW_HOME!, ".openclaw");
    const pluginDir = path.join(stateDir, "extensions", "audit-fixture");
    await fs.mkdir(pluginDir, { recursive: true });
    await fs.writeFile(
      path.join(pluginDir, "package.json"),
      JSON.stringify({
        name: "audit-fixture",
        version: "1.0.0",
        type: "module",
        openclaw: {
          extensions: ["./index.js"],
          channel: {
            id: "audit-fixture",
            label: "Audit fixture",
            selectionLabel: "Audit fixture",
            docsPath: "/channels/audit-fixture",
            blurb: "Synthetic audit metadata",
            doctorCapabilities: { dmAllowFromMode: "nestedOnly" },
          },
        },
      }),
    );
    await fs.writeFile(
      path.join(pluginDir, "openclaw.plugin.json"),
      JSON.stringify({
        id: "audit-fixture",
        channels: ["audit-fixture"],
        contracts: { tools: ["audit_fixture_tool"] },
        configSchema: { type: "object", additionalProperties: false, properties: {} },
      }),
    );
    await fs.writeFile(
      path.join(pluginDir, "index.js"),
      'throw new Error("metadata-only fixture");\n',
    );
    const pluginFindings = await collectPluginsTrustFindings({
      stateDir,
      cfg: {
        plugins: { allow: ["audit-fixture"] },
        tools: { profile: "coding", alsoAllow: ["group:plugins"] },
      },
    });
    requireFinding(pluginFindings, "plugins.tools_reachable_permissive_policy", {
      severity: "warn",
    });
    const findings = await collectSecurityAuditFindings({
      plugins: {
        allow: ["audit-fixture"],
        load: { paths: [pluginDir] },
      },
      agents: { entries: { home: {}, work: {} } },
      channels: {
        "audit-fixture": {
          dmPolicy: "disabled",
          dm: { policy: "open" },
          accounts: { work: { groups: { room: { groupPolicy: "open" } } } },
        },
        "top-policy-fixture": { dmPolicy: "disabled", dm: { policy: "open" } },
      },
      tools: { exec: { mode: "full" } },
    });
    const openPaths = [
      "channels.audit-fixture.accounts.work.groups.room.groupPolicy",
      "channels.audit-fixture.dm.policy",
    ];
    for (const checkId of [
      "security.exposure.open_channels_with_exec",
      "security.exposure.open_groups_with_elevated",
      "security.trust_model.multi_user_heuristic",
      "security.trust_model.cross_agent_session_access_default",
    ]) {
      const finding = requireFinding(findings, checkId);
      for (const policyPath of openPaths) {
        expect(finding?.detail, checkId).toContain(policyPath);
      }
      expect(finding?.detail, checkId).not.toContain("channels.top-policy-fixture.dm.policy");
    }
    expect(findings.find((entry) => entry.checkId === "summary.attack_surface")?.detail).toContain(
      "groups: open=1, allowlist=0\ndirect messages: open=1",
    );
  });

  it("reports canonical agent paths for filesystem policy drift", async () => {
    const tools = fsToolsDisabled();
    const findings = await collectSecurityAuditFindings({
      agents: { entries: { ops: { tools } } },
    });
    requireFinding(findings, "tools.exec.fs_tools_disabled_but_exec_enabled", {
      detail: expect.stringContaining("agents.entries.ops.tools"),
    });
  });

  it("does not warn when sandbox filesystem policy constrains exec", async () => {
    const findings = await collectSecurityAuditFindings({
      agents: {
        defaults: { sandbox: { mode: "all", workspaceAccess: "ro" } },
      },
      tools: fsToolsDisabled(),
    });

    expect(hasFinding("tools.exec.fs_tools_disabled_but_exec_enabled", "warn", findings)).toBe(
      false,
    );
  });

  async function registryFixture() {
    const stateDir = await fs.mkdtemp(path.join(process.env.OPENCLAW_HOME!, "mcporter-"));
    const configDir = path.join(stateDir, "skills", "config");
    await fs.mkdir(configDir, { recursive: true });
    return { stateDir, registry: path.join(configDir, "mcporter.json") };
  }
  async function expectIncompleteRegistry(stateDir: string) {
    const report = await auditConfig(mcporterConfig(), stateDir);
    const checkIds = report.findings.map((finding) => finding.checkId);
    expect(checkIds).not.toContain("tools.exec.agent_skill_mcp_boundary_drift");
    expect(checkIds).toContain("tools.exec.mcporter_registry_inspection_incomplete");
  }
  function auditConfig(config: OpenClawConfig, stateDir?: string) {
    return runSecurityAuditCore({
      config,
      sourceConfig: {},
      env: stateDir ? { OPENCLAW_STATE_DIR: stateDir } : {},
      ...(stateDir ? { stateDir } : {}),
      includeFilesystem: false,
      includeChannelSecurity: false,
    });
  }

  it("flags agent profile overrides when global tools.profile is minimal", () => {
    const findings = collectMinimalProfileOverrideFindings({
      tools: { profile: "minimal" },
      agents: { entries: { owner: { tools: { profile: "full" } } } },
    });

    requireFinding(findings, "tools.profile_minimal_overridden", {
      severity: "warn",
      detail: expect.stringContaining("agents.entries.owner=full"),
    });
  });

  it("flags tools.elevated allowFrom wildcard as critical", async () => {
    const findings = await collectSecurityAuditFindings({
      agents: { entries: { main: {} } },
      tools: { elevated: { allowFrom: { whatsapp: ["*"] } } },
    });

    requireFinding(findings, "tools.elevated.allowFrom.whatsapp.wildcard", {
      severity: "critical",
    });
  });

  it("flags per-agent skill allowlists combined with host exec and a global mcporter registry", async () => {
    const { stateDir, registry } = await registryFixture();
    await fs.writeFile(registry, JSON.stringify({ mcpServers: { "whois-mcp": {} } }), "utf8");

    const report = await auditConfig(mcporterConfig(), stateDir);

    const finding = requireFinding(report.findings, "tools.exec.agent_skill_mcp_boundary_drift", {
      severity: "warn",
      detail: expect.stringContaining("asset-agent"),
    });
    expect(finding?.detail).toContain("whois-mcp");
    expect(finding?.detail).toContain("skills/config/mcporter.json");
  });

  it("warns when a malformed global mcporter registry cannot be inspected", async () => {
    const { stateDir, registry } = await registryFixture();
    await fs.writeFile(registry, "{ not json", "utf8");
    await expectIncompleteRegistry(stateDir);
  });

  it.runIf(process.platform !== "win32")(
    "warns for a named-pipe mcporter registry without blocking",
    async () => {
      const { stateDir, registry } = await registryFixture();
      await execFileAsync("mkfifo", [registry]);
      await expectIncompleteRegistry(stateDir);
    },
  );

  it("warns when an oversized symlinked global mcporter registry cannot be inspected", async () => {
    const { stateDir, registry } = await registryFixture();
    const targetPath = path.join(stateDir, "real-mcporter.json");
    await fs.writeFile(targetPath, Buffer.alloc(16 * 1024 * 1024 + 1, 0x20));
    await fs.symlink(targetPath, registry);
    await expectIncompleteRegistry(stateDir);
  });

  it("audits inherited defaults independently of an agent override", async () => {
    const stateDir = await fs.mkdtemp(path.join(process.env.OPENCLAW_HOME!, "mcporter-defaults-"));
    const report = await auditConfig(
      {
        mcp: { servers: { docs: { command: "node", args: ["docs-mcp.js"] } } },
        tools: { exec: { host: "gateway", security: "full", ask: "off" } },
        agents: {
          defaults: { skills: ["docs-search"] },
          entries: {
            "safe-default": {
              skills: ["safe-only"],
              tools: { exec: { security: "deny" } },
            },
            inheritor: {},
          },
        },
      },
      stateDir,
    );

    const finding = requireFinding(report.findings, "tools.exec.agent_skill_mcp_boundary_drift");
    expect(finding?.detail).toContain("- agents.defaults: agents.defaults.skills");
    expect(finding?.detail).toContain("- inheritor: agents.defaults.skills (inherited)");
    expect(finding?.detail).not.toContain("- safe-default:");
  });

  it("keeps unrelated dangerous flags active when one dangerous flag is suppressed", async () => {
    const checkId = "config.insecure_or_dangerous_flags";
    const gmailFlag = "hooks.gmail.allowUnsafeExternalContent=true";
    const dangerousDetail = (detail: string) =>
      expect.objectContaining({
        checkId,
        detail: expect.stringContaining(detail),
      });
    const suppression = { checkId, detailIncludes: gmailFlag, reason: "test suppression" };
    const report = await auditConfig({
      agents: { entries: { main: {} } },
      hooks: { gmail: { allowUnsafeExternalContent: true } },
      tools: { exec: { applyPatch: { workspaceOnly: false } } },
      security: { audit: { suppressions: [suppression] } },
    });

    expect(report.suppressedFindings).toEqual([dangerousDetail(gmailFlag)]);
    expect(report.findings).toContainEqual(
      dangerousDetail("tools.exec.applyPatch.workspaceOnly=false"),
    );
    expect(report.findings).toContainEqual(
      expect.objectContaining({ checkId: "security.audit.suppressions.active" }),
    );
  });
});
