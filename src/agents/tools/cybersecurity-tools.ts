import { Type } from "@sinclair/typebox";
import { loadConfig } from "../../config/config.js";
import { IoCMatcher } from "../../cybersecurity/threat-intelligence/matcher.js";
import { ThreatIntelligenceStore } from "../../cybersecurity/threat-intelligence/store.js";
import type {
  Campaign,
  IndicatorOfCompromise,
  ThreatActor,
} from "../../cybersecurity/types.js";
import { optionalStringEnum } from "../schema/typebox.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";

// Singleton instance for state persistence
let storeInstance: ThreatIntelligenceStore | null = null;

function getStore(): ThreatIntelligenceStore {
  if (!storeInstance) {
    const config = loadConfig();
    const storagePath = config.cybersecurity?.threatIntelligence?.storagePath;
    storeInstance = new ThreatIntelligenceStore(storagePath);
  }
  return storeInstance;
}

// Threat Intelligence Tools

const ThreatTrackActorSchema = Type.Object({
  id: Type.String(),
  name: Type.String(),
  aliases: Type.Optional(Type.Array(Type.String())),
  attribution: Type.Optional(Type.String()),
  description: Type.Optional(Type.String()),
  ttps: Type.Optional(Type.Array(Type.String())),
  severity: Type.Optional(
    optionalStringEnum(["low", "medium", "high", "critical"] as const),
  ),
});

const ThreatAddIocSchema = Type.Object({
  value: Type.String(),
  type: optionalStringEnum(["ip", "domain", "url", "hash", "filepath", "email", "other"] as const),
  actorId: Type.Optional(Type.String()),
  campaignId: Type.Optional(Type.String()),
  confidence: optionalStringEnum(["low", "medium", "high"] as const),
  description: Type.Optional(Type.String()),
  tags: Type.Optional(Type.Array(Type.String())),
});

const ThreatSearchIocSchema = Type.Object({
  value: Type.String(),
  search_telemetry: Type.Optional(Type.Boolean()),
  data_sources: Type.Optional(Type.Array(Type.String())),
  time_range: Type.Optional(Type.String()),
});

const ThreatListCampaignsSchema = Type.Object({
  actorId: Type.Optional(Type.String()),
  status: Type.Optional(optionalStringEnum(["active", "dormant", "concluded"] as const)),
  sector: Type.Optional(Type.String()),
});

const ThreatAnalyzeCorrelationSchema = Type.Object({
  actorId: Type.Optional(Type.String()),
  campaignId: Type.Optional(Type.String()),
});

const CredentialMonitorSchema = Type.Object({
  credential_hash: Type.Optional(Type.String()),
  email: Type.Optional(Type.String()),
  domain: Type.Optional(Type.String()),
  source: Type.Optional(Type.String()),
  validate_effectiveness: Type.Optional(Type.Boolean()),
  generate_remediation: Type.Optional(Type.Boolean()),
});

