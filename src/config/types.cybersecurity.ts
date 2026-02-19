export type ThreatIntelligenceConfig = {
  enabled?: boolean;
  storagePath?: string; // default: ~/.openclaw/cybersecurity/threats/
  autoUpdate?: boolean;
  updateInterval?: string; // e.g., "24h"
};

export type InformationSharingConfig = {
  enabled?: boolean;
  stixEndpoint?: string;
  cisaCompliant?: boolean;
  autoExport?: boolean;
};

export type VulnerabilityManagementConfig = {
  enabled?: boolean;
  nvdApiKey?: string;
  patchWindowHours?: number; // default: 24
  autoCheck?: boolean;
};

export type WintershieldConfig = {
  enabled?: boolean;
  assessmentInterval?: string; // e.g., "7d"
};

export type CriticalInfrastructureConfig = {
  enabled?: boolean;
  otNetworks?: string[]; // CIDR blocks for OT networks
};

export type AiThreatDefenseConfig = {
  enabled?: boolean;
  anomalyThreshold?: number;
  autoRespond?: boolean;
};

export type CybersecurityConfig = {
  threatIntelligence?: ThreatIntelligenceConfig;
  informationSharing?: InformationSharingConfig;
  vulnerabilityManagement?: VulnerabilityManagementConfig;
  wintershield?: WintershieldConfig;
  criticalInfrastructure?: CriticalInfrastructureConfig;
  aiThreatDefense?: AiThreatDefenseConfig;
};
