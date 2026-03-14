/**
 * Agent marketplace gateway RPC handlers.
 *
 * Provides browse/installed/health/registries data to the UI
 * by reading agent manifests from the bundled `agents/` directory.
 */
import { readdir, readFile, writeFile, mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { resolveAgentWorkspaceDir } from "../../agents/agent-scope.js";
import {
  loadAgentRegistriesFromDb,
  saveAgentRegistryToDb,
  deleteAgentRegistryFromDb,
  updateAgentRegistrySyncState,
} from "../../agents/registries-sqlite.js";
import {
  deriveAllowAgents,
  detectDrift,
  buildConfigEntryFromManifest,
  applySync,
  type ConfigAgentEntry,
} from "../../config/agent-config-sync.js";
import { loadAgentFromDir } from "../../config/agent-manifest-validation.js";
import { syncRegistry, type RegistryEntry } from "../../config/agent-registry-sync.js";
import { loadBlueprint, deployAgent } from "../../config/agent-workspace-deploy.js";
import { loadConfig, writeConfigFile } from "../../config/config.js";
import type { AgentManifest } from "../../config/zod-schema.agent-manifest.js";
import { AgentManifestSchema } from "../../config/zod-schema.agent-manifest.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";

// Bundled agents directory (relative to compiled output in dist/)
// import.meta.dirname resolves to dist/ in bundled output, so one level up reaches repo root
const BUNDLED_AGENTS_DIR = join(import.meta.dirname, "..", "agents");

interface LoadedAgent {
  manifest: AgentManifest;
  dir: string;
}

/** Directories that are not agent folders. */
const EXCLUDED_DIRS = new Set(["personas", "_archive"]);

async function loadBundledAgents(): Promise<LoadedAgent[]> {
  const agents: LoadedAgent[] = [];
  let entries: { isDirectory(): boolean; name: string }[];
  try {
    entries = await readdir(BUNDLED_AGENTS_DIR, { withFileTypes: true });
  } catch {
    return agents;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || EXCLUDED_DIRS.has(entry.name) || entry.name.startsWith(".")) {
      continue;
    }
    const agentDir = join(BUNDLED_AGENTS_DIR, entry.name);
    // Use loadAgentFromDir which supports both unified AGENT.md and legacy agent.yaml
    const result = await loadAgentFromDir(agentDir);
    if (result.manifest) {
      agents.push({ manifest: result.manifest, dir: agentDir });
    }
  }
  return agents;
}

function agentCategory(m: AgentManifest): string {
  if (m.category) {
    return m.category;
  }
  if (m.tier === 1) {
    return "core";
  }
  if (m.tier === 2) {
    return "department-head";
  }
  return "specialist";
}