export function createThreatTrackActorTool(): AnyAgentTool {
  return {
    label: "Cybersecurity",
    name: "threat_track_actor",
    description:
      "Track threat actor profiles (Volt Typhoon, Scattered Spider, APT29, etc.). Store actor metadata including aliases, attribution, TTPs, and campaigns.",
    parameters: ThreatTrackActorSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const store = getStore();

      try {
        const id = readStringParam(params, "id", { required: true });
        const name = readStringParam(params, "name", { required: true });
        const aliases = Array.isArray(params.aliases)
          ? (params.aliases.filter((a) => typeof a === "string") as string[])
          : undefined;
        const attribution = readStringParam(params, "attribution");
        const description = readStringParam(params, "description");
        const ttps = Array.isArray(params.ttps)
          ? (params.ttps.filter((t) => typeof t === "string") as string[])
          : undefined;
        const severity = readStringParam(params, "severity") as
          | "low"
          | "medium"
          | "high"
          | "critical"
          | undefined;

        const now = new Date();
        const actor: ThreatActor = {
          id,
          name,
          aliases,
          attribution,
          description,
          ttps,
          severity,
          createdAt: now,
          updatedAt: now,
        };

        await store.addActor(actor);

        return jsonResult({
          status: "success",
          message: `Threat actor ${id} tracked`,
          actor,
        });
      } catch (error) {
        return jsonResult({
          status: "error",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
}

export function createThreatAddIoCTool(): AnyAgentTool {
  return {
    label: "Cybersecurity",
    name: "threat_add_ioc",
    description:
      "Add indicators of compromise (IPs, domains, hashes, file paths). Associate with threat actors or campaigns and tag with IOC type and confidence level.",
    parameters: ThreatAddIocSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const store = getStore();

      try {
        const value = readStringParam(params, "value", { required: true });
        let type = readStringParam(params, "type") as
          | "ip"
          | "domain"
          | "url"
          | "hash"
          | "filepath"
          | "email"
          | "other"
          | undefined;

        // Infer type if not provided
        if (!type) {
          type = IoCMatcher.inferType(value);
        }

        const actorId = readStringParam(params, "actorId");
        const campaignId = readStringParam(params, "campaignId");
        const confidence = (readStringParam(params, "confidence") ||
          "medium") as "low" | "medium" | "high";
        const description = readStringParam(params, "description");
        const tags = Array.isArray(params.tags)
          ? (params.tags.filter((t) => typeof t === "string") as string[])
          : undefined;

        const now = new Date();
        const ioc: IndicatorOfCompromise = {
          id: `ioc-${Date.now()}-${Math.random().toString(36).substring(7)}`,
          value,
          type,
          actorId,
          campaignId,
          confidence,
          description,
          tags,
          createdAt: now,
          updatedAt: now,
        };

        await store.addIoc(ioc);

        return jsonResult({
          status: "success",
          message: `IOC added: ${value} (${type})`,
          ioc,
        });
      } catch (error) {
        return jsonResult({
          status: "error",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
}

export function createThreatSearchIoCTool(): AnyAgentTool {
  return {
    label: "Cybersecurity",
    name: "threat_search_ioc",
    description:
      "Search IOCs against stored threat intelligence and correlate across telemetry. Check if an indicator matches known threats, search logs/telemetry for IOCs, correlate with threat actor profiles, and generate hunting queries.",
    parameters: ThreatSearchIocSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const store = getStore();

      try {
        const value = readStringParam(params, "value", { required: true });
        const searchTelemetry = params.search_telemetry === true;
        const dataSources = Array.isArray(params.data_sources)
          ? (params.data_sources.filter((d) => typeof d === "string") as string[])
          : undefined;
        const timeRange = readStringParam(params, "time_range");

        const matches: IndicatorOfCompromise[] = [];
        for await (const ioc of store.listIocs()) {
          if (IoCMatcher.matches(ioc, value)) {
            matches.push(ioc);
          }
        }

        // Enrich with actor and campaign info
        const enriched = await Promise.all(
          matches.map(async (ioc) => {
            const actor = ioc.actorId ? await store.getActor(ioc.actorId) : null;
            const campaign = ioc.campaignId ? await store.getCampaign(ioc.campaignId) : null;
            return {
              ...ioc,
              actor: actor
                ? {
                    id: actor.id,
                    name: actor.name,
                    attribution: actor.attribution,
                  }
                : null,
              campaign: campaign
                ? {
                    id: campaign.id,
                    name: campaign.name,
                    status: campaign.status,
                  }
                : null,
            };
          }),
        );

        let result: Record<string, unknown> = {
          status: "success",
          matches: enriched,
          count: enriched.length,
        };

        // Telemetry search
        if (searchTelemetry) {
          const iocType = IoCMatcher.inferType(value);
          const sources = dataSources ?? ["siem", "firewall_logs", "dns_logs", "proxy_logs", "endpoint_logs"];
          const range = timeRange ?? "last_30_days";

          result.telemetry_search = {
            enabled: true,
            ioc_value: value,
            ioc_type: iocType,
            data_sources: sources,
            time_range: range,
            search_queries: generateTelemetryQueries(value, iocType, sources),
            message: `Telemetry search planned for ${value} (type: ${iocType}) across ${sources.length} data sources. Time range: ${range}.`,
          };

          // Generate hunting queries
          const huntingQueries = [];
          if (enriched.length > 0) {
            const actors = enriched
              .map((e) => e.actor?.name)
              .filter((n): n is string => n !== null && n !== undefined);
            if (actors.length > 0) {
              huntingQueries.push(`Search for ${actors.join(", ")} activity related to ${value}`);
            }

            const campaigns = enriched
              .map((e) => e.campaign?.name)
              .filter((n): n is string => n !== null && n !== undefined);
            if (campaigns.length > 0) {
              huntingQueries.push(`Search for ${campaigns.join(", ")} campaign indicators`);
            }
          }

          result.hunting_queries = huntingQueries;
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

function generateTelemetryQueries(
  value: string,
  iocType: string,
  sources: string[],
): string[] {
  const queries: string[] = [];

  for (const source of sources) {
    if (iocType === "ip") {
      if (source === "siem" || source === "firewall_logs") {
        queries.push(`Search ${source} for connections to ${value}`);
      }
      if (source === "proxy_logs") {
        queries.push(`Search ${source} for proxy connections to ${value}`);
      }
    } else if (iocType === "domain") {
      if (source === "dns_logs") {
        queries.push(`Search ${source} for DNS queries to ${value}`);
      }
      if (source === "proxy_logs") {
        queries.push(`Search ${source} for connections to ${value}`);
      }
      if (source === "siem") {
        queries.push(`Search ${source} for domain ${value}`);
      }
    } else if (iocType === "hash") {
      if (source === "endpoint_logs") {
        queries.push(`Search ${source} for file hash ${value}`);
      }
      if (source === "siem") {
        queries.push(`Search ${source} for hash ${value}`);
      }
    } else if (iocType === "url") {
      if (source === "proxy_logs") {
        queries.push(`Search ${source} for URL ${value}`);
      }
      if (source === "siem") {
        queries.push(`Search ${source} for URL ${value}`);
      }
    } else {
      queries.push(`Search ${source} for ${value}`);
    }
  }

  return queries;
}

export function createThreatListCampaignsTool(): AnyAgentTool {
  return {
    label: "Cybersecurity",
    name: "threat_list_campaigns",
    description:
      "List tracked campaigns and their status. Filter by actor, date range, sector, or severity.",
    parameters: ThreatListCampaignsSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const store = getStore();

      try {
        const actorId = readStringParam(params, "actorId");
        const status = readStringParam(params, "status") as
          | "active"
          | "dormant"
          | "concluded"
          | undefined;
        const sector = readStringParam(params, "sector");

        const campaigns = await store.searchCampaigns({
          actorId,
          status,
          sector,
        });

        return jsonResult({
          status: "success",
          campaigns,
          count: campaigns.length,
        });
      } catch (error) {
        return jsonResult({
          status: "error",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
}

export function createThreatAnalyzeCorrelationTool(): AnyAgentTool {
  return {
    label: "Cybersecurity",
    name: "threat_analyze_correlation",
    description:
      "Analyze correlations between IOCs, actors, and campaigns. Identify patterns and relationships.",
    parameters: ThreatAnalyzeCorrelationSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const store = getStore();

      try {
        const actorId = readStringParam(params, "actorId");
        const campaignId = readStringParam(params, "campaignId");

        const correlations: {
          actor?: ThreatActor | null;
          campaigns: Campaign[];
          iocs: IndicatorOfCompromise[];
        } = {
          campaigns: [],
          iocs: [],
        };

        if (actorId) {
          const actor = await store.getActor(actorId);
          correlations.actor = actor;

          // Find campaigns by actor
          const campaigns = await store.searchCampaigns({ actorId });
          correlations.campaigns = campaigns;

          // Find IOCs by actor
          const iocs = await store.searchIocs({ actorId });
          correlations.iocs = iocs;
        } else if (campaignId) {
          const campaign = await store.getCampaign(campaignId);
          if (campaign) {
            correlations.campaigns = [campaign];

            // Find actor if linked
            if (campaign.actorId) {
              correlations.actor = await store.getActor(campaign.actorId);
            }

            // Find IOCs for campaign
            const iocs = await store.searchIocs({ campaignId });
            correlations.iocs = iocs;
          }
        } else {
          // General correlation analysis
          const actors: ThreatActor[] = [];
          const campaigns: Campaign[] = [];
          const iocs: IndicatorOfCompromise[] = [];

          for await (const actor of store.listActors()) {
            actors.push(actor);
          }
          for await (const campaign of store.listCampaigns()) {
            campaigns.push(campaign);
          }
          for await (const ioc of store.listIocs()) {
            iocs.push(ioc);
          }

          // Find common patterns
          const actorIocCounts = new Map<string, number>();
          for (const ioc of iocs) {
            if (ioc.actorId) {
              actorIocCounts.set(ioc.actorId, (actorIocCounts.get(ioc.actorId) || 0) + 1);
            }
          }

          return jsonResult({
            status: "success",
            summary: {
              totalActors: actors.length,
              totalCampaigns: campaigns.length,
              totalIocs: iocs.length,
              actorIocCounts: Object.fromEntries(actorIocCounts),
            },
            actors: actors.slice(0, 10), // Limit for response size
            campaigns: campaigns.slice(0, 10),
            iocs: iocs.slice(0, 20),
          });
        }

        return jsonResult({
          status: "success",
          correlations,
        });
      } catch (error) {
        return jsonResult({
          status: "error",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
}

// Information Sharing Tools

const ThreatShareExportSchema = Type.Object({
  format: optionalStringEnum(["stix", "taxii", "json"] as const),
  actorIds: Type.Optional(Type.Array(Type.String())),
  campaignIds: Type.Optional(Type.Array(Type.String())),
  iocIds: Type.Optional(Type.Array(Type.String())),
});

const ThreatShareImportSchema = Type.Object({
  source: Type.String(),
  format: optionalStringEnum(["stix", "taxii", "json"] as const),
  data: Type.Optional(Type.String()),
});

const ThreatShareStatusSchema = Type.Object({});

export function createThreatShareExportTool(): AnyAgentTool {
  return {
    label: "Cybersecurity",
    name: "threat_share_export",
    description: "Export threat indicators in STIX/TAXII format. Generate CISA-compliant threat indicator packages with PII stripped per CISA 2015 requirements.",
    parameters: ThreatShareExportSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const store = getStore();
      const config = loadConfig();

      try {
        const format = (readStringParam(params, "format") || "json") as
          | "stix"
          | "taxii"
          | "json";
        const actorIds = Array.isArray(params.actorIds)
          ? (params.actorIds.filter((id) => typeof id === "string") as string[])
          : undefined;
        const campaignIds = Array.isArray(params.campaignIds)
          ? (params.campaignIds.filter((id) => typeof id === "string") as string[])
          : undefined;
        const iocIds = Array.isArray(params.iocIds)
          ? (params.iocIds.filter((id) => typeof id === "string") as string[])
          : undefined;

        // Collect IOCs
        const iocs: IndicatorOfCompromise[] = [];
        if (iocIds) {
          for (const id of iocIds) {
            const ioc = await store.getIoc(id);
            if (ioc) {
              iocs.push(ioc);
            }
          }
        } else {
          // Collect by actor or campaign
          const searchQuery: { actorId?: string; campaignId?: string } = {};
          if (actorIds && actorIds.length > 0) {
            searchQuery.actorId = actorIds[0];
          }
          if (campaignIds && campaignIds.length > 0) {
            searchQuery.campaignId = campaignIds[0];
          }

          if (searchQuery.actorId || searchQuery.campaignId) {
            const found = await store.searchIocs(searchQuery);
            iocs.push(...found);
          } else {
            // Export all IOCs
            for await (const ioc of store.listIocs()) {
              iocs.push(ioc);
            }
          }
        }

        // Strip PII and prepare export
        const sanitized = iocs.map((ioc) => ({
          value: ioc.value,
          type: ioc.type,
          confidence: ioc.confidence,
          tags: ioc.tags,
          firstSeen: ioc.firstSeen,
          lastSeen: ioc.lastSeen,
        }));

        const exportData = {
          format,
          exportedAt: new Date().toISOString(),
          indicators: sanitized,
          count: sanitized.length,
          piiStripped: true,
          cisaCompliant: config.cybersecurity?.informationSharing?.cisaCompliant ?? false,
        };

        return jsonResult({
          status: "success",
          message: `Exported ${sanitized.length} indicators in ${format} format`,
          export: exportData,
        });
      } catch (error) {
        return jsonResult({
          status: "error",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
}

export function createThreatShareImportTool(): AnyAgentTool {
  return {
    label: "Cybersecurity",
    name: "threat_share_import",
    description:
      "Import threat indicators from external sources. Parse STIX/TAXII feeds, validate and deduplicate indicators.",
    parameters: ThreatShareImportSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const store = getStore();

      try {
        const source = readStringParam(params, "source", { required: true });
        const format = (readStringParam(params, "format") || "json") as
          | "stix"
          | "taxii"
          | "json";
        const data = readStringParam(params, "data");

        if (format === "json" && data) {
          let parsed: unknown;
          try {
            parsed = JSON.parse(data);
          } catch {
            return jsonResult({
              status: "error",
              error: "Invalid JSON data",
            });
          }

          if (!Array.isArray(parsed)) {
            return jsonResult({
              status: "error",
              error: "Expected array of indicators",
            });
          }

          let imported = 0;
          let duplicates = 0;

          for (const item of parsed) {
            if (
              typeof item === "object" &&
              item !== null &&
              "value" in item &&
              typeof item.value === "string"
            ) {
              const existing = await store.searchIocs({ value: item.value });
              if (existing.length > 0) {
                duplicates++;
                continue;
              }

              const type = IoCMatcher.inferType(item.value);
              const now = new Date();
              const ioc: IndicatorOfCompromise = {
                id: `ioc-${Date.now()}-${Math.random().toString(36).substring(7)}`,
                value: item.value,
                type,
                confidence: (item.confidence as "low" | "medium" | "high") || "medium",
                createdAt: now,
                updatedAt: now,
              };

              await store.addIoc(ioc);
              imported++;
            }
          }

          return jsonResult({
            status: "success",
            message: `Imported ${imported} indicators, skipped ${duplicates} duplicates`,
            imported,
            duplicatesSkipped: duplicates,
          });
        } else {
          return jsonResult({
            status: "error",
            error: `Format ${format} not yet fully supported. JSON format requires 'data' parameter.`,
          });
        }
      } catch (error) {
        return jsonResult({
          status: "error",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
}

export function createThreatShareStatusTool(): AnyAgentTool {
  return {
    label: "Cybersecurity",
    name: "threat_share_status",
    description:
      "Check information sharing status and protections. Display CISA 2015 protections if applicable and show sharing agreements and compliance.",
    parameters: ThreatShareStatusSchema,
    execute: async (_toolCallId, _args) => {
      const config = loadConfig();

      try {
        const cisa2015Active = true;
        const protections = [
          "No waiver of applicable privilege",
          "Antitrust liability exemption",
          "Exemption from federal/state disclosure laws",
          "Treatment as trade secret or commercial information",
        ];

        if (config.cybersecurity?.informationSharing?.cisaCompliant) {
          protections.push("CISA 2015 liability protection");
        }

        return jsonResult({
          status: "success",
          cisa2015Active,
          protections,
          sharingEnabled: config.cybersecurity?.informationSharing?.enabled ?? false,
          cisaCompliant: config.cybersecurity?.informationSharing?.cisaCompliant ?? false,
        });
      } catch (error) {
        return jsonResult({
          status: "error",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
}


// Vulnerability Management Tools

const VulnTrackSchema = Type.Object({
  cveId: Type.String(),
  description: Type.Optional(Type.String()),
  cvssScore: Type.Optional(Type.Number()),
  affectedProducts: Type.Optional(Type.Array(Type.String())),
});

const VulnCheckSchema = Type.Object({
  packageName: Type.String(),
  version: Type.String(),
});

const VulnPatchStatusSchema = Type.Object({
  cveId: Type.String(),
  systemId: Type.Optional(Type.String()),
});

const VulnExploitDetectionSchema = Type.Object({
  cveId: Type.String(),
  sourceIp: Type.Optional(Type.String()),
});

export function createVulnTrackTool(): AnyAgentTool {
  return {
    label: "Cybersecurity",
    name: "vuln_track",
    description:
      "Track a CVE or vulnerability. Store CVE ID, description, CVSS score, affected products, and link to threat actors exploiting it.",
    parameters: VulnTrackSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      try {
        const cveId = readStringParam(params, "cveId", { required: true });
        return jsonResult({
          status: "success",
          message: `Vulnerability ${cveId} tracking not yet fully implemented. NVD API integration pending.`,
          cveId,
        });
      } catch (error) {
        return jsonResult({
          status: "error",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
}

export function createVulnCheckTool(): AnyAgentTool {
  return {
    label: "Cybersecurity",
    name: "vuln_check",
    description:
      "Check if a system/package version is vulnerable. Query CVE database and return vulnerability status and remediation.",
    parameters: VulnCheckSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      try {
        const packageName = readStringParam(params, "packageName", { required: true });
        const version = readStringParam(params, "version", { required: true });
        return jsonResult({
          status: "success",
          message: `Vulnerability checking for ${packageName}@${version} not yet fully implemented. NVD API integration pending.`,
          packageName,
          version,
        });
      } catch (error) {
        return jsonResult({
          status: "error",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
}

export function createVulnPatchStatusTool(): AnyAgentTool {
  return {
    label: "Cybersecurity",
    name: "vuln_patch_status",
    description:
      "Track patch deployment status. Monitor patch cycles (target: <24 hours for critical) and alert on overdue patches.",
    parameters: VulnPatchStatusSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      try {
        const cveId = readStringParam(params, "cveId", { required: true });
        return jsonResult({
          status: "success",
          message: `Patch status tracking for ${cveId} not yet fully implemented.`,
          cveId,
        });
      } catch (error) {
        return jsonResult({
          status: "error",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
}

export function createVulnExploitDetectionTool(): AnyAgentTool {
  return {
    label: "Cybersecurity",
    name: "vuln_exploit_detection",
    description:
      "Detect exploit attempts against tracked vulnerabilities. Match network/process activity to known exploit patterns and alert on active exploitation.",
    parameters: VulnExploitDetectionSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      try {
        const cveId = readStringParam(params, "cveId", { required: true });
        return jsonResult({
          status: "success",
          message: `Exploit detection for ${cveId} not yet fully implemented.`,
          cveId,
        });
      } catch (error) {
        return jsonResult({
          status: "error",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
}

// Operation Winter Shield Tools

const SecurityAssessWintershieldSchema = Type.Object({});

const SecurityMitigateWintershieldSchema = Type.Object({
  control: optionalStringEnum([
    "mfa",
    "credential_hygiene",
    "patch_management",
    "network_segmentation",
    "access_controls",
    "monitoring",
    "incident_response",
    "backup_recovery",
    "supply_chain",
    "training",
  ] as const),
});

export function createSecurityAssessWintershieldTool(): AnyAgentTool {
  return {
    label: "Cybersecurity",
    name: "security_assess_wintershield",
    description:
      "Assess organization against Operation Winter Shield top 10. Check: MFA, credential hygiene, patch management, network segmentation, etc. Generate prioritized remediation report.",
    parameters: SecurityAssessWintershieldSchema,
    execute: async (_toolCallId, _args) => {
      try {
        return jsonResult({
          status: "success",
          message: "Operation Winter Shield assessment not yet fully implemented.",
          top10Controls: [
            "MFA",
            "Credential Hygiene",
            "Patch Management",
            "Network Segmentation",
            "Access Controls",
            "Monitoring",
            "Incident Response",
            "Backup Recovery",
            "Supply Chain",
            "Training",
          ],
        });
      } catch (error) {
        return jsonResult({
          status: "error",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
}

export function createSecurityMitigateWintershieldTool(): AnyAgentTool {
  return {
    label: "Cybersecurity",
    name: "security_mitigate_wintershield",
    description:
      "Apply Winter Shield mitigations. Guide through implementing each of the 10 controls and track implementation status.",
    parameters: SecurityMitigateWintershieldSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      try {
        const control = readStringParam(params, "control");
        return jsonResult({
          status: "success",
          message: `Winter Shield mitigation for ${control} not yet fully implemented.`,
          control,
        });
      } catch (error) {
        return jsonResult({
          status: "error",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
}

// Critical Infrastructure Tools

const InfraAssessOtSchema = Type.Object({
  networkCidrs: Type.Optional(Type.Array(Type.String())),
});

const InfraDetectPrepositioningSchema = Type.Object({
  timeRange: Type.Optional(Type.Object({
    start: Type.String(),
    end: Type.String(),
  })),
});

const InfraResiliencePlanSchema = Type.Object({
  systemName: Type.String(),
});

export function createInfraAssessOtTool(): AnyAgentTool {
  return {
    label: "Cybersecurity",
    name: "infra_assess_ot",
    description:
      "Assess operational technology (OT) security posture. Check exposed OT connections and validate zero trust principles in OT environments.",
    parameters: InfraAssessOtSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      try {
        return jsonResult({
          status: "success",
          message: "OT assessment not yet fully implemented.",
        });
      } catch (error) {
        return jsonResult({
          status: "error",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
}

export function createInfraDetectPrepositioningTool(): AnyAgentTool {
  return {
    label: "Cybersecurity",
    name: "infra_detect_prepositioning",
    description:
      "Detect pre-positioning activity (Volt Typhoon-style). Identify suspicious access patterns and flag potential sleeper agent activity.",
    parameters: InfraDetectPrepositioningSchema,
    execute: async (_toolCallId, _args) => {
      try {
        return jsonResult({
          status: "success",
          message: "Pre-positioning detection not yet fully implemented.",
        });
      } catch (error) {
        return jsonResult({
          status: "error",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
}

export function createInfraResiliencePlanTool(): AnyAgentTool {
  return {
    label: "Cybersecurity",
    name: "infra_resilience_plan",
    description:
      "Generate resilience and recovery plans. Document analog backup procedures and plan for rapid recovery (<24 hours target).",
    parameters: InfraResiliencePlanSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      try {
        const systemName = readStringParam(params, "systemName", { required: true });
        return jsonResult({
          status: "success",
          message: `Resilience plan for ${systemName} not yet fully implemented.`,
          systemName,
        });
      } catch (error) {
        return jsonResult({
          status: "error",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
}

// AI Threat Defense Tools

const AiThreatDetectAnomalySchema = Type.Object({
  timeRange: Type.Optional(Type.Object({
    start: Type.String(),
    end: Type.String(),
  })),
});

const AiThreatRespondSchema = Type.Object({
  anomalyId: Type.String(),
  actions: Type.Optional(Type.Array(Type.String())),
});

const AiThreatHuntSchema = Type.Object({
  actorIds: Type.Optional(Type.Array(Type.String())),
  patterns: Type.Optional(Type.Array(Type.String())),
});

export function createAiThreatDetectAnomalyTool(): AnyAgentTool {
  return {
    label: "Cybersecurity",
    name: "ai_threat_detect_anomaly",
    description:
      "Detect AI-driven attack patterns. Identify machine-speed operations (100x faster than human) and flag physically impossible request rates.",
    parameters: AiThreatDetectAnomalySchema,
    execute: async (_toolCallId, _args) => {
      try {
        return jsonResult({
          status: "success",
          message: "AI threat anomaly detection not yet fully implemented.",
        });
      } catch (error) {
        return jsonResult({
          status: "error",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
}

export function createAiThreatRespondTool(): AnyAgentTool {
  return {
    label: "Cybersecurity",
    name: "ai_threat_respond",
    description:
      "Automated response to AI-accelerated attacks. Quarantine affected systems and implement rate limiting and circuit breakers.",
    parameters: AiThreatRespondSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      try {
        const anomalyId = readStringParam(params, "anomalyId", { required: true });
        return jsonResult({
          status: "success",
          message: `AI threat response for ${anomalyId} not yet fully implemented.`,
          anomalyId,
        });
      } catch (error) {
        return jsonResult({
          status: "error",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
}

export function createAiThreatHuntTool(): AnyAgentTool {
  return {
    label: "Cybersecurity",
    name: "ai_threat_hunt",
    description:
      "Proactive hunting for AI-driven campaigns. Search telemetry for AI attack signatures and correlate with known AI threat actor patterns.",
    parameters: AiThreatHuntSchema,
    execute: async (_toolCallId, _args) => {
      try {
        return jsonResult({
          status: "success",
          message: "AI threat hunting not yet fully implemented.",
        });
      } catch (error) {
        return jsonResult({
          status: "error",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
}

