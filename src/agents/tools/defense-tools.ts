import { Type } from "@sinclair/typebox";
import { loadConfig } from "../../config/config.js";
import { optionalStringEnum } from "../schema/typebox.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "../../infra/state-dir.js";

// Singleton workspace for defense operations data
let defenseWorkspace: string | null = null;

function getDefenseWorkspace(): string {
  if (!defenseWorkspace) {
    const config = loadConfig();
    const workspacePath =
      config.security?.defense?.workspace ?? "~/.openclaw/security/defense/";
    defenseWorkspace = workspacePath.startsWith("~")
      ? workspacePath.replace("~", resolveStateDir())
      : workspacePath;
    // Ensure directory exists
    fs.mkdir(defenseWorkspace, { recursive: true }).catch(() => {
      // Ignore errors, will be handled on write
    });
  }
  return defenseWorkspace;
}

// Defense Tool Schemas

const DefenseSiemQuerySchema = Type.Object({
  provider: optionalStringEnum(["splunk", "elastic", "sentinel", "crowdstrike"] as const),
  query: Type.String(),
  time_range: Type.Optional(Type.String()),
  index: Type.Optional(Type.String()),
  output: Type.Optional(Type.String()),
});

const DefenseIncidentResponseSchema = Type.Object({
  phase: optionalStringEnum([
    "triage",
    "investigation",
    "containment",
    "eradication",
    "recovery",
    "post_incident",
  ] as const),
  alert_id: Type.Optional(Type.String()),
  incident_id: Type.Optional(Type.String()),
  severity: Type.Optional(optionalStringEnum(["low", "medium", "high", "critical"] as const)),
  source: Type.Optional(Type.String()),
  scope: Type.Optional(Type.Array(Type.String())),
  timeline: Type.Optional(Type.String()),
  actions: Type.Optional(Type.Array(Type.String())),
});

const DefenseThreatHuntSchema = Type.Object({
  hypothesis: Type.String(),
  data_sources: Type.Optional(Type.Array(Type.String())),
  time_range: Type.Optional(Type.String()),
  iocs: Type.Optional(Type.Array(Type.String())),
  ttps: Type.Optional(Type.Array(Type.String())),
  output: Type.Optional(Type.String()),
});

const DefenseLogAnalysisSchema = Type.Object({
  log_type: optionalStringEnum([
    "firewall",
    "web_server",
    "authentication",
    "dns",
    "proxy",
    "endpoint",
    "application",
  ] as const),
  log_source: Type.String(),
  query: Type.Optional(Type.String()),
  time_range: Type.Optional(Type.String()),
  output: Type.Optional(Type.String()),
});

const DefenseForensicsSchema = Type.Object({
  action: optionalStringEnum([
    "collect",
    "analyze",
    "timeline",
    "artifact_extraction",
    "memory_analysis",
  ] as const),
  target: Type.String(),
  scope: Type.Optional(Type.Array(Type.String())),
  output: Type.Optional(Type.String()),
});

const DefenseMalwareAnalysisSchema = Type.Object({
  action: optionalStringEnum(["analyze", "sandbox", "static", "dynamic", "ioc_extraction"] as const),
  sample: Type.String(),
  sandbox: Type.Optional(Type.String()),
  output: Type.Optional(Type.String()),
});

// SIEM Integration Schemas

const DefenseSplunkSchema = Type.Object({
  action: optionalStringEnum(["query", "dashboard", "alert", "correlate"] as const),
  query: Type.Optional(Type.String()),
  dashboard: Type.Optional(Type.String()),
  time_range: Type.Optional(Type.String()),
  output: Type.Optional(Type.String()),
});

const DefenseElasticSchema = Type.Object({
  action: optionalStringEnum(["query", "detect", "investigate", "correlate"] as const),
  query: Type.Optional(Type.String()),
  index: Type.Optional(Type.String()),
  time_range: Type.Optional(Type.String()),
  output: Type.Optional(Type.String()),
});

const DefenseSentinelSchema = Type.Object({
  action: optionalStringEnum(["query", "incident", "playbook", "hunt"] as const),
  query: Type.Optional(Type.String()),
  incident_id: Type.Optional(Type.String()),
  playbook: Type.Optional(Type.String()),
  time_range: Type.Optional(Type.String()),
  output: Type.Optional(Type.String()),
});

