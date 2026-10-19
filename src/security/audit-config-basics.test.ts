import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/config.js";
import { collectMinimalProfileOverrideFindings } from "./audit-extra.sync.js";
import { runSecurityAuditCore } from "./audit.js";
import { collectSecurityAuditFindings } from "./audit.test-support.js";

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

describe("security audit config basics", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  async function registryFixture() {
    const stateDir = tempDirs.make("openclaw-audit-mcporter-");
    const configDir = path.join(stateDir, "skills", "config");
    await fs.mkdir(configDir, { recursive: true });
    return { stateDir, registry: path.join(configDir, "mcporter.json") };
  }
  async function expectIncompleteRegistry(stateDir: string) {
    const report = await audit(mcporterConfig(), stateDir);
    const checkIds = report.findings.map((finding) => finding.checkId);
    expect(checkIds).not.toContain("tools.exec.agent_skill_mcp_boundary_drift");
    expect(checkIds).toContain("tools.exec.mcporter_registry_inspection_incomplete");
  }
  function audit(config: OpenClawConfig, stateDir?: string) {
    return runSecurityAuditCore({
      config,
      sourceConfig: {},
      env: stateDir ? { OPENCLAW_STATE_DIR: stateDir } : {},
      ...(stateDir ? { stateDir } : {}),
      includeFilesystem: false,
      includeChannelSecurity: false,
    });
  }

  it("preserves malformed roster defaults through the shared audit helper", async () => {
    const findings = await collectSecurityAuditFindings({
      agents: { entries: { main: {}, ops: {} } },
    });

    expect(findings).toContainEqual(
      expect.objectContaining({
        checkId: "config.agent_roster.invalid_default_count",
        detail: expect.stringContaining("found 0"),
      }),
    );
  });

  it("flags agent profile overrides when global tools.profile is minimal", () => {
    const findings = collectMinimalProfileOverrideFindings({
      tools: { profile: "minimal" },
      agents: { entries: { owner: { tools: { profile: "full" } } } },
    });

    const finding = findings.find((entry) => entry.checkId === "tools.profile_minimal_overridden");
    expect(finding).toMatchObject({
      severity: "warn",
      detail: expect.stringContaining("agents.entries.owner=full"),
    });
  });

  it("flags tools.elevated allowFrom wildcard as critical", async () => {
    const findings = await collectSecurityAuditFindings({
      agents: { entries: { main: {} } },
      tools: { elevated: { allowFrom: { whatsapp: ["*"] } } },
    });

    expect(findings).toContainEqual(
      expect.objectContaining({
        checkId: "tools.elevated.allowFrom.whatsapp.wildcard",
        severity: "critical",
      }),
    );
  });

  it("flags per-agent skill allowlists combined with host exec and a global mcporter registry", async () => {
    const { stateDir, registry } = await registryFixture();
    await fs.writeFile(registry, JSON.stringify({ mcpServers: { "whois-mcp": {} } }), "utf8");

    const report = await audit(mcporterConfig(), stateDir);

    const finding = report.findings.find(
      (entry) => entry.checkId === "tools.exec.agent_skill_mcp_boundary_drift",
    );
    expect(finding).toMatchObject({
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
    const stateDir = tempDirs.make("openclaw-audit-mcp-defaults-");
    const report = await audit(
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

    const finding = report.findings.find(
      (entry) => entry.checkId === "tools.exec.agent_skill_mcp_boundary_drift",
    );
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
    const report = await audit({
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
