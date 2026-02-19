import { Type } from "@sinclair/typebox";
import { loadConfig } from "../../config/config.js";
import { ThreatIntelligenceStore } from "../../cybersecurity/threat-intelligence/store.js";
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

// Sector Intelligence Tool Schemas

const SectorIntelligenceTrackSchema = Type.Object({
  sector: Type.String(),
  actor_id: Type.Optional(Type.String()),
  time_range: Type.Optional(Type.String()),
  alert_on_shift: Type.Optional(Type.Boolean()),
  generate_threat_model: Type.Optional(Type.Boolean()),
  generate_hunting_queries: Type.Optional(Type.Boolean()),
  output: Type.Optional(Type.String()),
});

// Sector Intelligence Tools

export function createSectorIntelligenceTrackTool(): AnyAgentTool {
  return {
    label: "Sector Intelligence",
    name: "sector_intelligence_track",
    description:
      "Track sector-specific attack patterns: monitor sector targeting (retail, insurance, aviation, healthcare, etc.), alert when actors shift sectors (e.g., Scattered Spider: retail → insurance → aviation), generate sector-specific threat models, and create sector-specific hunting queries.",
    parameters: SectorIntelligenceTrackSchema,
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
        const generateThreatModel = params.generate_threat_model !== false; // Default true
        const generateHuntingQueries = params.generate_hunting_queries !== false; // Default true
        const output = readStringParam(params, "output");

        const store = getStore();
        const range = timeRange ?? "last_90_days";

        let result: Record<string, unknown> = {
          status: "success",
          sector,
          time_range: range,
          alert_on_shift: alertOnShift,
          generate_threat_model: generateThreatModel,
          generate_hunting_queries: generateHuntingQueries,
        };

        // Get campaigns targeting this sector
        const campaigns = await store.searchCampaigns({ sector });
        const activeCampaigns = campaigns.filter((c) => c.status === "active");
        const historicalCampaigns = campaigns.filter((c) => c.status !== "active");

        result.active_campaigns = activeCampaigns.length;
        result.historical_campaigns = historicalCampaigns.length;
        result.total_campaigns = campaigns.length;

        // Get actors targeting this sector
        const sectorActors = new Set<string>();
        campaigns.forEach((c) => {
          if (c.actorId) {
            sectorActors.add(c.actorId);
          }
        });

        result.actors_targeting_sector = Array.from(sectorActors);
        result.actors_count = sectorActors.size;

        // If actor specified, check for sector shifts
        if (actorId) {
          result.actor_id = actorId;
          const actorCampaigns = await store.searchCampaigns({ actorId });
          const actorSectors = actorCampaigns
            .filter((c) => c.sector)
            .map((c) => c.sector!)
            .filter((s) => s !== sector);

          const uniqueSectors = [...new Set(actorSectors)];

          if (uniqueSectors.length > 0) {
            result.sector_shift_detected = true;
            result.previous_sectors = uniqueSectors;
            result.shift_pattern = `${actorId} has targeted: ${uniqueSectors.join(", ")} → ${sector}`;
            result.alert_level = alertOnShift ? "high" : "medium";
            result.message = `Sector shift detected: ${actorId} has targeted ${uniqueSectors.join(", ")} and may be shifting to ${sector}. High alert recommended.`;
          } else {
            result.sector_shift_detected = false;
            result.message = `Monitoring ${actorId} activity in ${sector} sector.`;
          }
        }

        // Generate sector-specific threat model
        if (generateThreatModel) {
          const sectorThreatModel = {
            sector,
            created_at: new Date().toISOString(),
            threat_actors: Array.from(sectorActors),
            active_campaigns: activeCampaigns.length,
            attack_vectors: getSectorAttackVectors(sector),
            defensive_controls: getSectorDefensiveControls(sector),
            iocs: [],
            ttps: [],
          };

          // Collect IOCs and TTPs from campaigns
          for (const campaign of activeCampaigns.slice(0, 10)) {
            if (campaign.actorId) {
              const iocs = await store.searchIocs({ actorId: campaign.actorId });
              sectorThreatModel.iocs.push(...iocs.slice(0, 5).map((i) => i.value));

              const actor = await store.getActor(campaign.actorId);
              if (actor?.ttps) {
                sectorThreatModel.ttps.push(...actor.ttps);
              }
            }
          }

          sectorThreatModel.iocs = [...new Set(sectorThreatModel.iocs)];
          sectorThreatModel.ttps = [...new Set(sectorThreatModel.ttps)];

          result.sector_threat_model = sectorThreatModel;
        }

        // Generate sector-specific hunting queries
        if (generateHuntingQueries) {
          const huntingQueries = getSectorHuntingQueries(sector, Array.from(sectorActors));
          result.hunting_queries = huntingQueries;
        }

        // Generate sector intelligence report
        const sectorReport = {
          sector,
          actor_id: actorId,
          intelligence_date: new Date().toISOString(),
          time_range: range,
          active_campaigns: activeCampaigns.length,
          historical_campaigns: historicalCampaigns.length,
          actors_targeting_sector: Array.from(sectorActors),
          sector_shift_detected: result.sector_shift_detected ?? false,
          previous_sectors: result.previous_sectors ?? [],
          threat_model: generateThreatModel ? result.sector_threat_model : null,
          hunting_queries: generateHuntingQueries ? result.hunting_queries : [],
          recommendations: [
            `Implement sector-specific security controls for ${sector}`,
            `Monitor for sector-specific attack patterns`,
            `Train staff on ${sector}-specific threats`,
            alertOnShift && result.sector_shift_detected
              ? `High alert: ${actorId} may be shifting to ${sector} sector`
              : null,
          ].filter((r): r is string => r !== null),
        };

        result.sector_intelligence = sectorReport;
        result.message =
          result.message ??
          `Sector intelligence tracking for ${sector} sector. ${activeCampaigns.length} active campaigns, ${sectorActors.size} actors.`;

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

// Helper functions

function getSectorAttackVectors(sector: string): string[] {
  const vectors: Record<string, string[]> = {
    retail: [
      "Point-of-sale (POS) system compromise",
      "Payment card data theft",
      "E-commerce platform attacks",
      "Supply chain attacks",
      "Social engineering (call center)",
    ],
    insurance: [
      "Policy and claims system access",
      "Customer data theft",
      "Social engineering (call center)",
      "Credential theft",
      "Ransomware attacks",
    ],
    aviation: [
      "Flight operations system compromise",
      "Critical infrastructure access",
      "Pre-positioning for kinetic operations",
      "OT/ICS system attacks",
      "Supply chain attacks",
    ],
    healthcare: [
      "Patient data theft",
      "Medical device compromise",
      "Ransomware attacks",
      "HIPAA violations",
      "Hospital operations disruption",
    ],
    financial: [
      "Banking system compromise",
      "Payment processing attacks",
      "Cryptocurrency theft",
      "SWIFT network attacks",
      "ATM attacks",
    ],
  };

  return vectors[sector.toLowerCase()] ?? [
    "Credential theft",
    "Social engineering",
    "Ransomware",
    "Data exfiltration",
  ];
}

function getSectorDefensiveControls(sector: string): string[] {
  const controls: Record<string, string[]> = {
    retail: [
      "Implement PCI DSS compliance",
      "Secure POS systems",
      "Monitor payment card data access",
      "Train call center staff on social engineering",
      "Implement network segmentation",
    ],
    insurance: [
      "Secure policy and claims systems",
      "Implement MFA for all accounts",
      "Monitor customer data access",
      "Train call center staff",
      "Implement data loss prevention",
    ],
    aviation: [
      "Secure flight operations systems",
      "Implement OT/ICS security controls",
      "Monitor for pre-positioning activity",
      "Implement network segmentation",
      "Prepare resilience and recovery plans",
    ],
    healthcare: [
      "Secure patient data systems",
      "Implement HIPAA compliance",
      "Secure medical devices",
      "Monitor for ransomware",
      "Implement backup and recovery",
    ],
    financial: [
      "Implement banking security controls",
      "Secure payment processing",
      "Monitor SWIFT network",
      "Implement fraud detection",
      "Secure cryptocurrency wallets",
    ],
  };

  return controls[sector.toLowerCase()] ?? [
    "Implement MFA",
    "Monitor for suspicious activity",
    "Train staff on security",
    "Implement network segmentation",
  ];
}

function getSectorHuntingQueries(sector: string, actors: string[]): string[] {
  const baseQueries = [
    `Search for attacks targeting ${sector} sector infrastructure`,
    `Monitor for ${sector}-specific attack patterns`,
    `Track credential access attempts in ${sector} systems`,
    `Look for lateral movement within ${sector} networks`,
  ];

  const sectorQueries: Record<string, string[]> = {
    retail: [
      "Monitor point-of-sale systems",
      "Track payment card data access",
      "Search for POS malware",
      "Monitor for card skimming",
    ],
    insurance: [
      "Monitor policy and claims systems",
      "Track customer data access",
      "Search for social engineering attempts",
      "Monitor call center activity",
    ],
    aviation: [
      "Monitor flight operations systems",
      "Track critical infrastructure access",
      "Search for OT/ICS attacks",
      "Monitor for pre-positioning activity",
    ],
    healthcare: [
      "Monitor patient data access",
      "Track medical device systems",
      "Search for ransomware activity",
      "Monitor HIPAA violations",
    ],
  };

  const queries = [...baseQueries, ...(sectorQueries[sector.toLowerCase()] ?? [])];

  if (actors.length > 0) {
    queries.push(`Search for ${actors.join(", ")} activity in ${sector} sector`);
  }

  return queries;
}
