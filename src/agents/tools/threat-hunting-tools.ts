import { Type } from "@sinclair/typebox";
import { loadConfig } from "../../config/config.js";
import { ThreatIntelligenceStore } from "../../cybersecurity/threat-intelligence/store.js";
import { IoCMatcher } from "../../cybersecurity/threat-intelligence/matcher.js";
import { optionalStringEnum } from "../schema/typebox.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "../../infra/state-dir.js";

// Singleton instances
let storeInstance: ThreatIntelligenceStore | null = null;

function getStore(): ThreatIntelligenceStore {
  if (!storeInstance) {
    const config = loadConfig();
    const storagePath = config.cybersecurity?.threatIntelligence?.storagePath;
    storeInstance = new ThreatIntelligenceStore(storagePath);
  }
  return storeInstance;
}

// Threat Hunting Tool Schemas

const ThreatHuntProactiveSchema = Type.Object({
  actor_id: Type.String(),
  sources: Type.Optional(Type.Array(Type.String())),
  time_range: Type.Optional(Type.String()),
  iocs: Type.Optional(Type.Array(Type.String())),
  ttps: Type.Optional(Type.Array(Type.String())),
  output: Type.Optional(Type.String()),
});

const ThreatHuntSectorSchema = Type.Object({
  sector: Type.String(),
  actor_id: Type.Optional(Type.String()),
  time_range: Type.Optional(Type.String()),
  alert_on_shift: Type.Optional(Type.Boolean()),
  output: Type.Optional(Type.String()),
});

const ThreatHuntAnomalySchema = Type.Object({
  data_source: Type.String(),
  anomaly_type: optionalStringEnum([
    "living_off_the_land",
    "time_based",
    "command_sequence",
    "process_injection",
    "credential_access",
  ] as const),
  time_range: Type.Optional(Type.String()),
  baseline: Type.Optional(Type.String()),
  output: Type.Optional(Type.String()),
});

// Threat Hunting Tools

