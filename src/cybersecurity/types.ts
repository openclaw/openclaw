// Threat Intelligence Types

export type ThreatActor = {
  id: string;
  name: string;
  aliases?: string[];
  attribution?: string; // e.g., "PRC", "Russia SVR", "Criminal"
  description?: string;
  ttps?: string[]; // Tactics, Techniques, and Procedures
  campaigns?: string[]; // Campaign IDs
  firstSeen?: Date;
  lastSeen?: Date;
  severity?: "low" | "medium" | "high" | "critical";
  createdAt: Date;
  updatedAt: Date;
};

export type IoCType = "ip" | "domain" | "url" | "hash" | "filepath" | "email" | "other";

export type IndicatorOfCompromise = {
  id: string;
  value: string;
  type: IoCType;
  actorId?: string; // Associated threat actor
  campaignId?: string; // Associated campaign
  confidence: "low" | "medium" | "high";
  firstSeen?: Date;
  lastSeen?: Date;
  description?: string;
  tags?: string[];
  createdAt: Date;
  updatedAt: Date;
};

export type Campaign = {
  id: string;
  name: string;
  actorId?: string; // Primary threat actor
  description?: string;
  startDate?: Date;
  endDate?: Date;
  status: "active" | "dormant" | "concluded";
  sectors?: string[]; // Targeted sectors
  severity?: "low" | "medium" | "high" | "critical";
  iocIds?: string[]; // Associated IOCs
  createdAt: Date;
  updatedAt: Date;
};

// Vulnerability Management Types

export type Vulnerability = {
  id: string;
  cveId: string;
  description?: string;
  cvssScore?: number;
  cvssSeverity?: "low" | "medium" | "high" | "critical";
  affectedProducts?: string[];
  exploitAvailable?: boolean;
  actorIds?: string[]; // Threat actors exploiting this
  publishedDate?: Date;
  lastModifiedDate?: Date;
  trackedAt: Date;
};

export type PatchStatus = {
  vulnerabilityId: string;
  cveId: string;
  systemId?: string;
  packageName?: string;
  currentVersion?: string;
  patchedVersion?: string;
  status: "not_patched" | "patch_available" | "patch_deployed" | "not_applicable";
  patchWindowHours?: number;
  targetPatchDate?: Date;
  actualPatchDate?: Date;
  overdue?: boolean;
  createdAt: Date;
  updatedAt: Date;
};

export type ExploitDetection = {
  id: string;
  vulnerabilityId: string;
  cveId: string;
  detectedAt: Date;
  sourceIp?: string;
  targetIp?: string;
  activityType: "network" | "process" | "file" | "other";
  description?: string;
  severity: "low" | "medium" | "high" | "critical";
  blocked?: boolean;
};

// Operation Winter Shield Types

export type WintershieldControl =
  | "mfa"
  | "credential_hygiene"
  | "patch_management"
  | "network_segmentation"
  | "access_controls"
  | "monitoring"
  | "incident_response"
  | "backup_recovery"
  | "supply_chain"
  | "training";

export type WintershieldAssessment = {
  id: string;
  assessedAt: Date;
  controls: Record<
    WintershieldControl,
    {
      status: "not_implemented" | "partial" | "implemented";
      score: number; // 0-100
      findings?: string[];
      recommendations?: string[];
    }
  >;
  overallScore: number; // 0-100
  priorityRemediations?: string[];
};

export type WintershieldMitigation = {
  control: WintershieldControl;
  status: "pending" | "in_progress" | "completed";
  startedAt?: Date;
  completedAt?: Date;
  notes?: string;
};

// Critical Infrastructure Types

export type OTAssessment = {
  id: string;
  assessedAt: Date;
  networkCidrs?: string[];
  exposedConnections?: number;
  zeroTrustScore?: number; // 0-100
  findings?: string[];
  recommendations?: string[];
};

export type PrepositioningDetection = {
  id: string;
  detectedAt: Date;
  sourceIp?: string;
  targetIp?: string;
  activityPattern: string;
  confidence: "low" | "medium" | "high";
  description?: string;
  actorId?: string; // Suspected threat actor
  status: "investigating" | "confirmed" | "false_positive" | "resolved";
};

export type ResiliencePlan = {
  id: string;
  systemName: string;
  createdAt: Date;
  updatedAt: Date;
  analogBackups?: string[];
  recoveryProcedures?: string[];
  targetRecoveryTimeHours?: number;
  dependencies?: string[];
  testDate?: Date;
  lastTestResult?: "success" | "partial" | "failed";
};

// AI Threat Defense Types

export type AIThreatAnomaly = {
  id: string;
  detectedAt: Date;
  anomalyType: "speed" | "volume" | "pattern" | "other";
  description: string;
  requestRate?: number; // requests per second
  normalRate?: number; // baseline requests per second
  multiplier?: number; // how many times faster than normal
  sourceIp?: string;
  targetIp?: string;
  severity: "low" | "medium" | "high" | "critical";
  status: "detected" | "investigating" | "confirmed" | "false_positive" | "mitigated";
};

export type AIThreatResponse = {
  anomalyId: string;
  respondedAt: Date;
  actions: ("quarantine" | "rate_limit" | "circuit_breaker" | "alert" | "other")[];
  targetSystem?: string;
  success: boolean;
  notes?: string;
};

export type AIThreatHunt = {
  id: string;
  huntedAt: Date;
  searchCriteria: {
    timeRange?: { start: Date; end: Date };
    actorIds?: string[];
    patterns?: string[];
  };
  results: {
    anomaliesFound: number;
    anomalies: string[]; // Anomaly IDs
    campaignsDetected?: string[]; // Campaign IDs
  };
};

// Information Sharing Types

export type ThreatShareExport = {
  id: string;
  exportedAt: Date;
  format: "stix" | "taxii" | "json";
  indicators: string[]; // IOC IDs
  actorIds?: string[];
  campaignIds?: string[];
  piiStripped: boolean;
  cisaCompliant: boolean;
  filePath?: string;
};

export type ThreatShareImport = {
  id: string;
  importedAt: Date;
  source: string;
  format: "stix" | "taxii" | "json";
  indicatorsImported: number;
  actorsImported: number;
  campaignsImported: number;
  duplicatesSkipped: number;
};

export type ThreatShareStatus = {
  cisa2015Active: boolean;
  protections: string[];
  sharingAgreements?: string[];
  lastExport?: Date;
  lastImport?: Date;
};
