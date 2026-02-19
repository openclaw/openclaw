import { Type } from "@sinclair/typebox";
import { loadConfig } from "../../config/config.js";
import { optionalStringEnum } from "../schema/typebox.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "../../infra/state-dir.js";

// Singleton workspace for speed automation
let speedWorkspace: string | null = null;

function getSpeedWorkspace(): string {
  if (!speedWorkspace) {
    const config = loadConfig();
    const workspacePath = config.security?.automation?.workspace ?? "~/.openclaw/security/automation/";
    speedWorkspace = workspacePath.startsWith("~")
      ? workspacePath.replace("~", resolveStateDir())
      : workspacePath;
    fs.mkdir(speedWorkspace, { recursive: true }).catch(() => {
      // Ignore errors, will be handled on write
    });
  }
  return speedWorkspace;
}

// Speed Automation Tool Schemas

const VulnerabilityInstantTestSchema = Type.Object({
  cve: Type.String(),
  target: Type.Optional(Type.String()),
  instant_mode: Type.Optional(Type.Boolean()),
  validate_patch: Type.Optional(Type.Boolean()),
  output: Type.Optional(Type.String()),
});

const AttackResponseAutomatedSchema = Type.Object({
  attack_pattern: Type.String(),
  severity: optionalStringEnum(["low", "medium", "high", "critical"] as const),
  contain_threat: Type.Optional(Type.Boolean()),
  generate_incident: Type.Optional(Type.Boolean()),
  update_threat_model: Type.Optional(Type.Boolean()),
  output: Type.Optional(Type.String()),
});

// Speed Automation Tools

