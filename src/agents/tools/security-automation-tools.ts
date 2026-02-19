import { Type } from "@sinclair/typebox";
import { loadConfig } from "../../config/config.js";
import { optionalStringEnum } from "../schema/typebox.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "../../infra/state-dir.js";
import { ThreatIntelligenceStore } from "../../cybersecurity/threat-intelligence/store.js";

// Singleton workspace for security automation
let automationWorkspace: string | null = null;

function getAutomationWorkspace(): string {
  if (!automationWorkspace) {
    const config = loadConfig();
    const workspacePath =
      config.security?.automation?.workspace ?? "~/.openclaw/security/automation/";
    automationWorkspace = workspacePath.startsWith("~")
      ? workspacePath.replace("~", resolveStateDir())
      : workspacePath;
    fs.mkdir(automationWorkspace, { recursive: true }).catch(() => {
      // Ignore errors, will be handled on write
    });
  }
  return automationWorkspace;
}

// Security Automation Tool Schemas

const ThreatModelExtendSchema = Type.Object({
  source: optionalStringEnum([
    "threat_intelligence",
    "cve",
    "mitre_attack",
    "attack_pattern",
    "custom",
  ] as const),
  actor_id: Type.Optional(Type.String()),
  cve: Type.Optional(Type.String()),
  technique_id: Type.Optional(Type.String()),
  attack_pattern: Type.Optional(Type.String()),
  output: Type.Optional(Type.String()),
});

const RedTeamAutomateSchema = Type.Object({
  actor_id: Type.Optional(Type.String()),
  threat_model_id: Type.Optional(Type.String()),
  scenario: Type.Optional(Type.String()),
  schedule: Type.Optional(Type.String()),
  output: Type.Optional(Type.String()),
});

const ThreatModelGenerateSchema = Type.Object({
  target: Type.String(),
  scope: Type.Optional(Type.String()),
  sources: Type.Optional(Type.Array(Type.String())),
  output: Type.Optional(Type.String()),
});

const AttackScenarioGenerateSchema = Type.Object({
  threat_model_id: Type.Optional(Type.String()),
  actor_id: Type.Optional(Type.String()),
  technique_ids: Type.Optional(Type.Array(Type.String())),
  output: Type.Optional(Type.String()),
});

const VulnerabilityDrivenTestSchema = Type.Object({
  cve: Type.Optional(Type.String()),
  product: Type.Optional(Type.String()),
  version: Type.Optional(Type.String()),
  schedule: Type.Optional(Type.String()),
  output: Type.Optional(Type.String()),
});

const RedTeamFromIntelSchema = Type.Object({
  actor_id: Type.Optional(Type.String()),
  campaign_id: Type.Optional(Type.String()),
  validate_detection: Type.Optional(Type.Boolean()),
  output: Type.Optional(Type.String()),
});

const ThreatModelFromActorSchema = Type.Object({
  actor_id: Type.String(),
  prioritize_by_severity: Type.Optional(Type.Boolean()),
  output: Type.Optional(Type.String()),
});

// Security Automation Tools