export const marketplaceHandlers: GatewayRequestHandlers = {
  "agents.marketplace.browse": async ({ respond }) => {
    const loaded = await loadBundledAgents();
    const agents = loaded
      .filter((a) => !a.manifest.is_bundle)
      .map((a) => ({
        id: a.manifest.id,
        name: a.manifest.name,
        tier: a.manifest.tier,
        role: a.manifest.role,
        department: a.manifest.department,
        version: a.manifest.version,
        description: a.manifest.description,
        capabilities: a.manifest.capabilities ?? [],
        keywords: a.manifest.keywords ?? [],
        category: agentCategory(a.manifest),
        installStatus: "installed",
        requires: a.manifest.requires ?? null,
        deprecated: a.manifest.deprecated ?? false,
        sunset_date: a.manifest.sunset_date ?? null,
        replacement: a.manifest.replacement ?? null,
      }));
    respond(true, { agents }, undefined);
  },

  "agents.marketplace.installed": async ({ respond }) => {
    const loaded = await loadBundledAgents();
    const agents = await Promise.all(
      loaded
        .filter((a) => !a.manifest.is_bundle)
        .map(async (a) => {
          let status: "active" | "disabled" = "active";
          let disableReason: string | undefined;
          try {
            await stat(join(a.dir, ".disabled"));
            status = "disabled";
            disableReason = "Manually disabled";
          } catch {
            // not disabled
          }
          return {
            id: a.manifest.id,
            name: a.manifest.name,
            tier: a.manifest.tier,
            role: a.manifest.role,
            department: a.manifest.department,
            version: a.manifest.version,
            scope: "project" as const,
            status,
            disableReason,
            capabilities: a.manifest.capabilities ?? [],
            requires: a.manifest.requires ?? null,
            deprecated: a.manifest.deprecated ?? false,
            sunset_date: a.manifest.sunset_date ?? null,
            replacement: a.manifest.replacement ?? null,
          };
        }),
    );
    respond(true, { agents }, undefined);
  },

  "agents.marketplace.health": async ({ respond }) => {
    const loaded = await loadBundledAgents();
    const agents = await Promise.all(
      loaded.map(async (a) => {
        const checks: { name: string; ok: boolean; detail?: string; fixType?: string }[] = [];

        // Check agent.yaml exists and is valid
        checks.push({ name: "manifest valid", ok: true });

        // Check AGENT.md exists and quality
        const agentMdPath = join(a.dir, "AGENT.md");
        let hasAgentMd = false;
        let agentMdContent = "";
        try {
          agentMdContent = await readFile(agentMdPath, "utf-8");
          hasAgentMd = agentMdContent.trim().length > 0;
        } catch {
          // missing
        }
        if (!hasAgentMd) {
          checks.push({
            name: "AGENT.md present",
            ok: false,
            detail: "missing prompt file",
            fixType: "missing-prompt",
          });
        } else {
          checks.push({ name: "AGENT.md present", ok: true });
          // Prompt quality check
          const trimmed = agentMdContent.trim();
          if (trimmed.length < 100) {
            checks.push({
              name: "prompt quality",
              ok: false,
              detail: `prompt file too short (${trimmed.length} chars)`,
              fixType: "short-prompt",
            });
          } else if (!/role|responsibilit|you are/i.test(trimmed)) {
            checks.push({
              name: "prompt quality",
              ok: false,
              detail: "missing role description",
              fixType: "short-prompt",
            });
          } else {
            checks.push({ name: "prompt quality", ok: true });
          }
        }

        // Check tier dependencies
        if (a.manifest.requires) {
          const parent = loaded.find((p) => p.manifest.id === a.manifest.requires);
          if (!parent) {
            checks.push({
              name: "dependency met",
              ok: false,
              detail: `missing: ${a.manifest.requires}`,
              fixType: "missing-dependency",
            });
          } else {
            checks.push({
              name: "dependency met",
              ok: true,
              detail: a.manifest.requires,
            });
            // Check if parent is disabled (orphaned specialist)
            let parentDisabled = false;
            try {
              await stat(join(parent.dir, ".disabled"));
              parentDisabled = true;
            } catch {
              // not disabled
            }
            if (parentDisabled) {
              checks.push({
                name: "parent active",
                ok: false,
                detail: `parent ${a.manifest.requires} is disabled`,
                fixType: "enable-parent",
              });
            }
          }
        }

        // Capability coverage check (informational)
        const caps = a.manifest.capabilities ?? [];
        const tools = a.manifest.tools;
        if (caps.length > 0 && !tools?.allow?.length && !tools?.deny?.length) {
          checks.push({
            name: "capability coverage",
            ok: false,
            detail: `${caps.length} capabilities declared but no tools configured`,
          });
        }

        // Deprecation check
        if (a.manifest.deprecated) {
          const sunset = a.manifest.sunset_date;
          let detail = "deprecated";
          let ok = false;
          if (sunset) {
            const sunsetDate = new Date(sunset);
            const now = new Date();
            const daysLeft = Math.ceil(
              (sunsetDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24),
            );
            if (daysLeft < 0) {
              detail = `past sunset date (${sunset})`;
            } else {
              detail = `sunset in ${daysLeft} days (${sunset})`;
            }
          }
          if (a.manifest.replacement) {
            detail += ` — use ${a.manifest.replacement} instead`;
          }
          checks.push({
            name: "not deprecated",
            ok,
            detail,
            fixType: a.manifest.replacement ? "deprecated-replace" : undefined,
          });
        }

        const allOk = checks.every((c) => c.ok);
        const someOk = checks.some((c) => c.ok);
        const status = allOk ? "healthy" : someOk ? "degraded" : "error";

        return {
          id: a.manifest.id,
          name: a.manifest.name,
          version: a.manifest.version,
          tier: a.manifest.tier,
          scope: "project",
          checks,
          status,
        };
      }),
    );

    // ── Config sync checks ────────────────────────────────────────────────
    // Compare YAML manifests against config agents.list to detect drift
    let configSyncIssues: {
      agentId: string;
      check: string;
      status: "warn" | "fail";
      message: string;
      fixType?: string;
    }[] = [];
    try {
      const cfg = loadConfig();
      const configEntries = (cfg.agents?.list ?? []) as ConfigAgentEntry[];
      const allManifests = loaded.map((a) => a.manifest);
      const nonBundles = allManifests.filter((m) => !m.is_bundle);
      const derived = deriveAllowAgents(nonBundles);
      const drift = detectDrift(nonBundles, configEntries, derived);

      for (const issue of drift.issues) {
        const status =
          issue.type === "missing_config_entry" ? ("fail" as const) : ("warn" as const);
        const fixType =
          issue.type === "missing_config_entry"
            ? "add-config-entry"
            : issue.type === "department_mismatch"
              ? "sync-config-field"
              : issue.type === "role_mismatch"
                ? "sync-config-field"
                : issue.type === "name_mismatch"
                  ? "sync-config-field"
                  : issue.type === "allow_agents_incomplete"
                    ? "sync-allow-agents"
                    : issue.type === "orphaned_config_entry"
                      ? "remove-orphaned"
                      : undefined;
        configSyncIssues.push({
          agentId: issue.agentId,
          check: `config_sync: ${issue.type}`,
          status,
          message: issue.message,
          fixType,
        });
      }
    } catch {
      // Config not available — skip sync checks silently
    }

    // ── Workspace deploy status ─────────────────────────────────────────
    let deployStatus: {
      agentId: string;
      deployed: boolean;
      currentVersion: string | null;
      manifestVersion: string;
      needsUpgrade: boolean;
      workspaceExists: boolean;
    }[] = [];
    try {
      const { checkDeployStatus } = await import("../../config/agent-workspace-deploy.js");
      const cfg = loadConfig();
      const nonBundleAgents = loaded.filter((a) => !a.manifest.is_bundle);

      deployStatus = await Promise.all(
        nonBundleAgents.map(async (a) => {
          const blueprint = await loadBlueprint(a.dir);
          if (!blueprint) {
            return {
              agentId: a.manifest.id,
              deployed: false,
              currentVersion: null,
              manifestVersion: a.manifest.version,
              needsUpgrade: false,
              workspaceExists: false,
            };
          }
          const configId = a.manifest.id === "operator1" ? "main" : a.manifest.id;
          const workspaceDir = resolveAgentWorkspaceDir(cfg, configId);
          return { agentId: a.manifest.id, ...(await checkDeployStatus(blueprint, workspaceDir)) };
        }),
      );
    } catch {
      // Deploy status check failure is non-fatal
    }

    respond(true, { agents, configSyncIssues, deployStatus }, undefined);
  },

  "agents.marketplace.health.fix": async ({ params, respond }) => {
    const agentId = typeof params.agentId === "string" ? params.agentId.trim() : "";
    const fixType = typeof params.fixType === "string" ? params.fixType.trim() : "";
    const preview = params.preview === true;

    if (!agentId || !fixType) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "agentId and fixType are required"),
      );
      return;
    }

    const loaded = await loadBundledAgents();
    const agent = loaded.find((a) => a.manifest.id === agentId);
    if (!agent) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `agent "${agentId}" not found`),
      );
      return;
    }

    const m = agent.manifest;

    // ── Fix: missing-prompt — generate AGENT.md from manifest ──────────
    if (fixType === "missing-prompt" || fixType === "short-prompt") {
      // Gather context from sibling agents in same department
      const siblings = loaded
        .filter((a) => a.manifest.department === m.department && a.manifest.id !== m.id)
        .slice(0, 2);
      const siblingRoles = siblings
        .map((s) => `- ${s.manifest.name}: ${s.manifest.role}`)
        .join("\n");

      const tierDesc =
        m.tier === 1
          ? "You are a **core orchestrator** — the top-level coordinator. You delegate to department heads and synthesize results."
          : m.tier === 2
            ? "You are a **department head** — a tactical leader. You receive directives from the core agent and delegate to specialists in your department."
            : "You are a **specialist** — a focused executor. You receive specific tasks from your department head and deliver results.";

      const capsSection =
        (m.capabilities ?? []).length > 0
          ? [
              "## Core Competencies",
              "",
              ...(m.capabilities ?? []).map((c) => `- ${c.replace(/_/g, " ")}`),
            ]
          : [];

      const hierarchySection: string[] = [];
      if (m.requires) {
        hierarchySection.push(
          `- Escalate decisions outside your scope to your department head (**${m.requires}**)`,
        );
        hierarchySection.push("- Accept and execute tasks routed from your department head");
      }
      const dependents = loaded.filter((a) => a.manifest.requires === m.id);
      if (dependents.length > 0) {
        hierarchySection.push(
          `- Coordinate and delegate to your specialists: ${dependents.map((d) => `**${d.manifest.name}**`).join(", ")}`,
        );
        hierarchySection.push(
          "- Route incoming tasks to the most appropriate specialist based on their expertise",
        );
      }

      const content = [
        `# ${m.name}`,
        "",
        `You are **${m.name}**, the ${m.role} in the **${m.department}** department.`,
        "",
        tierDesc,
        "",
        "## Responsibilities",
        "",
        m.description,
        "",
        ...capsSection,
        ...(capsSection.length > 0 ? [""] : []),
        "## Guidelines",
        "",
        `- Focus on your area of expertise within the ${m.department} department`,
        "- Provide thorough, well-structured analysis and recommendations",
        "- Collaborate with other agents when tasks cross department boundaries",
        "- Report progress and blockers clearly",
        ...hierarchySection,
        "",
        ...(siblingRoles
          ? ["## Team Context", "", `Other agents in **${m.department}**:`, siblingRoles, ""]
          : []),
        "## Communication Style",
        "",
        "- Be concise and actionable",
        "- Use domain-specific terminology appropriately",
        "- Structure responses with clear sections when addressing complex topics",
        "",
      ].join("\n");

      if (preview) {
        respond(true, { success: true, fixType, preview: content, applied: false }, undefined);
        return;
      }

      // For short-prompt, read existing and append if meaningful
      if (fixType === "short-prompt") {
        let existing = "";
        try {
          existing = await readFile(join(agent.dir, "AGENT.md"), "utf-8");
        } catch {
          // missing — will just use generated
        }
        // If existing has some content, preserve it and append generated sections
        if (existing.trim().length > 20) {
          const merged = existing.trim() + "\n\n---\n\n" + content;
          await writeFile(join(agent.dir, "AGENT.md"), merged, "utf-8");
          respond(true, { success: true, fixType, preview: merged, applied: true }, undefined);
          return;
        }
      }

      await writeFile(join(agent.dir, "AGENT.md"), content, "utf-8");
      respond(true, { success: true, fixType, preview: content, applied: true }, undefined);
      return;
    }

    // ── Fix: missing-dependency — install missing parent agent ──────────
    if (fixType === "missing-dependency") {
      const parentId = m.requires;
      if (!parentId) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "agent has no requires field"),
        );
        return;
      }
      // Check if parent already exists (maybe installed since last health check)
      const parent = loaded.find((a) => a.manifest.id === parentId);
      if (parent) {
        respond(
          true,
          { success: true, fixType, detail: `parent "${parentId}" already exists`, applied: false },
          undefined,
        );
        return;
      }
      // Cannot install — parent must be provided in the bundled agents directory
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `parent agent "${parentId}" not found in any registry. Create it manually or add it from a registry.`,
        ),
      );
      return;
    }

    // ── Fix: invalid-manifest — correct agent.yaml schema issues ───────
    if (fixType === "invalid-manifest") {
      const yamlPath = join(agent.dir, "agent.yaml");
      let rawContent: string;
      try {
        rawContent = await readFile(yamlPath, "utf-8");
      } catch {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "cannot read agent.yaml"));
        return;
      }
      const parsed = parseYaml(rawContent) as Record<string, unknown>;
      const result = AgentManifestSchema.safeParse(parsed);
      if (result.success) {
        respond(
          true,
          { success: true, fixType, detail: "manifest is already valid", applied: false },
          undefined,
        );
        return;
      }

      // Auto-fix common issues
      const fixed = { ...parsed };
      for (const issue of result.error.issues) {
        const path = issue.path.join(".");
        if (path === "tier" && !fixed.tier) {
          fixed.tier = 2;
        }
        if (path === "version" && !fixed.version) {
          fixed.version = "1.0.0";
        }
        if (path === "role" && !fixed.role) {
          fixed.role = fixed.name ? `${fixed.name as string} agent` : "Agent";
        }
        if (path === "department" && !fixed.department) {
          fixed.department = "general";
        }
        if (path === "description" && !fixed.description) {
          fixed.description = fixed.role ?? "An agent";
        }
        if (path === "requires" && fixed.tier === 1) {
          delete fixed.requires;
        }
      }

      const revalidated = AgentManifestSchema.safeParse(fixed);
      const fixedYaml = stringifyYaml(fixed);

      if (preview) {
        respond(
          true,
          {
            success: revalidated.success,
            fixType,
            preview: fixedYaml,
            applied: false,
            ...(revalidated.success
              ? {}
              : { error: `still invalid: ${revalidated.error?.issues[0]?.message}` }),
          },
          undefined,
        );
        return;
      }

      if (!revalidated.success) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `auto-fix could not resolve all issues: ${revalidated.error.issues[0]?.message}`,
          ),
        );
        return;
      }

      await writeFile(yamlPath, fixedYaml, "utf-8");
      respond(true, { success: true, fixType, preview: fixedYaml, applied: true }, undefined);
      return;
    }

    // ── Fix: enable-parent — re-enable a disabled parent agent ─────────
    if (fixType === "enable-parent") {
      const parentId = m.requires;
      if (!parentId) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "agent has no parent"));
        return;
      }
      const disabledMarker = join(BUNDLED_AGENTS_DIR, parentId, ".disabled");
      try {
        await rm(disabledMarker);
      } catch {
        // already enabled
      }
      respond(
        true,
        { success: true, fixType, detail: `enabled parent "${parentId}"`, applied: true },
        undefined,
      );
      return;
    }

    // ── Fix: deprecated-replace — install replacement agent ────────────
    if (fixType === "deprecated-replace") {
      const replacement = m.replacement;
      if (!replacement) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "agent has no replacement specified"),
        );
        return;
      }
      const existing = loaded.find((a) => a.manifest.id === replacement);
      if (existing) {
        // Disable deprecated agent
        await writeFile(join(agent.dir, ".disabled"), new Date().toISOString(), "utf-8");
        respond(
          true,
          {
            success: true,
            fixType,
            detail: `replacement "${replacement}" already installed, deprecated agent disabled`,
            applied: true,
          },
          undefined,
        );
        return;
      }
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `replacement agent "${replacement}" not found. Install it first.`,
        ),
      );
      return;
    }

    // ── Fix: add-config-entry — create config entry from manifest ──────
    if (fixType === "add-config-entry") {
      try {
        const cfg = loadConfig();
        const configEntries = (cfg.agents?.list ?? []) as ConfigAgentEntry[];
        const allManifests = loaded.map((a) => a.manifest);
        const nonBundles = allManifests.filter((m2) => !m2.is_bundle);
        const derived = deriveAllowAgents(nonBundles);
        const configId = m.id === "operator1" ? "main" : m.id;

        const existingEntry = configEntries.find((e) => e.id === configId);
        if (existingEntry) {
          respond(
            true,
            {
              success: true,
              fixType,
              detail: `config entry for "${configId}" already exists`,
              applied: false,
            },
            undefined,
          );
          return;
        }

        const allowAgents = (derived.get(m.id) ?? []).map((id) =>
          id === "operator1" ? "main" : id,
        );
        const newEntry = buildConfigEntryFromManifest(m, allowAgents);
        newEntry.id = configId;

        if (preview) {
          respond(
            true,
            { success: true, fixType, preview: JSON.stringify(newEntry, null, 2), applied: false },
            undefined,
          );
          return;
        }

        const updatedList = [...configEntries, newEntry];
        const updatedConfig = { ...cfg, agents: { ...cfg.agents, list: updatedList } };
        await writeConfigFile(updatedConfig);
        respond(
          true,
          { success: true, fixType, detail: `added config entry for "${configId}"`, applied: true },
          undefined,
        );
      } catch (err) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INTERNAL_ERROR,
            `failed to add config entry: ${(err as Error).message}`,
          ),
        );
      }
      return;
    }

    // ── Fix: sync-config-field — update department/role/name in config ───
    if (fixType === "sync-config-field") {
      try {
        const cfg = loadConfig();
        const configEntries = (cfg.agents?.list ?? []) as ConfigAgentEntry[];
        const configId = m.id === "operator1" ? "main" : m.id;
        const entryIdx = configEntries.findIndex((e) => e.id === configId);

        if (entryIdx < 0) {
          respond(
            false,
            undefined,
            errorShape(ErrorCodes.INVALID_REQUEST, `no config entry for "${configId}"`),
          );
          return;
        }

        const updated = {
          ...configEntries[entryIdx],
          department: m.department,
          role: m.role,
          name: m.name,
        };

        if (preview) {
          respond(
            true,
            { success: true, fixType, preview: JSON.stringify(updated, null, 2), applied: false },
            undefined,
          );
          return;
        }

        configEntries[entryIdx] = updated;
        const updatedConfig = { ...cfg, agents: { ...cfg.agents, list: configEntries } };
        await writeConfigFile(updatedConfig);
        respond(
          true,
          { success: true, fixType, detail: `synced fields for "${configId}"`, applied: true },
          undefined,
        );
      } catch (err) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INTERNAL_ERROR, `failed to sync config: ${(err as Error).message}`),
        );
      }
      return;
    }

    // ── Fix: sync-allow-agents — rebuild allowAgents from tier/requires ──
    if (fixType === "sync-allow-agents") {
      try {
        const cfg = loadConfig();
        const configEntries = (cfg.agents?.list ?? []) as ConfigAgentEntry[];
        const allManifests = loaded.map((a) => a.manifest);
        const nonBundles = allManifests.filter((m2) => !m2.is_bundle);
        const derived = deriveAllowAgents(nonBundles);
        const configId = m.id === "operator1" ? "main" : m.id;
        const entryIdx = configEntries.findIndex((e) => e.id === configId);

        if (entryIdx < 0) {
          respond(
            false,
            undefined,
            errorShape(ErrorCodes.INVALID_REQUEST, `no config entry for "${configId}"`),
          );
          return;
        }

        const allowAgents = (derived.get(m.id) ?? []).map((id) =>
          id === "operator1" ? "main" : id,
        );
        const updated = {
          ...configEntries[entryIdx],
          subagents: { ...configEntries[entryIdx].subagents, allowAgents },
        };

        if (preview) {
          respond(
            true,
            {
              success: true,
              fixType,
              preview: JSON.stringify(updated.subagents, null, 2),
              applied: false,
            },
            undefined,
          );
          return;
        }

        configEntries[entryIdx] = updated;
        const updatedConfig = { ...cfg, agents: { ...cfg.agents, list: configEntries } };
        await writeConfigFile(updatedConfig);
        respond(
          true,
          { success: true, fixType, detail: `synced allowAgents for "${configId}"`, applied: true },
          undefined,
        );
      } catch (err) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INTERNAL_ERROR,
            `failed to sync allowAgents: ${(err as Error).message}`,
          ),
        );
      }
      return;
    }

    // ── Fix: sync-all — apply full sync for all agents ──────────────────
    if (fixType === "sync-all") {
      try {
        const cfg = loadConfig();
        const configEntries = (cfg.agents?.list ?? []) as ConfigAgentEntry[];
        const allManifests = loaded.map((a) => a.manifest);
        const nonBundles = allManifests.filter((m2) => !m2.is_bundle);
        const derived = deriveAllowAgents(nonBundles);
        const drift = detectDrift(nonBundles, configEntries, derived);

        if (!drift.hasDrift) {
          respond(
            true,
            { success: true, fixType, detail: "no drift detected", applied: false },
            undefined,
          );
          return;
        }

        const synced = applySync(nonBundles, configEntries, drift);

        if (preview) {
          respond(
            true,
            {
              success: true,
              fixType,
              preview: JSON.stringify(
                {
                  issueCount: drift.issues.length,
                  missingAdded: drift.missingInConfig.length,
                  fieldsUpdated: drift.issues.filter((i) => i.type.endsWith("_mismatch")).length,
                },
                null,
                2,
              ),
              applied: false,
            },
            undefined,
          );
          return;
        }

        const updatedConfig = { ...cfg, agents: { ...cfg.agents, list: synced } };
        await writeConfigFile(updatedConfig);
        respond(
          true,
          {
            success: true,
            fixType,
            detail: `synced ${drift.issues.length} issues (${drift.missingInConfig.length} added, ${drift.orphanedInConfig.length} orphaned)`,
            applied: true,
          },
          undefined,
        );
      } catch (err) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INTERNAL_ERROR, `sync failed: ${(err as Error).message}`),
        );
      }
      return;
    }

    // ── Fix: deploy-workspace — deploy/redeploy agent workspace files ──
    if (fixType === "deploy-workspace") {
      try {
        const blueprint = await loadBlueprint(agent.dir);
        if (!blueprint) {
          respond(
            false,
            undefined,
            errorShape(ErrorCodes.INVALID_REQUEST, "cannot load agent blueprint"),
          );
          return;
        }
        const cfg = loadConfig();
        const configId = m.id === "operator1" ? "main" : m.id;
        const workspaceDir = resolveAgentWorkspaceDir(cfg, configId);

        if (preview) {
          const { checkDeployStatus } = await import("../../config/agent-workspace-deploy.js");
          const status = await checkDeployStatus(blueprint, workspaceDir);
          respond(
            true,
            { success: true, fixType, preview: JSON.stringify(status, null, 2), applied: false },
            undefined,
          );
          return;
        }

        const result = await deployAgent(blueprint, workspaceDir, { force: true });
        respond(
          true,
          {
            success: true,
            fixType,
            detail: `deployed ${result.filesWritten.length} files to ${workspaceDir}`,
            applied: true,
            filesWritten: result.filesWritten,
            version: result.version,
          },
          undefined,
        );
      } catch (err) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INTERNAL_ERROR, `deploy failed: ${(err as Error).message}`),
        );
      }
      return;
    }

    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, `unknown fixType: ${fixType}`),
    );
  },

  "agents.marketplace.registries": async ({ respond }) => {
    const loaded = await loadBundledAgents();
    const bundledRegistry = {
      id: "operator1",
      name: "Built-in Agents",
      url: "",
      description: "Agents bundled with Operator1",
      visibility: "public" as const,
      enabled: true,
      agentCount: loaded.length,
      lastSynced: "bundled",
      bundled: true,
    };
    const userRegistries = loadAgentRegistriesFromDb();
    const all = [bundledRegistry, ...userRegistries.map((r) => ({ ...r, bundled: false }))];
    respond(true, { registries: all }, undefined);
  },

  // ── CRUD operations ───────────────────────────────────────────────────────

  "agents.marketplace.get": async ({ params, respond }) => {
    const agentId = typeof params.agentId === "string" ? params.agentId.trim() : "";
    if (!agentId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "agentId is required"));
      return;
    }
    const loaded = await loadBundledAgents();
    const agent = loaded.find((a) => a.manifest.id === agentId);
    if (!agent) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `agent "${agentId}" not found`),
      );
      return;
    }
    // Read AGENT.md if present
    let promptContent = "";
    try {
      promptContent = await readFile(join(agent.dir, "AGENT.md"), "utf-8");
    } catch {
      // no prompt file
    }
    const m = agent.manifest;
    respond(
      true,
      {
        agent: {
          id: m.id,
          name: m.name,
          tier: m.tier,
          role: m.role,
          department: m.department,
          version: m.version,
          description: m.description,
          capabilities: m.capabilities ?? [],
          keywords: m.keywords ?? [],
          category: agentCategory(m),
          requires: m.requires ?? null,
          model: m.model ?? null,
          tools: m.tools ?? null,
          routing_hints: m.routing_hints ?? null,
          limits: m.limits ?? null,
          skills: m.skills ?? [],
          author: m.author ?? null,
          deprecated: m.deprecated ?? false,
          installStatus: "installed",
          promptContent,
        },
      },
      undefined,
    );
  },

  "agents.marketplace.update": async ({ params, respond }) => {
    const agentId = typeof params.agentId === "string" ? params.agentId.trim() : "";
    if (!agentId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "agentId is required"));
      return;
    }
    const agentDir = join(BUNDLED_AGENTS_DIR, agentId);
    const yamlPath = join(agentDir, "agent.yaml");
    let content: string;
    try {
      content = await readFile(yamlPath, "utf-8");
    } catch {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `agent "${agentId}" not found`),
      );
      return;
    }
    const existing = parseYaml(content) as Record<string, unknown>;

    // Merge updatable fields
    const updatable = [
      "name",
      "role",
      "description",
      "department",
      "capabilities",
      "keywords",
      "skills",
    ] as const;
    for (const key of updatable) {
      if (params[key] !== undefined) {
        existing[key] = params[key];
      }
    }
    // Nested objects: model, tools, routing_hints, limits
    if (params.model !== undefined) {
      existing.model = params.model;
    }
    if (params.tools !== undefined) {
      existing.tools = params.tools;
    }
    if (params.routing_hints !== undefined) {
      existing.routing_hints = params.routing_hints;
    }
    if (params.limits !== undefined) {
      existing.limits = params.limits;
    }

    // Validate merged manifest
    const result = AgentManifestSchema.safeParse(existing);
    if (!result.success) {
      const issue = result.error.issues[0];
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `validation error: ${issue?.message ?? "unknown"}`),
      );
      return;
    }

    await writeFile(yamlPath, stringifyYaml(existing), "utf-8");

    // Update AGENT.md if provided
    if (typeof params.promptContent === "string") {
      await writeFile(join(agentDir, "AGENT.md"), params.promptContent, "utf-8");
    }

    // Sync updated fields to config
    try {
      const validatedManifest = result.data;
      const cfg = loadConfig();
      const configEntries = (cfg.agents?.list ?? []) as ConfigAgentEntry[];
      const configId = validatedManifest.id === "operator1" ? "main" : validatedManifest.id;
      const entryIdx = configEntries.findIndex((e) => e.id === configId);

      if (entryIdx >= 0) {
        const allLoaded = await loadBundledAgents();
        const nonBundles = allLoaded.map((a) => a.manifest).filter((m2) => !m2.is_bundle);
        const derived = deriveAllowAgents(nonBundles);
        const allowAgents = (derived.get(validatedManifest.id) ?? []).map((id) =>
          id === "operator1" ? "main" : id,
        );
        configEntries[entryIdx] = buildConfigEntryFromManifest(
          validatedManifest,
          allowAgents,
          configEntries[entryIdx],
        );
        configEntries[entryIdx].id = configId;
        await writeConfigFile({ ...cfg, agents: { ...cfg.agents, list: configEntries } });
      }
    } catch {
      // Config sync failure is non-fatal
    }

    respond(true, { ok: true, agentId }, undefined);
  },

  "agents.marketplace.remove": async ({ params, respond }) => {
    const agentId = typeof params.agentId === "string" ? params.agentId.trim() : "";
    if (!agentId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "agentId is required"));
      return;
    }
    if (agentId === "operator1") {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "cannot remove the core operator1 agent"),
      );
      return;
    }
    const loaded = await loadBundledAgents();
    const agent = loaded.find((a) => a.manifest.id === agentId);
    if (!agent) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `agent "${agentId}" not found`),
      );
      return;
    }

    // Check for dependents
    const dependents = loaded.filter((a) => a.manifest.requires === agentId);
    const cascade = params.cascade === true;

    if (dependents.length > 0 && !cascade) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `agent "${agentId}" has ${dependents.length} dependent(s): ${dependents.map((d) => d.manifest.id).join(", ")}. Set cascade=true to remove them.`,
        ),
      );
      return;
    }

    // Remove dependents first if cascading
    const removed: string[] = [];
    if (cascade) {
      for (const dep of dependents) {
        await rm(dep.dir, { recursive: true, force: true });
        removed.push(dep.manifest.id);
      }
    }

    await rm(agent.dir, { recursive: true, force: true });
    removed.push(agentId);

    // Remove from config and update parent allowAgents
    try {
      const cfg = loadConfig();
      const configEntries = (cfg.agents?.list ?? []) as ConfigAgentEntry[];
      const removedConfigIds = new Set(removed.map((id) => (id === "operator1" ? "main" : id)));
      const filtered = configEntries.filter((e) => !removedConfigIds.has(e.id));

      // Rebuild allowAgents for remaining agents (removed agents should no longer appear)
      const remainingLoaded = await loadBundledAgents();
      const remainingManifests = remainingLoaded
        .map((a) => a.manifest)
        .filter((m2) => !m2.is_bundle);
      const derived = deriveAllowAgents(remainingManifests);

      for (const entry of filtered) {
        const manifestId = entry.id === "main" ? "operator1" : entry.id;
        const newAllow = (derived.get(manifestId) ?? []).map((id) =>
          id === "operator1" ? "main" : id,
        );
        if (entry.subagents?.allowAgents) {
          entry.subagents = { ...entry.subagents, allowAgents: newAllow };
        }
      }

      await writeConfigFile({ ...cfg, agents: { ...cfg.agents, list: filtered } });
    } catch {
      // Config sync failure is non-fatal
    }

    respond(true, { ok: true, removed }, undefined);
  },

  "agents.marketplace.disable": async ({ params, respond }) => {
    const agentId = typeof params.agentId === "string" ? params.agentId.trim() : "";
    if (!agentId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "agentId is required"));
      return;
    }
    const agentDir = join(BUNDLED_AGENTS_DIR, agentId);
    const disabledMarker = join(agentDir, ".disabled");
    try {
      await stat(join(agentDir, "agent.yaml"));
    } catch {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `agent "${agentId}" not found`),
      );
      return;
    }
    await writeFile(disabledMarker, new Date().toISOString(), "utf-8");
    respond(true, { ok: true, agentId, status: "disabled" }, undefined);
  },

  "agents.marketplace.enable": async ({ params, respond }) => {
    const agentId = typeof params.agentId === "string" ? params.agentId.trim() : "";
    if (!agentId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "agentId is required"));
      return;
    }
    const disabledMarker = join(BUNDLED_AGENTS_DIR, agentId, ".disabled");
    try {
      await rm(disabledMarker);
    } catch {
      // Already enabled or agent not found — either way, idempotent
    }
    respond(true, { ok: true, agentId, status: "active" }, undefined);
  },

  "agents.marketplace.generate": async ({ params, respond }) => {
    const agentId = typeof params.agentId === "string" ? params.agentId.trim() : "";
    const name = typeof params.name === "string" ? params.name.trim() : "";
    const role = typeof params.role === "string" ? params.role.trim() : "";
    const tier = typeof params.tier === "number" ? params.tier : 3;
    const department = typeof params.department === "string" ? params.department.trim() : "";
    const parentAgent = typeof params.parentAgent === "string" ? params.parentAgent.trim() : null;
    const description = typeof params.description === "string" ? params.description.trim() : "";
    const preferredModel =
      typeof params.preferredModel === "string" ? params.preferredModel.trim() : "";
    const toolsAllow = Array.isArray(params.toolsAllow) ? (params.toolsAllow as string[]) : null;
    const toolsDeny = Array.isArray(params.toolsDeny) ? (params.toolsDeny as string[]) : null;

    if (!agentId || !name || !role || !department || !description) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "agentId, name, role, department, and description are required",
        ),
      );
      return;
    }

    // Load existing agents in same department as few-shot references
    const loaded = await loadBundledAgents();
    const sameDepth = loaded.filter((a) => a.manifest.department === department).slice(0, 2);

    // Extract keywords from description
    const stopWords = new Set([
      "the",
      "a",
      "an",
      "and",
      "or",
      "but",
      "in",
      "on",
      "at",
      "to",
      "for",
      "of",
      "is",
      "are",
      "was",
      "were",
      "be",
      "been",
      "being",
      "have",
      "has",
      "had",
      "do",
      "does",
      "did",
      "will",
      "would",
      "could",
      "should",
      "may",
      "might",
      "shall",
      "can",
      "who",
      "that",
      "this",
      "with",
      "from",
      "by",
      "as",
      "not",
      "no",
      "their",
      "them",
      "they",
      "it",
      "its",
    ]);
    const words = description
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, "")
      .split(/\s+/)
      .filter((w) => w.length > 3 && !stopWords.has(w));
    const wordFreq = new Map<string, number>();
    for (const w of words) {
      wordFreq.set(w, (wordFreq.get(w) ?? 0) + 1);
    }
    const topKeywords = [...wordFreq.entries()]
      .toSorted((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([w]) => w);

    // Derive capabilities from keywords and description
    const capabilities = topKeywords.slice(0, 5).map((k) => k.replace(/\s+/g, "_"));

    // Build model section
    const model = preferredModel || (sameDepth[0]?.manifest.model?.primary ?? "claude-sonnet-4-6");
    const provider = sameDepth[0]?.manifest.model?.provider ?? "anthropic";

    // Build tools section
    const toolsSection = [];
    if (toolsAllow || toolsDeny) {
      toolsSection.push("tools:");
      if (toolsAllow && toolsAllow.length > 0) {
        toolsSection.push("  allow:");
        for (const t of toolsAllow) {
          toolsSection.push(`    - ${t}`);
        }
      }
      if (toolsDeny && toolsDeny.length > 0) {
        toolsSection.push("  deny:");
        for (const t of toolsDeny) {
          toolsSection.push(`    - ${t}`);
        }
      }
    } else if (sameDepth[0]?.manifest.tools) {
      // Inherit tools from a same-department agent
      toolsSection.push("tools:");
      if (sameDepth[0].manifest.tools.allow) {
        toolsSection.push("  allow:");
        for (const t of sameDepth[0].manifest.tools.allow) {
          toolsSection.push(`    - ${t}`);
        }
      }
    }

    const manifest = [
      `id: ${agentId}`,
      `name: ${name}`,
      `tier: ${tier}`,
      `role: ${role}`,
      `department: ${department}`,
      `description: ${description.split("\n")[0]}`,
      `version: 1.0.0`,
      "",
      ...(parentAgent ? [`requires: ${parentAgent}`, ""] : []),
      `model:`,
      `  provider: ${provider}`,
      `  primary: ${model}`,
      `  fallbacks:`,
      `    - claude-sonnet-4-6`,
      "",
      ...(toolsSection.length > 0 ? [...toolsSection, ""] : []),
      `capabilities:`,
      ...capabilities.map((c) => `  - ${c}`),
      "",
      `routing_hints:`,
      `  keywords:`,
      ...topKeywords.map((k) => `    - ${k}`),
      `  priority: normal`,
      ...(capabilities.length > 0
        ? [`  preferred_for:`, ...capabilities.slice(0, 3).map((c) => `    - ${c}`)]
        : []),
      "",
      `skills:`,
      `  - coding-agent`,
      "",
      `limits:`,
      `  timeout_seconds: 300`,
      `  cost_limit_usd: 0.50`,
      `  context_window_tokens: 100000`,
      "",
      `author:`,
      `  name: User`,
      "",
      `keywords:`,
      ...topKeywords.slice(0, 6).map((k) => `  - ${k}`),
      `category: ${tier === 1 ? "core" : tier === 2 ? "department-head" : "specialist"}`,
    ].join("\n");

    const promptContent = [
      `# ${name}`,
      "",
      `You are **${name}**, the ${role} in the ${department} department.`,
      "",
      "## Responsibilities",
      "",
      description,
      "",
      "## Core Competencies",
      "",
      ...capabilities.map((c) => `- ${c.replace(/_/g, " ")}`),
      "",
      "## Guidelines",
      "",
      `- Focus on your area of expertise within ${department}`,
      "- Provide thorough, well-structured analysis and recommendations",
      "- Collaborate with other agents when tasks cross department boundaries",
      "- Report progress and blockers clearly",
      ...(parentAgent
        ? [
            `- Escalate decisions outside your scope to your department head (${parentAgent})`,
            "- Follow the delegation chain — accept tasks routed from your department head",
          ]
        : [
            "- Coordinate specialist agents under your department",
            "- Route tasks to the most appropriate specialist",
          ]),
      "",
      "## Communication Style",
      "",
      "- Be concise and actionable",
      "- Use domain-specific terminology appropriately",
      "- Structure responses with clear sections when addressing complex topics",
    ].join("\n");

    respond(true, { manifest, promptContent }, undefined);
  },

  // ── Deprecation warnings ────────────────────────────────────────────────

  // Deprecation info is returned as part of browse, installed, get handlers.
  // No separate RPC needed — the UI reads `deprecated`, `sunset_date`,
  // `replacement` from the agent manifest fields already returned.

  "agents.marketplace.create": async ({ params, respond }) => {
    const agentId = typeof params.agentId === "string" ? params.agentId.trim() : "";
    if (!agentId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "agentId is required"));
      return;
    }
    if (!/^[a-z0-9-]+$/.test(agentId)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "agentId must be lowercase alphanumeric with hyphens",
        ),
      );
      return;
    }

    // Check for existing agent (unified AGENT.md or legacy agent.yaml)
    const agentDir = join(BUNDLED_AGENTS_DIR, agentId);
    const agentExists =
      (await stat(join(agentDir, "AGENT.md")).catch(() => null)) ??
      (await stat(join(agentDir, "agent.yaml")).catch(() => null));
    if (agentExists) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `agent "${agentId}" already exists`),
      );
      return;
    }

    // Validate manifest
    if (typeof params.manifest !== "string") {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "manifest (YAML string) is required"),
      );
      return;
    }
    let parsed: unknown;
    try {
      parsed = parseYaml(params.manifest);
    } catch {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "invalid YAML in manifest"));
      return;
    }
    const result = AgentManifestSchema.safeParse(parsed);
    if (!result.success) {
      const issue = result.error.issues[0];
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `manifest validation error: ${issue?.message ?? "unknown"}`,
        ),
      );
      return;
    }
    if (result.data.id !== agentId) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `manifest id "${result.data.id}" does not match agentId "${agentId}"`,
        ),
      );
      return;
    }

    // Check tier dependency exists
    if (result.data.requires) {
      const loaded = await loadBundledAgents();
      const parent = loaded.find((a) => a.manifest.id === result.data.requires);
      if (!parent) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `required parent agent "${result.data.requires}" not found`,
          ),
        );
        return;
      }
    }

    // Write files — support both unified AGENT.md and legacy agent.yaml + AGENT.md
    await mkdir(agentDir, { recursive: true });
    if (typeof params.unifiedAgentMd === "string" && params.unifiedAgentMd.trim()) {
      // Unified format: single AGENT.md with YAML frontmatter
      await writeFile(join(agentDir, "AGENT.md"), params.unifiedAgentMd, "utf-8");
    } else {
      // Legacy format: separate agent.yaml + AGENT.md
      await writeFile(join(agentDir, "agent.yaml"), params.manifest, "utf-8");
      if (typeof params.promptContent === "string" && params.promptContent.trim()) {
        await writeFile(join(agentDir, "AGENT.md"), params.promptContent, "utf-8");
      }
    }

    // Sync to config: add config entry for the new agent
    try {
      const allLoaded = await loadBundledAgents();
      const allManifests = allLoaded.map((a) => a.manifest);
      const nonBundles = allManifests.filter((m2) => !m2.is_bundle);
      const derived = deriveAllowAgents(nonBundles);
      const configId = result.data.id === "operator1" ? "main" : result.data.id;
      const allowAgents = (derived.get(result.data.id) ?? []).map((id) =>
        id === "operator1" ? "main" : id,
      );
      const newEntry = buildConfigEntryFromManifest(result.data, allowAgents);
      newEntry.id = configId;

      const cfg = loadConfig();
      const configEntries = (cfg.agents?.list ?? []) as ConfigAgentEntry[];
      if (!configEntries.find((e) => e.id === configId)) {
        configEntries.push(newEntry);
        await writeConfigFile({ ...cfg, agents: { ...cfg.agents, list: configEntries } });
      }

      // Also update parent's allowAgents if this agent has a parent
      if (result.data.requires) {
        const parentConfigId = result.data.requires === "operator1" ? "main" : result.data.requires;
        const parentIdx = configEntries.findIndex((e) => e.id === parentConfigId);
        if (parentIdx >= 0) {
          const parentAllow = (derived.get(result.data.requires) ?? []).map((id) =>
            id === "operator1" ? "main" : id,
          );
          configEntries[parentIdx] = {
            ...configEntries[parentIdx],
            subagents: { ...configEntries[parentIdx].subagents, allowAgents: parentAllow },
          };
          await writeConfigFile({ ...cfg, agents: { ...cfg.agents, list: configEntries } });
        }
      }
    } catch {
      // Config sync failure is non-fatal — health check will detect drift
    }

    // Deploy workspace files from blueprint
    try {
      const blueprint = await loadBlueprint(agentDir);
      if (blueprint) {
        const cfg = loadConfig();
        const configId = result.data.id === "operator1" ? "main" : result.data.id;
        const workspaceDir = resolveAgentWorkspaceDir(cfg, configId);
        await deployAgent(blueprint, workspaceDir);
      }
    } catch {
      // Deploy failure is non-fatal — workspace can be deployed later
    }

    respond(true, { ok: true, agentId }, undefined);
  },

  // ── Bundle RPCs ─────────────────────────────────────────────────────────

  "agents.marketplace.bundles": async ({ respond }) => {
    const loaded = await loadBundledAgents();
    const bundles = loaded
      .filter((a) => a.manifest.is_bundle && a.manifest.bundle_agents?.length)
      .map((a) => {
        const includedAgents = (a.manifest.bundle_agents ?? []).map((agentId) => {
          const agent = loaded.find((l) => l.manifest.id === agentId);
          return {
            id: agentId,
            name: agent?.manifest.name ?? agentId,
            tier: agent?.manifest.tier ?? 0,
            role: agent?.manifest.role ?? "",
            installed: true, // bundled agents are always present
          };
        });
        return {
          id: a.manifest.id,
          name: a.manifest.name,
          description: a.manifest.description,
          version: a.manifest.version,
          category: a.manifest.category ?? "bundle",
          bundle_agents: a.manifest.bundle_agents,
          includedAgents,
          agentCount: includedAgents.length,
          allInstalled: includedAgents.every((ia) => ia.installed),
        };
      });
    respond(true, { bundles }, undefined);
  },

  "agents.marketplace.bundle.install": async ({ params, respond }) => {
    const bundleId = typeof params.bundleId === "string" ? params.bundleId.trim() : "";
    if (!bundleId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "bundleId is required"));
      return;
    }

    const loaded = await loadBundledAgents();
    const bundle = loaded.find((a) => a.manifest.id === bundleId);
    if (!bundle || !bundle.manifest.is_bundle || !bundle.manifest.bundle_agents?.length) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `bundle "${bundleId}" not found`),
      );
      return;
    }

    const installed: string[] = [];
    const skipped: string[] = [];
    const warnings: string[] = [];

    for (const agentId of bundle.manifest.bundle_agents) {
      const agent = loaded.find((a) => a.manifest.id === agentId);
      if (!agent) {
        warnings.push(`Agent "${agentId}" listed in bundle but not found`);
        continue;
      }
      // Bundled agents are always present in the agents/ dir, so "install" is a no-op
      // In a real scope-based install, we'd copy to the target scope dir
      installed.push(agentId);
    }

    // After bundle install, ensure all bundle agents have config entries
    try {
      const allLoaded = await loadBundledAgents();
      const allManifests = allLoaded.map((a) => a.manifest);
      const nonBundles = allManifests.filter((m2) => !m2.is_bundle);
      const derived = deriveAllowAgents(nonBundles);
      const cfg = loadConfig();
      const configEntries = (cfg.agents?.list ?? []) as ConfigAgentEntry[];
      let changed = false;

      for (const agentId2 of installed) {
        const manifest = nonBundles.find((m2) => m2.id === agentId2);
        if (!manifest) {
          continue;
        }
        const configId = agentId2 === "operator1" ? "main" : agentId2;
        if (configEntries.find((e) => e.id === configId)) {
          continue;
        }
        const allowAgents = (derived.get(agentId2) ?? []).map((id) =>
          id === "operator1" ? "main" : id,
        );
        const newEntry = buildConfigEntryFromManifest(manifest, allowAgents);
        newEntry.id = configId;
        configEntries.push(newEntry);
        changed = true;
      }

      if (changed) {
        await writeConfigFile({ ...cfg, agents: { ...cfg.agents, list: configEntries } });
      }
    } catch {
      // Config sync is non-fatal
    }

    // Deploy workspace files for all bundle agents
    try {
      const cfg2 = loadConfig();
      for (const agentId2 of installed) {
        const agentDir2 = join(BUNDLED_AGENTS_DIR, agentId2);
        const blueprint = await loadBlueprint(agentDir2);
        if (!blueprint || blueprint.manifest.is_bundle) {
          continue;
        }
        const configId2 = agentId2 === "operator1" ? "main" : agentId2;
        const workspaceDir = resolveAgentWorkspaceDir(cfg2, configId2);
        await deployAgent(blueprint, workspaceDir);
      }
    } catch {
      // Deploy failure is non-fatal
    }

    respond(true, { ok: true, bundleId, installed, skipped, warnings }, undefined);
  },

  // ── Bundle CRUD RPCs ─────────────────────────────────────────────────────

  "agents.marketplace.bundle.create": async ({ params, respond }) => {
    const id = typeof params.id === "string" ? params.id.trim() : "";
    const name = typeof params.name === "string" ? params.name.trim() : "";
    const description = typeof params.description === "string" ? params.description.trim() : "";
    const agents = Array.isArray(params.agents)
      ? params.agents.filter((a): a is string => typeof a === "string")
      : [];

    if (!id || !name) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "id and name are required"));
      return;
    }
    if (agents.length === 0) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "at least one agent is required in the bundle"),
      );
      return;
    }
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "id must be lowercase alphanumeric with hyphens"),
      );
      return;
    }

    const loaded = await loadBundledAgents();
    const existing = loaded.find((a) => a.manifest.id === id);
    if (existing) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `agent or bundle "${id}" already exists`),
      );
      return;
    }

    // Validate referenced agents exist
    const knownIds = new Set(loaded.map((a) => a.manifest.id));
    const unknown = agents.filter((a) => !knownIds.has(a));
    if (unknown.length > 0) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `unknown agents: ${unknown.join(", ")}`),
      );
      return;
    }

    const manifest = {
      id,
      name,
      tier: 2,
      role: "Bundle",
      department: "all",
      description: description || `Custom bundle: ${agents.join(", ")}`,
      version: "1.0.0",
      is_bundle: true,
      bundle_agents: agents,
      keywords: ["bundle", "custom"],
      category: "bundle",
    };

    const bundleDir = join(BUNDLED_AGENTS_DIR, id);
    await mkdir(bundleDir, { recursive: true });
    await writeFile(join(bundleDir, "agent.yaml"), stringifyYaml(manifest));

    respond(true, { ok: true, id, agentCount: agents.length }, undefined);
  },

  "agents.marketplace.bundle.update": async ({ params, respond }) => {
    const bundleId = typeof params.bundleId === "string" ? params.bundleId.trim() : "";
    if (!bundleId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "bundleId is required"));
      return;
    }

    const loaded = await loadBundledAgents();
    const bundle = loaded.find((a) => a.manifest.id === bundleId);
    if (!bundle || !bundle.manifest.is_bundle) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `bundle "${bundleId}" not found`),
      );
      return;
    }

    // Read existing YAML to preserve fields not in the manifest schema
    const yamlPath = join(bundle.dir, "agent.yaml");
    let existing: Record<string, unknown> = {};
    try {
      existing = parseYaml(await readFile(yamlPath, "utf-8")) as Record<string, unknown>;
    } catch {
      // fallback to empty
    }

    if (typeof params.name === "string" && params.name.trim()) {
      existing.name = params.name.trim();
    }
    if (typeof params.description === "string") {
      existing.description = params.description.trim();
    }
    if (Array.isArray(params.agents)) {
      const agents = params.agents.filter((a): a is string => typeof a === "string");
      if (agents.length === 0) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "bundle must have at least one agent"),
        );
        return;
      }
      // Validate referenced agents exist
      const knownIds = new Set(
        loaded.filter((a) => !a.manifest.is_bundle).map((a) => a.manifest.id),
      );
      const unknown = agents.filter((a) => !knownIds.has(a));
      if (unknown.length > 0) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, `unknown agents: ${unknown.join(", ")}`),
        );
        return;
      }
      existing.bundle_agents = agents;
    }

    await writeFile(yamlPath, stringifyYaml(existing));
    respond(true, { ok: true, bundleId }, undefined);
  },

  "agents.marketplace.bundle.delete": async ({ params, respond }) => {
    const bundleId = typeof params.bundleId === "string" ? params.bundleId.trim() : "";
    if (!bundleId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "bundleId is required"));
      return;
    }

    const loaded = await loadBundledAgents();
    const bundle = loaded.find((a) => a.manifest.id === bundleId);
    if (!bundle) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `bundle "${bundleId}" not found`),
      );
      return;
    }
    if (!bundle.manifest.is_bundle) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `"${bundleId}" is not a bundle — use agents.marketplace.remove to delete agents`,
        ),
      );
      return;
    }

    await rm(bundle.dir, { recursive: true, force: true });
    respond(true, { ok: true, bundleId }, undefined);
  },

  // ── Registry management RPCs ─────────────────────────────────────────────

  "agents.marketplace.registry.add": async ({ params, respond }) => {
    const id = typeof params.id === "string" ? params.id.trim() : "";
    const name = typeof params.name === "string" ? params.name.trim() : "";
    const url = typeof params.url === "string" ? params.url.trim() : "";
    if (!id || !name || !url) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "id, name, and url are required"),
      );
      return;
    }
    if (id === "operator1") {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "cannot overwrite the bundled registry"),
      );
      return;
    }

    const existing = loadAgentRegistriesFromDb();
    if (existing.some((r) => r.id === id)) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `registry "${id}" already exists`),
      );
      return;
    }

    const visibility = params.visibility === "private" ? ("private" as const) : ("public" as const);
    const authTokenEnv = typeof params.authTokenEnv === "string" ? params.authTokenEnv : undefined;

    saveAgentRegistryToDb({ id, name, url, visibility, authTokenEnv, enabled: true });
    respond(true, { ok: true, id }, undefined);
  },

  "agents.marketplace.registry.remove": async ({ params, respond }) => {
    const id = typeof params.id === "string" ? params.id.trim() : "";
    if (!id) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "id is required"));
      return;
    }
    if (id === "operator1") {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "cannot remove the bundled registry"),
      );
      return;
    }

    const removed = deleteAgentRegistryFromDb(id);
    if (!removed) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `registry "${id}" not found`),
      );
      return;
    }
    respond(true, { ok: true, id }, undefined);
  },

  "agents.marketplace.sync": async ({ params, respond }) => {
    const registryId = typeof params.registryId === "string" ? params.registryId.trim() : "";
    if (!registryId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "registryId is required"));
      return;
    }
    if (registryId === "operator1") {
      respond(
        true,
        { ok: true, agents: [], message: "Bundled registry is always up to date" },
        undefined,
      );
      return;
    }

    const registries = loadAgentRegistriesFromDb();
    const reg = registries.find((r) => r.id === registryId);
    if (!reg) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `registry "${registryId}" not found`),
      );
      return;
    }

    const entry: RegistryEntry = {
      id: reg.id,
      name: reg.name,
      url: reg.url,
      authTokenEnv: reg.authTokenEnv,
      visibility: reg.visibility,
      enabled: reg.enabled,
    };

    try {
      const result = await syncRegistry(entry);
      // Update sync metadata in SQLite
      updateAgentRegistrySyncState(reg.id, result.syncedAt, result.agents.length);

      respond(
        true,
        {
          ok: true,
          agents: result.agents.map((a) => ({
            id: a.id,
            name: a.name,
            version: a.version,
            tier: a.tier,
          })),
          errors: result.errors,
          syncedAt: result.syncedAt,
        },
        undefined,
      );
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INTERNAL_ERROR, `sync failed: ${(err as Error).message}`),
      );
    }
  },
};