export function createThreatHuntProactiveTool(): AnyAgentTool {
  return {
    label: "Threat Hunting",
    name: "threat_hunt_proactive",
    description:
      "Proactively hunt for specific threat actors across telemetry, VirusTotal, Shodan, Censys, and other sources. Search for known IOCs and TTPs, correlate findings, and generate hunting reports. Use this to actively chase known adversaries like APT29, Volt Typhoon, or Scattered Spider.",
    parameters: ThreatHuntProactiveSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const config = loadConfig();
      const workspace = config.security?.automation?.workspace ?? "~/.openclaw/security/automation/";
      const workspacePath = workspace.startsWith("~")
        ? workspace.replace("~", resolveStateDir())
        : workspace;
      await fs.mkdir(workspacePath, { recursive: true }).catch(() => {});

      try {
        const actorId = readStringParam(params, "actor_id", { required: true });
        const sources = Array.isArray(params.sources)
          ? (params.sources.filter((s) => typeof s === "string") as string[])
          : undefined;
        const timeRange = readStringParam(params, "time_range");
        const iocs = Array.isArray(params.iocs)
          ? (params.iocs.filter((i) => typeof i === "string") as string[])
          : undefined;
        const ttps = Array.isArray(params.ttps)
          ? (params.ttps.filter((t) => typeof t === "string") as string[])
          : undefined;
        const output = readStringParam(params, "output");

        const store = getStore();

        // Get threat actor profile
        const actors = await store.searchActors({ id: actorId });
        const actor = actors.length > 0 ? actors[0] : null;

        if (!actor) {
          return jsonResult({
            status: "error",
            error: `Threat actor ${actorId} not found. Track the actor first using threat_track_actor.`,
          });
        }

        // Get actor IOCs and TTPs
        const actorIocs = iocs ?? [];
        const actorTtps = ttps ?? actor.ttps ?? [];

        // Query threat intelligence store for actor IOCs
        const storedIocs = await store.searchIocs({ actorId });
        const allIocs = [...new Set([...actorIocs, ...storedIocs.map((i) => i.value)])];

        const huntSources = sources ?? ["telemetry", "virustotal", "shodan", "censys"];
        const range = timeRange ?? "last_30_days";

        let result: Record<string, unknown> = {
          status: "success",
          actor_id: actorId,
          actor_name: actor.name,
          sources: huntSources,
          time_range: range,
          iocs_searched: allIocs.length,
          ttps_searched: actorTtps.length,
        };

        // Search telemetry
        if (huntSources.includes("telemetry")) {
          result.telemetry_search = {
            status: "planned",
            message: `Search telemetry for ${allIocs.length} IOCs and ${actorTtps.length} TTPs associated with ${actorId}. Query SIEM/logs for indicators.`,
            iocs: allIocs,
            ttps: actorTtps,
          };
        }

        // Query VirusTotal
        if (huntSources.includes("virustotal")) {
          result.virustotal_search = {
            status: "planned",
            message: `Query VirusTotal for ${actorId} indicators. Search for IOCs: ${allIocs.slice(0, 5).join(", ")}${allIocs.length > 5 ? `... (${allIocs.length} total)` : ""}. Requires VirusTotal API key.`,
            iocs: allIocs,
          };
        }

        // Query Shodan
        if (huntSources.includes("shodan")) {
          result.shodan_search = {
            status: "planned",
            message: `Query Shodan for ${actorId} infrastructure. Search for IPs and domains associated with ${actorId}. Requires Shodan API key.`,
            iocs: allIocs.filter((i) => IoCMatcher.inferType(i) === "ip" || IoCMatcher.inferType(i) === "domain"),
          };
        }

        // Query Censys
        if (huntSources.includes("censys")) {
          result.censys_search = {
            status: "planned",
            message: `Query Censys for ${actorId} infrastructure. Search certificates and infrastructure. Requires Censys API credentials.`,
            iocs: allIocs.filter((i) => IoCMatcher.inferType(i) === "ip" || IoCMatcher.inferType(i) === "domain"),
          };
        }

        // Generate hunting queries
        const huntingQueries = [];
        for (const ioc of allIocs.slice(0, 10)) {
          const iocType = IoCMatcher.inferType(ioc);
          if (iocType === "ip") {
            huntingQueries.push(`Search logs for connections to ${ioc}`);
          } else if (iocType === "domain") {
            huntingQueries.push(`Search DNS logs for queries to ${ioc}`);
          } else if (iocType === "hash") {
            huntingQueries.push(`Search file hashes for ${ioc}`);
          }
        }

        for (const ttp of actorTtps.slice(0, 5)) {
          huntingQueries.push(`Search for MITRE ATT&CK technique ${ttp}`);
        }

        result.hunting_queries = huntingQueries;
        result.message = `Proactive threat hunt planned for ${actor.name} (${actorId}). Searching ${huntSources.length} sources for ${allIocs.length} IOCs and ${actorTtps.length} TTPs.`;

        // Generate hunting report structure
        const huntReport = {
          actor_id: actorId,
          actor_name: actor.name,
          hunt_date: new Date().toISOString(),
          time_range: range,
          sources: huntSources,
          iocs_searched: allIocs,
          ttps_searched: actorTtps,
          findings: [],
          recommendations: [],
        };

        // Save hunt plan if output requested
        if (output) {
          const outputPath = path.join(workspacePath, output);
          await fs.writeFile(outputPath, JSON.stringify(huntReport, null, 2));
          result.hunt_plan_file = outputPath;
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

export function createThreatHuntSectorTool(): AnyAgentTool {
  return {
    label: "Threat Hunting",
    name: "threat_hunt_sector",
    description:
      "Track sector-specific attack patterns and hunt for threats targeting specific sectors. Monitor when threat actors shift sectors (e.g., Scattered Spider: retail → insurance → aviation) and generate sector-specific hunting queries.",
    parameters: ThreatHuntSectorSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const config = loadConfig();
      const workspace = config.security?.automation?.workspace ?? "~/.openclaw/security/automation/";
      const workspacePath = workspace.startsWith("~")
        ? workspace.replace("~", resolveStateDir())
        : workspace;
      await fs.mkdir(workspacePath, { recursive: true }).catch(() => {});

      try {
        const sector = readStringParam(params, "sector", { required: true });
        const actorId = readStringParam(params, "actor_id");
        const timeRange = readStringParam(params, "time_range");
        const alertOnShift = params.alert_on_shift !== false; // Default true
        const output = readStringParam(params, "output");

        const store = getStore();
        const range = timeRange ?? "last_90_days";

        let result: Record<string, unknown> = {
          status: "success",
          sector,
          time_range: range,
          alert_on_shift: alertOnShift,
        };

        // Get campaigns targeting this sector
        const campaigns = await store.searchCampaigns({ sector });
        const sectorCampaigns = campaigns.filter((c) => c.status === "active");

        result.active_campaigns = sectorCampaigns.length;
        result.campaigns = sectorCampaigns.map((c) => ({
          id: c.id,
          actor_id: c.actorId,
          name: c.name,
          status: c.status,
        }));

        // If actor specified, check for sector shifts
        if (actorId) {
          result.actor_id = actorId;
          const actorCampaigns = await store.searchCampaigns({ actorId });
          const otherSectors = actorCampaigns
            .filter((c) => c.sector && c.sector !== sector)
            .map((c) => c.sector)
            .filter((s): s is string => s !== undefined);

          if (otherSectors.length > 0) {
            result.sector_shift_detected = true;
            result.previous_sectors = [...new Set(otherSectors)];
            result.message = `Sector shift detected: ${actorId} has targeted ${[...new Set(otherSectors)].join(", ")} and may be shifting to ${sector}. High alert recommended.`;
          } else {
            result.sector_shift_detected = false;
            result.message = `Monitoring ${actorId} activity in ${sector} sector.`;
          }
        }

        // Generate sector-specific hunting queries
        const sectorQueries = [
          `Search for attacks targeting ${sector} sector infrastructure`,
          `Monitor for ${sector}-specific attack patterns`,
          `Track credential access attempts in ${sector} systems`,
          `Look for lateral movement within ${sector} networks`,
        ];

        if (sector === "retail") {
          sectorQueries.push("Monitor point-of-sale systems", "Track payment card data access");
        } else if (sector === "insurance") {
          sectorQueries.push("Monitor policy and claims systems", "Track customer data access");
        } else if (sector === "aviation") {
          sectorQueries.push("Monitor flight operations systems", "Track critical infrastructure access");
        } else if (sector === "healthcare") {
          sectorQueries.push("Monitor patient data access", "Track medical device systems");
        }

        result.hunting_queries = sectorQueries;
        result.message = result.message ?? `Sector-specific threat hunting planned for ${sector} sector. ${sectorCampaigns.length} active campaigns detected.`;

        // Generate sector intelligence report
        const sectorReport = {
          sector,
          actor_id: actorId,
          hunt_date: new Date().toISOString(),
          time_range: range,
          active_campaigns: sectorCampaigns.length,
          campaigns: sectorCampaigns,
          hunting_queries: sectorQueries,
          recommendations: [
            `Implement sector-specific security controls for ${sector}`,
            `Monitor for sector-specific attack patterns`,
            `Train staff on ${sector}-specific threats`,
          ],
        };

        if (output) {
          const outputPath = path.join(workspacePath, output);
          await fs.writeFile(outputPath, JSON.stringify(sectorReport, null, 2));
          result.report_file = outputPath;
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

export function createThreatHuntAnomalyTool(): AnyAgentTool {
  return {
    label: "Threat Hunting",
    name: "threat_hunt_anomaly",
    description:
      "AI-powered anomaly detection for threat hunting. Detect living-off-the-land techniques, time-based anomalies (operating outside normal hours), unusual command sequences, process injection, and credential access patterns. Correlate anomalies with threat actor TTPs.",
    parameters: ThreatHuntAnomalySchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const config = loadConfig();
      const workspace = config.security?.automation?.workspace ?? "~/.openclaw/security/automation/";
      const workspacePath = workspace.startsWith("~")
        ? workspace.replace("~", resolveStateDir())
        : workspace;
      await fs.mkdir(workspacePath, { recursive: true }).catch(() => {});

      try {
        const dataSource = readStringParam(params, "data_source", { required: true });
        const anomalyType = readStringParam(params, "anomaly_type") as
          | "living_off_the_land"
          | "time_based"
          | "command_sequence"
          | "process_injection"
          | "credential_access"
          | undefined;
        const timeRange = readStringParam(params, "time_range");
        const baseline = readStringParam(params, "baseline");
        const output = readStringParam(params, "output");

        const range = timeRange ?? "last_7_days";

        let result: Record<string, unknown> = {
          status: "success",
          data_source: dataSource,
          anomaly_type: anomalyType ?? "living_off_the_land",
          time_range: range,
        };

        // Living off the land detection
        if (anomalyType === "living_off_the_land" || !anomalyType) {
          result.detection_focus = [
            "legitimate_system_tools",
            "powershell_usage",
            "certutil_usage",
            "bitsadmin_usage",
            "regsvr32_usage",
            "wmic_usage",
            "schtasks_usage",
          ];
          result.message = `Living-off-the-land detection planned for ${dataSource}. Search for legitimate system tools used maliciously (PowerShell, certutil, bitsadmin, regsvr32, WMI, scheduled tasks).`;
          result.anomaly_indicators = [
            "Unusual PowerShell command-line arguments",
            "Certutil used for file download/decoding",
            "Bitsadmin used for payload delivery",
            "Regsvr32 used to execute scripts",
            "WMI used for lateral movement",
            "Scheduled tasks created outside normal hours",
          ];
        }

        // Time-based anomalies
        if (anomalyType === "time_based") {
          result.detection_focus = ["operating_hours", "weekend_activity", "holiday_activity", "off_hours_access"];
          result.message = `Time-based anomaly detection planned for ${dataSource}. Detect activity outside normal operating hours (e.g., Beijing hours for Volt Typhoon).`;
          result.anomaly_indicators = [
            "Activity outside normal business hours",
            "Weekend or holiday activity",
            "Activity during off-hours",
            "Unusual time patterns",
          ];
          if (baseline) {
            result.baseline = baseline;
            result.message += ` Baseline: ${baseline}`;
          }
        }

        // Command sequence anomalies
        if (anomalyType === "command_sequence") {
          result.detection_focus = ["command_chains", "unusual_sequences", "rapid_execution"];
          result.message = `Command sequence anomaly detection planned for ${dataSource}. Detect unusual command execution patterns.`;
          result.anomaly_indicators = [
            "Unusual command sequences",
            "Rapid command execution",
            "Commands not typically used together",
            "Suspicious command chains",
          ];
        }

        // Process injection detection
        if (anomalyType === "process_injection") {
          result.detection_focus = ["process_hollowing", "dll_injection", "thread_hijacking"];
          result.message = `Process injection detection planned for ${dataSource}. Detect process injection techniques (T1055).`;
          result.anomaly_indicators = [
            "Process hollowing",
            "DLL injection",
            "Thread hijacking",
            "Process doppelganging",
          ];
        }

        // Credential access detection
        if (anomalyType === "credential_access") {
          result.detection_focus = ["credential_dumping", "lsass_access", "registry_access", "keyloggers"];
          result.message = `Credential access detection planned for ${dataSource}. Detect credential dumping and access patterns.`;
          result.anomaly_indicators = [
            "LSASS process access",
            "Registry credential access",
            "Credential dumping tools",
            "Keylogger activity",
          ];
        }

        // Correlate with threat actors
        const store = getStore();
        const actors = await store.searchActors({});
        const relevantActors = actors.filter((a) => {
          if (anomalyType === "living_off_the_land") {
            return a.name?.toLowerCase().includes("volt") || a.id === "volt-typhoon";
          }
          if (anomalyType === "time_based") {
            return a.attribution === "PRC" || a.id === "volt-typhoon";
          }
          return true;
        });

        result.relevant_threat_actors = relevantActors.map((a) => ({
          id: a.id,
          name: a.name,
          attribution: a.attribution,
        }));

        // Generate anomaly detection queries
        const detectionQueries = [];
        if (anomalyType === "living_off_the_land" || !anomalyType) {
          detectionQueries.push(
            "Search for PowerShell with encoded commands",
            "Search for certutil used for file operations",
            "Search for bitsadmin download operations",
            "Search for regsvr32 script execution",
          );
        }
        if (anomalyType === "time_based") {
          detectionQueries.push(
            "Search for activity outside business hours",
            "Search for weekend/holiday activity",
            "Search for activity in unusual timezones",
          );
        }

        result.detection_queries = detectionQueries;
        result.message = result.message ?? `Anomaly detection planned for ${dataSource}. Type: ${anomalyType ?? "living_off_the_land"}.`;

        // Generate anomaly detection report
        const anomalyReport = {
          data_source: dataSource,
          anomaly_type: anomalyType ?? "living_off_the_land",
          time_range: range,
          baseline: baseline ?? null,
          detection_focus: result.detection_focus,
          anomaly_indicators: result.anomaly_indicators,
          relevant_threat_actors: result.relevant_threat_actors,
          detection_queries: detectionQueries,
          findings: [],
        };

        if (output) {
          const outputPath = path.join(workspacePath, output);
          await fs.writeFile(outputPath, JSON.stringify(anomalyReport, null, 2));
          result.report_file = outputPath;
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
