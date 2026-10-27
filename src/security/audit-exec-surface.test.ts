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
function expectPresence(findings: SecurityAuditFinding[], checkId: string, present: boolean) {
  expect(
    findings.some((finding) => finding.checkId === checkId && finding.severity === "warn"),
  ).toBe(present);
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
    saveExecApprovals({ version: 1, defaults: { autoAllowSkills: true }, agents: {} });
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

    expectPresence(
      await collectSecurityAuditFindings({
        agents: { entries: { ops } },
        tools: { exec: { strictInlineEval: true } },
      }),
      "tools.exec.allowlist_interpreter_without_strict_inline_eval",
      warns,
    );
  });

  it.each([
    [{ discord: { groupPolicy: "open" } }, { mode: "allowlist", host: "gateway" }, "warn"],
    [{ slack: { dmPolicy: "open" } }, { mode: "full" }, "critical"],
  ] as const)("reports open channel exec exposure: %j", async (channels, exec, severity) => {
    const findings = await collectSecurityAuditFindings({ channels, tools: { exec } });
    requireFinding(findings, "security.exposure.open_channels_with_exec", { severity });
    if (severity === "critical") {
      requireFinding(findings, "tools.exec.security_full_configured", { severity });
    }
  });

  // #183541: the audit must judge host exec the way the runtime runs it. An
  // unsandboxed agent with unset security runs security=full, ask=off.
  const defaultFullAgents = (
    researcher?: { tools: { exec: { ask: "off" } } },
    sandbox?: { mode: "non-main" | "all" },
  ) => ({
    tools: { exec: { strictInlineEval: true } },
    agents: {
      ownership: "explicit" as const,
      defaults: { systemAgent: { agentId: "main" }, sandbox },
      entries: {
        main: { tools: { exec: { mode: "ask" as const } } },
        researcher: { workspace: "/tmp/ws-researcher", ...researcher },
      },
    },
  });

  it("keeps a bare default-full agent out of security_full_configured without open channels", async () => {
    const findings = await collectSecurityAuditFindings(defaultFullAgents());
    expect(findings.some((f) => f.checkId === "tools.exec.security_full_configured")).toBe(false);
    expect(findings.some((f) => f.checkId === "security.exposure.open_channels_with_exec")).toBe(
      false,
    );
  });

  it.each([undefined, { mode: "non-main" }] as const)(
    "reports host exec with disabled approvals (sandbox=%j)",
    async (sandbox) => {
      const findings = await collectSecurityAuditFindings(
        defaultFullAgents({ tools: { exec: { ask: "off" } } }, sandbox),
      );
      const finding = requireFinding(findings, "tools.exec.security_full_configured", {
        severity: "warn",
      });
      expect(finding.detail).toContain("researcher");
    },
  );

  it.each([
    ["bare default", undefined, undefined],
    ["ask off", { tools: { exec: { ask: "off" as const } } }, undefined],
    ["non-main sandbox", undefined, { mode: "non-main" }],
  ] as const)(
    "rates open DMs reaching a default-full agent as critical (%s)",
    async (_name, researcher, sandbox) => {
      const findings = await collectSecurityAuditFindings({
        ...defaultFullAgents(researcher, sandbox),
        channels: { telegram: { dmPolicy: "open", allowFrom: ["*"] } },
      });
      const exposure = requireFinding(findings, "security.exposure.open_channels_with_exec", {
        severity: "critical",
      });
      expect(exposure.detail).toContain("researcher: security=full");
      expect(
        findings.some(
          (finding) =>
            finding.checkId === "tools.exec.security_full_configured" &&
            finding.severity === "critical",
        ),
      ).toBe(researcher !== undefined);
    },
  );

  it("does not report full exec when every session is sandboxed", async () => {
    const findings = await collectSecurityAuditFindings({
      ...defaultFullAgents({ tools: { exec: { ask: "off" } } }, { mode: "all" }),
      channels: { telegram: { dmPolicy: "open", allowFrom: ["*"] } },
    });
    expect(
      findings.some((finding) => finding.checkId === "tools.exec.security_full_configured"),
    ).toBe(false);
    requireFinding(findings, "security.exposure.open_channels_with_exec", { severity: "warn" });
  });

  it("does not invent exec exposure for an explicit fleet whose agents deny exec", async () => {
    const findings = await collectSecurityAuditFindings({
      agents: {
        ownership: "explicit",
        entries: {
          main: { tools: { exec: { mode: "deny" } } },
          researcher: { tools: { exec: { mode: "deny" } } },
        },
      },
      channels: { telegram: { dmPolicy: "open", allowFrom: ["*"] } },
    });
    expect(
      findings.some((finding) => finding.checkId === "security.exposure.open_channels_with_exec"),
    ).toBe(false);
    expect(
      findings.some((finding) => finding.checkId === "tools.exec.security_full_configured"),
    ).toBe(false);
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
    const findings = await collectSecurityAuditFindings({
      agents: { entries: { ops: { tools: fsToolsDisabled() } } },
    });
    requireFinding(findings, "tools.exec.fs_tools_disabled_but_exec_enabled", {
      detail: expect.stringContaining("agents.entries.ops.tools"),
    });
  });

  it("does not warn when sandbox filesystem policy constrains exec", async () => {
    const findings = await collectSecurityAuditFindings({
      agents: { defaults: { sandbox: { mode: "all", workspaceAccess: "ro" } } },
      tools: fsToolsDisabled(),
    });

    expectPresence(findings, "tools.exec.fs_tools_disabled_but_exec_enabled", false);
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
      plugins: [],
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
        severity: "warn",
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