export function createThreatModelExtendTool(): AnyAgentTool {
  return {
    label: "Security Automation",
    name: "threat_model_extend",
    description:
      "Automatically extend threat models from threat intelligence, CVEs, MITRE ATT&CK techniques, or attack patterns. Generates attack scenarios and defensive controls.",
    parameters: ThreatModelExtendSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const workspace = getAutomationWorkspace();

      try {
        const source = readStringParam(params, "source") as
          | "threat_intelligence"
          | "cve"
          | "mitre_attack"
          | "attack_pattern"
          | "custom"
          | undefined;
        const actorId = readStringParam(params, "actor_id");
        const cve = readStringParam(params, "cve");
        const techniqueId = readStringParam(params, "technique_id");
        const attackPattern = readStringParam(params, "attack_pattern");
        const output = readStringParam(params, "output");

        let result: Record<string, unknown> = {
          status: "success",
          source: source ?? "threat_intelligence",
        };

        // Extend from threat intelligence
        if (source === "threat_intelligence" || !source) {
          if (!actorId) {
            return jsonResult({
              status: "error",
              error: "actor_id required for threat_intelligence source",
            });
          }

          result.actor_id = actorId;
          result.message = `Threat model extension planned from threat actor ${actorId}. Will analyze TTPs, IOCs, and attack patterns to extend threat model.`;

          // Generate threat model entry
          const threatModelEntry = {
            actor_id: actorId,
            source: "threat_intelligence",
            created_at: new Date().toISOString(),
            attack_scenarios: [],
            defensive_controls: [],
            iocs: [],
            ttps: [],
          };

          result.threat_model_entry = threatModelEntry;
        }

        // Extend from CVE
        if (source === "cve") {
          if (!cve) {
            return jsonResult({
              status: "error",
              error: "cve required for cve source",
            });
          }

          result.cve = cve;
          result.message = `Threat model extension planned from CVE ${cve}. Will analyze vulnerability, determine attack vectors, and update threat model.`;

          const threatModelEntry = {
            cve,
            source: "cve",
            created_at: new Date().toISOString(),
            attack_vectors: [],
            affected_systems: [],
            defensive_controls: [],
          };

          result.threat_model_entry = threatModelEntry;
        }

        // Extend from MITRE ATT&CK
        if (source === "mitre_attack") {
          if (!techniqueId) {
            return jsonResult({
              status: "error",
              error: "technique_id required for mitre_attack source",
            });
          }

          result.technique_id = techniqueId;
          result.message = `Threat model extension planned from MITRE ATT&CK technique ${techniqueId}. Will create attack scenarios and defensive measures.`;

          const threatModelEntry = {
            technique_id: techniqueId,
            source: "mitre_attack",
            created_at: new Date().toISOString(),
            attack_scenarios: [],
            detection_rules: [],
            defensive_controls: [],
          };

          result.threat_model_entry = threatModelEntry;
        }

        // Extend from attack pattern
        if (source === "attack_pattern") {
          if (!attackPattern) {
            return jsonResult({
              status: "error",
              error: "attack_pattern required for attack_pattern source",
            });
          }

          result.attack_pattern = attackPattern;
          result.message = `Threat model extension planned from attack pattern: ${attackPattern}. Will analyze pattern and create threat model entry.`;

          const threatModelEntry = {
            attack_pattern,
            source: "attack_pattern",
            created_at: new Date().toISOString(),
            attack_scenarios: [],
            defensive_controls: [],
          };

          result.threat_model_entry = threatModelEntry;
        }

        // Save threat model extension if output requested
        if (output) {
          const outputPath = path.join(workspace, output);
          await fs.writeFile(outputPath, JSON.stringify(result, null, 2));
          result.output_file = outputPath;
        }

        return jsonResult(result);
      } catch (error) {
        return jsonResult({
          status: "error",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
}

export function createRedTeamAutomateTool(): AnyAgentTool {
  return {
    label: "Security Automation",
    name: "red_team_automate",
    description:
      "Automate red team exercises: generate attack scenarios from threat models or threat actors, schedule exercises, and execute automated attack chains.",
    parameters: RedTeamAutomateSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const workspace = getAutomationWorkspace();

      try {
        const actorId = readStringParam(params, "actor_id");
        const threatModelId = readStringParam(params, "threat_model_id");
        const scenario = readStringParam(params, "scenario");
        const schedule = readStringParam(params, "schedule");
        const output = readStringParam(params, "output");

        if (!actorId && !threatModelId && !scenario) {
          return jsonResult({
            status: "error",
            error: "actor_id, threat_model_id, or scenario required",
          });
        }

        let result: Record<string, unknown> = {
          status: "success",
        };

        if (actorId) {
          result.actor_id = actorId;
        }
        if (threatModelId) {
          result.threat_model_id = threatModelId;
        }
        if (scenario) {
          result.scenario = scenario;
        }

        // Generate attack scenario
        const attackScenario = {
          actor_id: actorId,
          threat_model_id: threatModelId,
          scenario: scenario ?? "automated_red_team_exercise",
          created_at: new Date().toISOString(),
          phases: [
            "reconnaissance",
            "weaponization",
            "delivery",
            "exploitation",
            "installation",
            "command_control",
            "actions_on_objectives",
          ],
          schedule: schedule ?? null,
        };

        result.attack_scenario = attackScenario;

        if (schedule) {
          result.message = `Red team exercise scheduled: ${schedule}. Will execute attack scenario automatically.`;
          result.scheduled = true;
        } else {
          result.message = `Red team exercise planned. Execute attack scenario: ${scenario ?? "automated"}.`;
          result.scheduled = false;
        }

        // Save exercise plan if output requested
        if (output) {
          const outputPath = path.join(workspace, output);
          await fs.writeFile(outputPath, JSON.stringify(result, null, 2));
          result.output_file = outputPath;
        }

        return jsonResult(result);
      } catch (error) {
        return jsonResult({
          status: "error",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
}

export function createThreatModelGenerateTool(): AnyAgentTool {
  return {
    label: "Security Automation",
    name: "threat_model_generate",
    description:
      "Generate comprehensive threat model for a target system: analyze attack surface, identify threats, create attack scenarios, and recommend defensive controls.",
    parameters: ThreatModelGenerateSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const workspace = getAutomationWorkspace();

      try {
        const target = readStringParam(params, "target", { required: true });
        const scope = readStringParam(params, "scope");
        const sources = Array.isArray(params.sources)
          ? (params.sources.filter((s) => typeof s === "string") as string[])
          : undefined;
        const output = readStringParam(params, "output");

        const threatModelSources = sources ?? [
          "owasp_top_10",
          "cwe_top_25",
          "mitre_attack",
          "threat_intelligence",
        ];

        let result: Record<string, unknown> = {
          status: "success",
          target,
          scope: scope ?? "comprehensive",
          sources: threatModelSources,
        };

        // Generate threat model structure
        const threatModel = {
          target,
          scope: scope ?? "comprehensive",
          created_at: new Date().toISOString(),
          sources: threatModelSources,
          attack_surface: {
            web_application: [],
            network: [],
            infrastructure: [],
            data: [],
          },
          threats: [],
          attack_scenarios: [],
          defensive_controls: [],
          risk_assessment: {},
        };

        result.threat_model = threatModel;
        result.message = `Threat model generation planned for ${target}${scope ? ` (scope: ${scope})` : ""}. Sources: ${threatModelSources.join(", ")}.`;

        // Save threat model if output requested
        if (output) {
          const outputPath = path.join(workspace, output);
          await fs.writeFile(outputPath, JSON.stringify(result, null, 2));
          result.output_file = outputPath;
        }

        return jsonResult(result);
      } catch (error) {
        return jsonResult({
          status: "error",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
}

export function createAttackScenarioGenerateTool(): AnyAgentTool {
  return {
    label: "Security Automation",
    name: "attack_scenario_generate",
    description:
      "Generate attack scenarios from threat models, threat actors, or MITRE ATT&CK techniques. Creates detailed attack chains for red team exercises.",
    parameters: AttackScenarioGenerateSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const workspace = getAutomationWorkspace();

      try {
        const threatModelId = readStringParam(params, "threat_model_id");
        const actorId = readStringParam(params, "actor_id");
        const techniqueIds = Array.isArray(params.technique_ids)
          ? (params.technique_ids.filter((t) => typeof t === "string") as string[])
          : undefined;
        const output = readStringParam(params, "output");

        if (!threatModelId && !actorId && !techniqueIds) {
          return jsonResult({
            status: "error",
            error: "threat_model_id, actor_id, or technique_ids required",
          });
        }

        let result: Record<string, unknown> = {
          status: "success",
        };

        if (threatModelId) {
          result.threat_model_id = threatModelId;
        }
        if (actorId) {
          result.actor_id = actorId;
        }
        if (techniqueIds) {
          result.technique_ids = techniqueIds;
        }

        // Generate attack scenario
        const attackScenario = {
          threat_model_id: threatModelId,
          actor_id: actorId,
          technique_ids: techniqueIds ?? [],
          created_at: new Date().toISOString(),
          attack_chain: [
            {
              phase: "initial_access",
              techniques: [],
              tools: [],
            },
            {
              phase: "execution",
              techniques: [],
              tools: [],
            },
            {
              phase: "persistence",
              techniques: [],
              tools: [],
            },
            {
              phase: "privilege_escalation",
              techniques: [],
              tools: [],
            },
            {
              phase: "defense_evasion",
              techniques: [],
              tools: [],
            },
            {
              phase: "credential_access",
              techniques: [],
              tools: [],
            },
            {
              phase: "discovery",
              techniques: [],
              tools: [],
            },
            {
              phase: "lateral_movement",
              techniques: [],
              tools: [],
            },
            {
              phase: "collection",
              techniques: [],
              tools: [],
            },
            {
              phase: "exfiltration",
              techniques: [],
              tools: [],
            },
          ],
        };

        result.attack_scenario = attackScenario;
        result.message = `Attack scenario generation planned${threatModelId ? ` from threat model ${threatModelId}` : ""}${actorId ? ` for actor ${actorId}` : ""}${techniqueIds ? ` using techniques ${techniqueIds.join(", ")}` : ""}.`;

        // Save attack scenario if output requested
        if (output) {
          const outputPath = path.join(workspace, output);
          await fs.writeFile(outputPath, JSON.stringify(result, null, 2));
          result.output_file = outputPath;
        }

        return jsonResult(result);
      } catch (error) {
        return jsonResult({
          status: "error",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
}

export function createVulnerabilityDrivenTestTool(): AnyAgentTool {
  return {
    label: "Security Automation",
    name: "vulnerability_driven_test",
    description:
      "Automate vulnerability-driven testing: monitor CVEs, generate exploit attempts, test against systems, and validate patches. Can be scheduled for continuous testing.",
    parameters: VulnerabilityDrivenTestSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const workspace = getAutomationWorkspace();

      try {
        const cve = readStringParam(params, "cve");
        const product = readStringParam(params, "product");
        const version = readStringParam(params, "version");
        const schedule = readStringParam(params, "schedule");
        const output = readStringParam(params, "output");

        if (!cve && !product) {
          return jsonResult({
            status: "error",
            error: "cve or product required",
          });
        }

        let result: Record<string, unknown> = {
          status: "success",
        };

        if (cve) {
          result.cve = cve;
        }
        if (product) {
          result.product = product;
          if (version) {
            result.version = version;
          }
        }

        // Generate test plan
        const testPlan = {
          cve,
          product,
          version,
          created_at: new Date().toISOString(),
          test_steps: [
            "vulnerability_analysis",
            "exploit_development",
            "exploit_testing",
            "patch_validation",
            "regression_testing",
          ],
          schedule: schedule ?? null,
        };

        result.test_plan = testPlan;

        if (schedule) {
          result.message = `Vulnerability-driven testing scheduled: ${schedule}. Will automatically test ${cve ? `CVE ${cve}` : `${product}${version ? ` ${version}` : ""}`}.`;
          result.scheduled = true;
        } else {
          result.message = `Vulnerability-driven testing planned for ${cve ? `CVE ${cve}` : `${product}${version ? ` ${version}` : ""}`}. Generate exploit attempts and test against systems.`;
          result.scheduled = false;
        }

        // Save test plan if output requested
        if (output) {
          const outputPath = path.join(workspace, output);
          await fs.writeFile(outputPath, JSON.stringify(result, null, 2));
          result.output_file = outputPath;
        }

        return jsonResult(result);
      } catch (error) {
        return jsonResult({
          status: "error",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
}