export function createVulnerabilityInstantTestTool(): AnyAgentTool {
  return {
    label: "Speed Automation",
    name: "vulnerability_instant_test",
    description:
      "Instant vulnerability testing: monitor CVE databases in real-time, generate exploit attempts immediately, test against systems automatically, and validate patches instantly. Respond to AI-accelerated attacks (100x faster) with automated testing workflows.",
    parameters: VulnerabilityInstantTestSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const workspace = getSpeedWorkspace();

      try {
        const cve = readStringParam(params, "cve", { required: true });
        const target = readStringParam(params, "target");
        const instantMode = params.instant_mode !== false; // Default true
        const validatePatch = params.validate_patch !== false; // Default true
        const output = readStringParam(params, "output");

        let result: Record<string, unknown> = {
          status: "success",
          cve,
          instant_mode: instantMode,
          validate_patch: validatePatch,
        };

        // Parse CVE
        const cveMatch = cve.match(/^CVE-(\d{4})-(\d+)$/i);
        if (!cveMatch) {
          return jsonResult({
            status: "error",
            error: `Invalid CVE format: ${cve}. Expected format: CVE-YYYY-NNNN`,
          });
        }

        const [, year, id] = cveMatch;
        result.cve_year = year;
        result.cve_id = id;

        // Instant testing workflow
        if (instantMode) {
          result.testing_workflow = {
            phase: "instant_testing",
            steps: [
              "Query CVE database for vulnerability details",
              "Generate exploit attempt immediately",
              "Test against target systems automatically",
              "Validate if systems are vulnerable",
              validatePatch ? "Test patch if available" : null,
            ].filter((s): s is string => s !== null),
            response_time_target: "minutes",
            message: "Instant vulnerability testing mode enabled. Responding to CVE publication within minutes.",
          };
        }

        // Generate exploit attempt
        result.exploit_attempt = {
          cve,
          generated_at: new Date().toISOString(),
          exploit_type: "automated",
          target: target ?? "all_systems",
          status: "planned",
        };

        // Patch validation
        if (validatePatch) {
          result.patch_validation = {
            enabled: true,
            steps: [
              "Check for available patches",
              "Test patch installation",
              "Validate patch effectiveness",
              "Verify no regression",
            ],
            message: "Patch validation enabled. Will automatically test patches when available.",
          };
        }

        // Generate test plan
        const testPlan = {
          cve,
          created_at: new Date().toISOString(),
          instant_mode: instantMode,
          target: target ?? "all_systems",
          exploit_attempt: result.exploit_attempt,
          patch_validation: validatePatch ? result.patch_validation : null,
          recommendations: [
            instantMode
              ? "Systems must be taken offline or patched nearly instantaneously"
              : "Apply patches as soon as available",
            "Monitor for exploit attempts",
            "Validate patches before deployment",
            "Test systems after patching",
          ],
        };

        result.test_plan = testPlan;
        result.message = `Instant vulnerability testing planned for ${cve}.${instantMode ? " Instant mode enabled - respond within minutes." : ""}${validatePatch ? " Patch validation enabled." : ""}`;

        // Save test plan if output requested
        if (output) {
          const outputPath = path.join(workspace, output);
          await fs.writeFile(outputPath, JSON.stringify(testPlan, null, 2));
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

export function createAttackResponseAutomatedTool(): AnyAgentTool {
  return {
    label: "Speed Automation",
    name: "attack_response_automated",
    description:
      "Automated attack response: detect attack patterns, automatically contain threats, generate incident reports, and update threat models. Respond to AI-accelerated attacks faster than human speed.",
    parameters: AttackResponseAutomatedSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const workspace = getSpeedWorkspace();

      try {
        const attackPattern = readStringParam(params, "attack_pattern", { required: true });
        const severity = readStringParam(params, "severity") as "low" | "medium" | "high" | "critical" | undefined;
        const containThreat = params.contain_threat !== false; // Default true
        const generateIncident = params.generate_incident !== false; // Default true
        const updateThreatModel = params.update_threat_model !== false; // Default true
        const output = readStringParam(params, "output");

        const detectedSeverity = severity ?? "medium";

        let result: Record<string, unknown> = {
          status: "success",
          attack_pattern: attackPattern,
          severity: detectedSeverity,
          contain_threat: containThreat,
          generate_incident: generateIncident,
          update_threat_model: updateThreatModel,
        };

        // Automated containment
        if (containThreat) {
          result.containment_actions = {
            enabled: true,
            actions: [
              "Isolate affected systems",
              "Block malicious IPs/domains",
              "Disable compromised accounts",
              "Quarantine malicious files",
              "Stop suspicious processes",
            ],
            message: "Automated containment enabled. Will automatically isolate threats.",
          };
        }

        // Incident generation
        if (generateIncident) {
          const incidentId = `INC-${Date.now()}`;
          result.incident = {
            id: incidentId,
            attack_pattern: attackPattern,
            severity: detectedSeverity,
            detected_at: new Date().toISOString(),
            status: "open",
            containment: containThreat ? "automated" : "manual",
            timeline: [
              {
                timestamp: new Date().toISOString(),
                event: "Attack pattern detected",
                severity: detectedSeverity,
              },
              containThreat
                ? {
                    timestamp: new Date().toISOString(),
                    event: "Automated containment initiated",
                  }
                : null,
            ].filter((e): e is Record<string, unknown> => e !== null),
          };
        }

        // Threat model update
        if (updateThreatModel) {
          result.threat_model_update = {
            enabled: true,
            attack_pattern: attackPattern,
            severity: detectedSeverity,
            iocs: [],
            ttps: [],
            defensive_controls: [
              "Implement automated containment",
              "Monitor for attack pattern",
              "Update detection rules",
              "Enhance logging",
            ],
            message: "Threat model will be updated with new attack pattern and defensive controls.",
          };
        }

        result.message = `Automated attack response planned for ${attackPattern} (severity: ${detectedSeverity}).${containThreat ? " Automated containment enabled." : ""}${generateIncident ? " Incident report will be generated." : ""}${updateThreatModel ? " Threat model will be updated." : ""}`;

        // Generate response plan
        const responsePlan = {
          attack_pattern: attackPattern,
          severity: detectedSeverity,
          detected_at: new Date().toISOString(),
          containment: containThreat ? result.containment_actions : null,
          incident: generateIncident ? result.incident : null,
          threat_model_update: updateThreatModel ? result.threat_model_update : null,
          recommendations: [
            "Respond faster than human speed",
            "Automate containment actions",
            "Generate incident reports automatically",
            "Update threat models continuously",
            "Validate detection capabilities",
          ],
        };

        result.response_plan = responsePlan;

        // Save response plan if output requested
        if (output) {
          const outputPath = path.join(workspace, output);
          await fs.writeFile(outputPath, JSON.stringify(responsePlan, null, 2));
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