const DefenseCrowdstrikeSchema = Type.Object({
  action: optionalStringEnum(["query", "detect", "investigate", "hunt"] as const),
  query: Type.Optional(Type.String()),
  device_id: Type.Optional(Type.String()),
  time_range: Type.Optional(Type.String()),
  output: Type.Optional(Type.String()),
});

const DefenseMispSchema = Type.Object({
  action: optionalStringEnum(["search", "add", "export", "import"] as const),
  query: Type.Optional(Type.String()),
  ioc: Type.Optional(Type.String()),
  format: Type.Optional(optionalStringEnum(["json", "stix", "csv"] as const)),
  output: Type.Optional(Type.String()),
});

// Defense Tools

export function createDefenseSiemQueryTool(): AnyAgentTool {
  return {
    label: "Defensive Security",
    name: "defense_siem_query",
    description:
      "Query Security Information and Event Management (SIEM) systems: Splunk, Elastic Security, Azure Sentinel, CrowdStrike. Execute queries, correlate events, and create dashboards.",
    parameters: DefenseSiemQuerySchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const workspace = getDefenseWorkspace();
      const config = loadConfig();

      try {
        const provider = readStringParam(params, "provider") as
          | "splunk"
          | "elastic"
          | "sentinel"
          | "crowdstrike"
          | undefined;
        const query = readStringParam(params, "query", { required: true });
        const timeRange = readStringParam(params, "time_range");
        const index = readStringParam(params, "index");
        const output = readStringParam(params, "output");

        // Get SIEM config from security.defense.siem
        const siemConfig = config.security?.defense?.siem;
        const siemProvider = provider ?? siemConfig?.provider ?? "splunk";

        let result: Record<string, unknown> = {
          status: "success",
          provider: siemProvider,
          query,
        };

        if (timeRange) {
          result.time_range = timeRange;
        }
        if (index) {
          result.index = index;
        }

        // Build provider-specific query
        if (siemProvider === "splunk") {
          result.message = `Splunk query planned: ${query}${timeRange ? ` (time_range: ${timeRange})` : ""}. Requires Splunk API endpoint and credentials.`;
          result.splunk_query = query;
        } else if (siemProvider === "elastic") {
          result.message = `Elastic Security query planned: ${query}${index ? ` (index: ${index})` : ""}${timeRange ? ` (time_range: ${timeRange})` : ""}. Requires Elastic API endpoint and credentials.`;
          result.elastic_query = query;
        } else if (siemProvider === "sentinel") {
          result.message = `Azure Sentinel query planned: ${query}${timeRange ? ` (time_range: ${timeRange})` : ""}. Requires Azure Sentinel API credentials.`;
          result.sentinel_query = query;
        } else if (siemProvider === "crowdstrike") {
          result.message = `CrowdStrike query planned: ${query}${timeRange ? ` (time_range: ${timeRange})` : ""}. Requires CrowdStrike API credentials.`;
          result.crowdstrike_query = query;
        }

        // Save output if requested
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

export function createDefenseIncidentResponseTool(): AnyAgentTool {
  return {
    label: "Defensive Security",
    name: "defense_incident_response",
    description:
      "Automate incident response workflows: triage alerts, investigate incidents, contain threats, eradicate malware, recover systems, and conduct post-incident activities.",
    parameters: DefenseIncidentResponseSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const workspace = getDefenseWorkspace();

      try {
        const phase = readStringParam(params, "phase", { required: true }) as
          | "triage"
          | "investigation"
          | "containment"
          | "eradication"
          | "recovery"
          | "post_incident";
        const alertId = readStringParam(params, "alert_id");
        const incidentId = readStringParam(params, "incident_id");
        const severity = readStringParam(params, "severity") as
          | "low"
          | "medium"
          | "high"
          | "critical"
          | undefined;
        const source = readStringParam(params, "source");
        const scope = Array.isArray(params.scope)
          ? (params.scope.filter((s) => typeof s === "string") as string[])
          : undefined;
        const timeline = readStringParam(params, "timeline");
        const actions = Array.isArray(params.actions)
          ? (params.actions.filter((a) => typeof a === "string") as string[])
          : undefined;

        let result: Record<string, unknown> = {
          status: "success",
          phase,
        };

        if (alertId) {
          result.alert_id = alertId;
        }
        if (incidentId) {
          result.incident_id = incidentId;
        }
        if (severity) {
          result.severity = severity;
        }
        if (source) {
          result.source = source;
        }

        // Triage
        if (phase === "triage") {
          if (!alertId) {
            return jsonResult({
              status: "error",
              error: "alert_id required for triage phase",
            });
          }
          result.message = `Alert triage planned for ${alertId}${severity ? ` (severity: ${severity})` : ""}. Assess severity, determine scope, and assign to analyst.`;
        }

        // Investigation
        if (phase === "investigation") {
          if (!incidentId) {
            return jsonResult({
              status: "error",
              error: "incident_id required for investigation phase",
            });
          }
          const investScope = scope ?? ["network", "endpoints", "logs"];
          const timeRange = timeline ?? "last_24_hours";
          result.scope = investScope;
          result.timeline = timeRange;
          result.message = `Incident investigation planned for ${incidentId}. Scope: ${investScope.join(", ")}. Timeline: ${timeRange}.`;
        }

        // Containment
        if (phase === "containment") {
          if (!incidentId) {
            return jsonResult({
              status: "error",
              error: "incident_id required for containment phase",
            });
          }
          const containActions = actions ?? ["isolate_host", "block_ip", "revoke_credentials"];
          result.actions = containActions;
          result.message = `Threat containment planned for ${incidentId}. Actions: ${containActions.join(", ")}.`;
        }

        // Eradication
        if (phase === "eradication") {
          if (!incidentId) {
            return jsonResult({
              status: "error",
              error: "incident_id required for eradication phase",
            });
          }
          const eradicateActions = actions ?? ["remove_malware", "patch_vulnerability", "reset_credentials"];
          result.actions = eradicateActions;
          result.message = `Threat eradication planned for ${incidentId}. Actions: ${eradicateActions.join(", ")}.`;
        }

        // Recovery
        if (phase === "recovery") {
          if (!incidentId) {
            return jsonResult({
              status: "error",
              error: "incident_id required for recovery phase",
            });
          }
          const recoveryActions = actions ?? ["restore_systems", "verify_integrity", "monitor_continuously"];
          result.actions = recoveryActions;
          result.message = `System recovery planned for ${incidentId}. Actions: ${recoveryActions.join(", ")}.`;
        }

        // Post-incident
        if (phase === "post_incident") {
          if (!incidentId) {
            return jsonResult({
              status: "error",
              error: "incident_id required for post-incident phase",
            });
          }
          const postActions = actions ?? ["root_cause_analysis", "lessons_learned", "update_playbooks"];
          result.actions = postActions;
          result.message = `Post-incident activities planned for ${incidentId}. Actions: ${postActions.join(", ")}.`;

          // Generate post-incident report
          const reportFile = `incident_report_${incidentId}_${Date.now()}.md`;
          const reportPath = path.join(workspace, reportFile);
          const report = `# Incident Response Report

## Incident ID
${incidentId}

## Phase
${phase}

## Severity
${severity ?? "Not specified"}

## Timeline
${timeline ?? "Not specified"}

## Actions Taken
${actions ? actions.map((a) => `- ${a}`).join("\n") : "None specified"}

## Post-Incident Activities
${postActions.map((a) => `- ${a}`).join("\n")}

## Recommendations
[Add recommendations based on findings]

Generated: ${new Date().toISOString()}
`;

          await fs.writeFile(reportPath, report);
          result.report_file = reportPath;
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

export function createDefenseThreatHuntTool(): AnyAgentTool {
  return {
    label: "Defensive Security",
    name: "defense_threat_hunt",
    description:
      "Proactive threat hunting: form hypotheses, collect data from multiple sources, analyze for indicators, investigate findings, and document hunt results.",
    parameters: DefenseThreatHuntSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const workspace = getDefenseWorkspace();

      try {
        const hypothesis = readStringParam(params, "hypothesis", { required: true });
        const dataSources = Array.isArray(params.data_sources)
          ? (params.data_sources.filter((d) => typeof d === "string") as string[])
          : undefined;
        const timeRange = readStringParam(params, "time_range");
        const iocs = Array.isArray(params.iocs)
          ? (params.iocs.filter((i) => typeof i === "string") as string[])
          : undefined;
        const ttps = Array.isArray(params.ttps)
          ? (params.ttps.filter((t) => typeof t === "string") as string[])
          : undefined;
        const output = readStringParam(params, "output");

        let result: Record<string, unknown> = {
          status: "success",
          hypothesis,
        };

        const sources = dataSources ?? ["process_logs", "network_traffic", "system_logs"];
        const range = timeRange ?? "last_7_days";

        result.data_sources = sources;
        result.time_range = range;

        if (iocs) {
          result.iocs = iocs;
        }
        if (ttps) {
          result.ttps = ttps;
        }

        result.message = `Threat hunt planned: ${hypothesis}. Data sources: ${sources.join(", ")}. Time range: ${range}.${iocs ? ` IOCs: ${iocs.join(", ")}.` : ""}${ttps ? ` TTPs: ${ttps.join(", ")}.` : ""}`;

        // Save hunt plan if output requested
        if (output) {
          const outputPath = path.join(workspace, output);
          const huntPlan = {
            hypothesis,
            data_sources: sources,
            time_range: range,
            iocs: iocs ?? [],
            ttps: ttps ?? [],
            created_at: new Date().toISOString(),
          };
          await fs.writeFile(outputPath, JSON.stringify(huntPlan, null, 2));
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

export function createDefenseLogAnalysisTool(): AnyAgentTool {
  return {
    label: "Defensive Security",
    name: "defense_log_analysis",
    description:
      "Analyze security logs: firewall logs, web server logs, authentication logs, DNS logs, proxy logs, endpoint logs, and application logs. Correlate events and identify anomalies.",
    parameters: DefenseLogAnalysisSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const workspace = getDefenseWorkspace();

      try {
        const logType = readStringParam(params, "log_type") as
          | "firewall"
          | "web_server"
          | "authentication"
          | "dns"
          | "proxy"
          | "endpoint"
          | "application"
          | undefined;
        const logSource = readStringParam(params, "log_source", { required: true });
        const query = readStringParam(params, "query");
        const timeRange = readStringParam(params, "time_range");
        const output = readStringParam(params, "output");

        let result: Record<string, unknown> = {
          status: "success",
          log_type: logType ?? "application",
          log_source: logSource,
        };

        if (query) {
          result.query = query;
        }
        if (timeRange) {
          result.time_range = timeRange;
        }

        // Type-specific analysis guidance
        if (logType === "firewall") {
          result.message = `Firewall log analysis planned for ${logSource}. Look for blocked connections, port scans, suspicious IP addresses, and policy violations.`;
          result.analysis_focus = ["blocked_connections", "port_scans", "suspicious_ips", "policy_violations"];
        } else if (logType === "web_server") {
          result.message = `Web server log analysis planned for ${logSource}. Look for SQL injection attempts, XSS attacks, directory traversal, and unusual access patterns.`;
          result.analysis_focus = ["sql_injection", "xss", "directory_traversal", "access_patterns"];
        } else if (logType === "authentication") {
          result.message = `Authentication log analysis planned for ${logSource}. Look for brute force attempts, account lockouts, privilege escalation, and failed logins.`;
          result.analysis_focus = ["brute_force", "account_lockouts", "privilege_escalation", "failed_logins"];
        } else if (logType === "dns") {
          result.message = `DNS log analysis planned for ${logSource}. Look for DNS tunneling, malicious domains, DGA patterns, and unusual queries.`;
          result.analysis_focus = ["dns_tunneling", "malicious_domains", "dga_patterns", "unusual_queries"];
        } else if (logType === "proxy") {
          result.message = `Proxy log analysis planned for ${logSource}. Look for blocked sites, data exfiltration, command and control communications, and policy violations.`;
          result.analysis_focus = ["blocked_sites", "data_exfiltration", "c2_communications", "policy_violations"];
        } else if (logType === "endpoint") {
          result.message = `Endpoint log analysis planned for ${logSource}. Look for process execution, file modifications, registry changes, and suspicious activity.`;
          result.analysis_focus = ["process_execution", "file_modifications", "registry_changes", "suspicious_activity"];
        } else {
          result.message = `Log analysis planned for ${logSource}. Analyze logs for security events and anomalies.`;
        }

        // Save analysis results if output requested
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

export function createDefenseForensicsTool(): AnyAgentTool {
  return {
    label: "Defensive Security",
    name: "defense_forensics",
    description:
      "Digital forensics automation: collect evidence, analyze artifacts, create timelines, extract artifacts, and perform memory analysis.",
    parameters: DefenseForensicsSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const workspace = getDefenseWorkspace();

      try {
        const action = readStringParam(params, "action", { required: true }) as
          | "collect"
          | "analyze"
          | "timeline"
          | "artifact_extraction"
          | "memory_analysis";
        const target = readStringParam(params, "target", { required: true });
        const scope = Array.isArray(params.scope)
          ? (params.scope.filter((s) => typeof s === "string") as string[])
          : undefined;
        const output = readStringParam(params, "output");

        let result: Record<string, unknown> = {
          status: "success",
          action,
          target,
        };

        // Collect evidence
        if (action === "collect") {
          const collectScope = scope ?? ["filesystem", "memory", "network", "logs"];
          result.scope = collectScope;
          result.message = `Forensic evidence collection planned for ${target}. Scope: ${collectScope.join(", ")}. Use write blockers and maintain chain of custody.`;
        }

        // Analyze artifacts
        if (action === "analyze") {
          const analyzeScope = scope ?? ["files", "registry", "browser", "email"];
          result.scope = analyzeScope;
          result.message = `Forensic analysis planned for ${target}. Scope: ${analyzeScope.join(", ")}. Analyze artifacts for evidence of compromise.`;
        }

        // Create timeline
        if (action === "timeline") {
          result.message = `Forensic timeline creation planned for ${target}. Correlate events from multiple sources to create chronological timeline.`;
        }

        // Extract artifacts
        if (action === "artifact_extraction") {
          const artifactScope = scope ?? ["prefetch", "jumplists", "shellbags", "lnk_files"];
          result.scope = artifactScope;
          result.message = `Artifact extraction planned for ${target}. Artifacts: ${artifactScope.join(", ")}.`;
        }

        // Memory analysis
        if (action === "memory_analysis") {
          result.message = `Memory analysis planned for ${target}. Analyze memory dump for processes, network connections, and injected code.`;
        }

        // Save forensics report if output requested
        if (output) {
          const outputPath = path.join(workspace, output);
          const forensicsReport = {
            action,
            target,
            scope: scope ?? [],
            created_at: new Date().toISOString(),
            findings: [],
          };
          await fs.writeFile(outputPath, JSON.stringify(forensicsReport, null, 2));
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

export function createDefenseMalwareAnalysisTool(): AnyAgentTool {
  return {
    label: "Defensive Security",
    name: "defense_malware_analysis",
    description:
      "Malware analysis workflows: analyze samples, run in sandbox, perform static analysis, perform dynamic analysis, and extract IOCs.",
    parameters: DefenseMalwareAnalysisSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const workspace = getDefenseWorkspace();

      try {
        const action = readStringParam(params, "action", { required: true }) as
          | "analyze"
          | "sandbox"
          | "static"
          | "dynamic"
          | "ioc_extraction";
        const sample = readStringParam(params, "sample", { required: true });
        const sandbox = readStringParam(params, "sandbox");
        const output = readStringParam(params, "output");

        let result: Record<string, unknown> = {
          status: "success",
          action,
          sample,
        };

        // Analyze (general)
        if (action === "analyze") {
          result.message = `Malware analysis planned for ${sample}. Perform comprehensive analysis including static and dynamic analysis.`;
        }

        // Sandbox analysis
        if (action === "sandbox") {
          const sandboxEnv = sandbox ?? "cuckoo";
          result.sandbox = sandboxEnv;
          result.message = `Sandbox analysis planned for ${sample} using ${sandboxEnv}. Execute sample in isolated environment and monitor behavior.`;
        }

        // Static analysis
        if (action === "static") {
          result.message = `Static analysis planned for ${sample}. Analyze file structure, strings, imports, and code without execution.`;
          result.analysis_type = "static";
        }

        // Dynamic analysis
        if (action === "dynamic") {
          result.message = `Dynamic analysis planned for ${sample}. Execute sample in controlled environment and monitor behavior, network activity, and system changes.`;
          result.analysis_type = "dynamic";
        }

        // IOC extraction
        if (action === "ioc_extraction") {
          result.message = `IOC extraction planned for ${sample}. Extract indicators of compromise: IPs, domains, hashes, file paths, registry keys.`;
          result.iocs = [];
        }

        // Save analysis report if output requested
        if (output) {
          const outputPath = path.join(workspace, output);
          const analysisReport = {
            action,
            sample,
            sandbox: sandbox ?? null,
            created_at: new Date().toISOString(),
            findings: [],
            iocs: [],
          };
          await fs.writeFile(outputPath, JSON.stringify(analysisReport, null, 2));
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

// SIEM Integration Tools

export function createDefenseSplunkTool(): AnyAgentTool {
  return {
    label: "Defensive Security",
    name: "defense_splunk",
    description:
      "Splunk integration: execute queries, create dashboards, manage alerts, and correlate events. Requires Splunk API endpoint and credentials.",
    parameters: DefenseSplunkSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const config = loadConfig();
      const workspace = getDefenseWorkspace();

      try {
        const action = readStringParam(params, "action", { required: true }) as
          | "query"
          | "dashboard"
          | "alert"
          | "correlate";
        const query = readStringParam(params, "query");
        const dashboard = readStringParam(params, "dashboard");
        const timeRange = readStringParam(params, "time_range");
        const output = readStringParam(params, "output");

        const siemConfig = config.security?.defense?.siem;
        const splunkEndpoint = siemConfig?.provider === "splunk" ? siemConfig.endpoint : undefined;

        let result: Record<string, unknown> = {
          status: "success",
          provider: "splunk",
          action,
        };

        // Query
        if (action === "query") {
          if (!query) {
            return jsonResult({
              status: "error",
              error: "query required for query action",
            });
          }
          result.query = query;
          result.time_range = timeRange ?? "last_24_hours";
          result.message = `Splunk query planned: ${query}${timeRange ? ` (time_range: ${timeRange})` : ""}.${splunkEndpoint ? ` Endpoint: ${splunkEndpoint}` : " Configure Splunk endpoint in security.defense.siem."}`;
        }

        // Dashboard
        if (action === "dashboard") {
          if (!dashboard) {
            return jsonResult({
              status: "error",
              error: "dashboard name required for dashboard action",
            });
          }
          result.dashboard = dashboard;
          result.message = `Splunk dashboard access planned: ${dashboard}. Create or view dashboard in Splunk.`;
        }

        // Alert
        if (action === "alert") {
          result.message = "Splunk alert management planned. Create, modify, or view alerts in Splunk.";
        }

        // Correlate
        if (action === "correlate") {
          if (!query) {
            return jsonResult({
              status: "error",
              error: "query required for correlate action",
            });
          }
          result.query = query;
          result.message = `Splunk event correlation planned: ${query}. Correlate events across multiple sources.`;
        }

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

export function createDefenseElasticTool(): AnyAgentTool {
  return {
    label: "Defensive Security",
    name: "defense_elastic",
    description:
      "Elastic Security integration: execute queries, detect threats, investigate alerts, and correlate events. Requires Elastic Security API endpoint and credentials.",
    parameters: DefenseElasticSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const config = loadConfig();
      const workspace = getDefenseWorkspace();

      try {
        const action = readStringParam(params, "action", { required: true }) as
          | "query"
          | "detect"
          | "investigate"
          | "correlate";
        const query = readStringParam(params, "query");
        const index = readStringParam(params, "index");
        const timeRange = readStringParam(params, "time_range");
        const output = readStringParam(params, "output");

        const siemConfig = config.security?.defense?.siem;
        const elasticEndpoint = siemConfig?.provider === "elastic" ? siemConfig.endpoint : undefined;

        let result: Record<string, unknown> = {
          status: "success",
          provider: "elastic",
          action,
        };

        // Query
        if (action === "query") {
          if (!query) {
            return jsonResult({
              status: "error",
              error: "query required for query action",
            });
          }
          result.query = query;
          result.index = index ?? "security-*";
          result.time_range = timeRange ?? "last_24_hours";
          result.message = `Elastic Security query planned: ${query}${index ? ` (index: ${index})` : ""}${timeRange ? ` (time_range: ${timeRange})` : ""}.${elasticEndpoint ? ` Endpoint: ${elasticEndpoint}` : " Configure Elastic endpoint in security.defense.siem."}`;
        }

        // Detect
        if (action === "detect") {
          result.message = "Elastic Security threat detection planned. Query detection rules and alerts.";
        }

        // Investigate
        if (action === "investigate") {
          result.message = "Elastic Security investigation planned. Investigate alerts and correlate with threat intelligence.";
        }

        // Correlate
        if (action === "correlate") {
          if (!query) {
            return jsonResult({
              status: "error",
              error: "query required for correlate action",
            });
          }
          result.query = query;
          result.message = `Elastic Security event correlation planned: ${query}. Correlate events across indices.`;
        }

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

export function createDefenseSentinelTool(): AnyAgentTool {
  return {
    label: "Defensive Security",
    name: "defense_sentinel",
    description:
      "Azure Sentinel integration: execute queries, manage incidents, run playbooks, and perform threat hunting. Requires Azure Sentinel API credentials.",
    parameters: DefenseSentinelSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const config = loadConfig();
      const workspace = getDefenseWorkspace();

      try {
        const action = readStringParam(params, "action", { required: true }) as
          | "query"
          | "incident"
          | "playbook"
          | "hunt";
        const query = readStringParam(params, "query");
        const incidentId = readStringParam(params, "incident_id");
        const playbook = readStringParam(params, "playbook");
        const timeRange = readStringParam(params, "time_range");
        const output = readStringParam(params, "output");

        const siemConfig = config.security?.defense?.siem;
        const sentinelEndpoint = siemConfig?.provider === "sentinel" ? siemConfig.endpoint : undefined;

        let result: Record<string, unknown> = {
          status: "success",
          provider: "sentinel",
          action,
        };

        // Query
        if (action === "query") {
          if (!query) {
            return jsonResult({
              status: "error",
              error: "query required for query action",
            });
          }
          result.query = query;
          result.time_range = timeRange ?? "last_24_hours";
          result.message = `Azure Sentinel query planned: ${query}${timeRange ? ` (time_range: ${timeRange})` : ""}.${sentinelEndpoint ? ` Endpoint: ${sentinelEndpoint}` : " Configure Sentinel endpoint in security.defense.siem."}`;
        }

        // Incident
        if (action === "incident") {
          if (!incidentId) {
            return jsonResult({
              status: "error",
              error: "incident_id required for incident action",
            });
          }
          result.incident_id = incidentId;
          result.message = `Azure Sentinel incident management planned: ${incidentId}. View, update, or investigate incident.`;
        }

        // Playbook
        if (action === "playbook") {
          if (!playbook) {
            return jsonResult({
              status: "error",
              error: "playbook name required for playbook action",
            });
          }
          result.playbook = playbook;
          result.message = `Azure Sentinel playbook execution planned: ${playbook}. Run automated response playbook.`;
        }

        // Hunt
        if (action === "hunt") {
          if (!query) {
            return jsonResult({
              status: "error",
              error: "query required for hunt action",
            });
          }
          result.query = query;
          result.time_range = timeRange ?? "last_7_days";
          result.message = `Azure Sentinel threat hunting planned: ${query}${timeRange ? ` (time_range: ${timeRange})` : ""}.`;
        }

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

export function createDefenseCrowdstrikeTool(): AnyAgentTool {
  return {
    label: "Defensive Security",
    name: "defense_crowdstrike",
    description:
      "CrowdStrike integration: query detections, investigate alerts, perform threat hunting, and manage endpoints. Requires CrowdStrike API credentials.",
    parameters: DefenseCrowdstrikeSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const config = loadConfig();
      const workspace = getDefenseWorkspace();

      try {
        const action = readStringParam(params, "action", { required: true }) as
          | "query"
          | "detect"
          | "investigate"
          | "hunt";
        const query = readStringParam(params, "query");
        const deviceId = readStringParam(params, "device_id");
        const timeRange = readStringParam(params, "time_range");
        const output = readStringParam(params, "output");

        const siemConfig = config.security?.defense?.siem;
        const crowdstrikeEndpoint = siemConfig?.provider === "crowdstrike" ? siemConfig.endpoint : undefined;

        let result: Record<string, unknown> = {
          status: "success",
          provider: "crowdstrike",
          action,
        };

        // Query
        if (action === "query") {
          if (!query) {
            return jsonResult({
              status: "error",
              error: "query required for query action",
            });
          }
          result.query = query;
          result.time_range = timeRange ?? "last_24_hours";
          result.message = `CrowdStrike query planned: ${query}${timeRange ? ` (time_range: ${timeRange})` : ""}.${crowdstrikeEndpoint ? ` Endpoint: ${crowdstrikeEndpoint}` : " Configure CrowdStrike endpoint in security.defense.siem."}`;
        }

        // Detect
        if (action === "detect") {
          result.message = "CrowdStrike detection query planned. Query detections and alerts from Falcon platform.";
        }

        // Investigate
        if (action === "investigate") {
          if (deviceId) {
            result.device_id = deviceId;
            result.message = `CrowdStrike investigation planned for device ${deviceId}. Investigate detections and perform threat hunting.`;
          } else {
            result.message = "CrowdStrike investigation planned. Investigate alerts and perform threat hunting.";
          }
        }

        // Hunt
        if (action === "hunt") {
          if (!query) {
            return jsonResult({
              status: "error",
              error: "query required for hunt action",
            });
          }
          result.query = query;
          result.time_range = timeRange ?? "last_7_days";
          result.message = `CrowdStrike threat hunting planned: ${query}${timeRange ? ` (time_range: ${timeRange})` : ""}.`;
        }

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

export function createDefenseMispTool(): AnyAgentTool {
  return {
    label: "Defensive Security",
    name: "defense_misp",
    description:
      "MISP (Malware Information Sharing Platform) integration: search IOCs, add indicators, export threat intelligence, and import threat feeds. Supports STIX format.",
    parameters: DefenseMispSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const workspace = getDefenseWorkspace();

      try {
        const action = readStringParam(params, "action", { required: true }) as
          | "search"
          | "add"
          | "export"
          | "import";
        const query = readStringParam(params, "query");
        const ioc = readStringParam(params, "ioc");
        const format = readStringParam(params, "format") as "json" | "stix" | "csv" | undefined;
        const output = readStringParam(params, "output");

        let result: Record<string, unknown> = {
          status: "success",
          provider: "misp",
          action,
        };

        // Search
        if (action === "search") {
          if (!query) {
            return jsonResult({
              status: "error",
              error: "query required for search action",
            });
          }
          result.query = query;
          result.message = `MISP IOC search planned: ${query}. Search threat intelligence platform for indicators.`;
        }

        // Add
        if (action === "add") {
          if (!ioc) {
            return jsonResult({
              status: "error",
              error: "ioc required for add action",
            });
          }
          result.ioc = ioc;
          result.message = `MISP IOC addition planned: ${ioc}. Add indicator to threat intelligence platform.`;
        }

        // Export
        if (action === "export") {
          const exportFormat = format ?? "stix";
          result.format = exportFormat;
          result.message = `MISP threat intelligence export planned${query ? `: ${query}` : ""} in ${exportFormat} format. Export indicators for sharing.`;
        }

        // Import
        if (action === "import") {
          const importFormat = format ?? "stix";
          result.format = importFormat;
          result.message = `MISP threat intelligence import planned in ${importFormat} format. Import indicators from external sources.`;
        }

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
