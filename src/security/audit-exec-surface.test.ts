import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { saveExecApprovals } from "../infra/exec-approvals-store.test-support.js";
import { captureEnv } from "../test-utils/env.js";
import { collectPluginsTrustFindings } from "./audit-plugins-trust.js";
import { collectSecurityAuditFindings } from "./audit.test-support.js";
import type { SecurityAuditFinding } from "./audit.types.js";

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

describe("security audit exec surface findings", () => {
  // Redirect every home source so approvals never touch the real host state.
  let envSnapshot: ReturnType<typeof captureEnv> | undefined;
  let tempRoot = "";
  let tempCaseIndex = 0;

  beforeAll(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-exec-approvals-"));
  });

  beforeEach(async () => {
    envSnapshot = captureEnv(["OPENCLAW_HOME", "HOME", "USERPROFILE"]);
    const tempDir = path.join(tempRoot, `case-${++tempCaseIndex}`);
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

  afterAll(async () => {
    if (tempRoot) {
      await fs.rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });

  it("warns when exec approvals enable autoAllowSkills", async () => {
    saveExecApprovals({
      version: 1,
      defaults: { autoAllowSkills: true },
      agents: {},
    });

    expect(
      hasFinding(
        "tools.exec.auto_allow_skills_enabled",
        "warn",
        await collectSecurityAuditFindings({}),
      ),
    ).toBe(true);
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

  it("flags open channel access combined with exec-enabled scopes", async () => {
    const findings = await collectSecurityAuditFindings({
      channels: { discord: { groupPolicy: "open" } },
      tools: { exec: { mode: "allowlist", host: "gateway" } },
    });

    expect(hasFinding("security.exposure.open_channels_with_exec", "warn", findings)).toBe(true);
  });

  it("escalates open channel exec exposure when full exec is configured", async () => {
    const findings = await collectSecurityAuditFindings({
      channels: { slack: { dmPolicy: "open" } },
      tools: { exec: { mode: "full" } },
    });

    expect(hasFinding("tools.exec.security_full_configured", "critical", findings)).toBe(true);
    expect(hasFinding("security.exposure.open_channels_with_exec", "critical", findings)).toBe(
      true,
    );
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
    expect(pluginFindings).toContainEqual(
      expect.objectContaining({
        checkId: "plugins.tools_reachable_permissive_policy",
        severity: "warn",
      }),
    );
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
      const finding = findings.find((entry) => entry.checkId === checkId);
      expect(finding, checkId).toBeDefined();
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
    expect(findings).toContainEqual(
      expect.objectContaining({
        checkId: "tools.exec.fs_tools_disabled_but_exec_enabled",
        detail: expect.stringContaining("agents.entries.ops.tools"),
      }),
    );
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
});
