export type PentestConfig = {
  enabled?: boolean;
  workspace?: string; // default: ~/.openclaw/security/pentest/
  tools?: string[]; // e.g., ["nmap", "metasploit", "burp"]
};

export type DefenseConfig = {
  enabled?: boolean;
  workspace?: string; // default: ~/.openclaw/security/defense/
  siem?: {
    provider?: "splunk" | "elastic" | "sentinel" | "crowdstrike";
    endpoint?: string;
    apiKey?: string;
    index?: string;
  };
  threatHunting?: {
    enabled?: boolean;
    schedules?: string[]; // e.g., ["daily", "weekly"]
  };
};

export type SocConfig = {
  enabled?: boolean;
  alerting?: {
    enabled?: boolean;
    channels?: string[];
  };
  caseManagement?: {
    enabled?: boolean;
    provider?: string;
  };
};

export type AutomationConfig = {
  enabled?: boolean;
  workspace?: string; // default: ~/.openclaw/security/automation/
  threatModelUpdate?: {
    enabled?: boolean;
    schedule?: string; // cron expression, e.g., "0 2 * * 1" for weekly
    sources?: string[]; // e.g., ["threat_intelligence", "cve", "mitre_attack"]
  };
  redTeamExercise?: {
    enabled?: boolean;
    schedule?: string; // cron expression
    actors?: string[]; // threat actor IDs to simulate
  };
  vulnerabilityTesting?: {
    enabled?: boolean;
    schedule?: string; // cron expression
    products?: string[]; // products to monitor
  };
};

export type ThreatHuntingConfig = {
  enabled?: boolean;
  proactiveHunting?: {
    enabled?: boolean;
    actors?: string[]; // e.g., ["apt29", "volt-typhoon", "scattered-spider"]
    schedule?: string; // cron expression
    sources?: string[]; // ["telemetry", "virustotal", "shodan", "censys"]
  };
  anomalyDetection?: {
    enabled?: boolean;
    livingOffTheLand?: boolean;
    timeBasedAnomalies?: boolean;
  };
  sectorTracking?: {
    enabled?: boolean;
    sectors?: string[]; // ["retail", "insurance", "aviation", "healthcare"]
  };
};

export type SpeedAutomationConfig = {
  enabled?: boolean;
  vulnerabilityTesting?: {
    instantTest?: boolean;
    patchValidation?: boolean;
  };
  attackResponse?: {
    automatedContainment?: boolean;
    incidentGeneration?: boolean;
  };
};

export type WebSecurityConfig = {
  enabled?: boolean;
  browserTesting?: {
    enabled?: boolean;
    headless?: boolean;
  };
  proxyTesting?: {
    enabled?: boolean;
    proxyPort?: number;
  };
  xssTesting?: {
    enabled?: boolean;
    payloads?: string[];
  };
  sqliTesting?: {
    enabled?: boolean;
    payloads?: string[];
  };
};

export type LLMSecurityConfig = {
  enabled?: boolean;
  workspace?: string; // default: ~/.openclaw/security/llm-security/
  promptInjection?: {
    enabled?: boolean;
    detectionEnabled?: boolean;
    testInterval?: string; // cron expression
  };
  jailbreakTesting?: {
    enabled?: boolean;
    automatedRedTeam?: boolean;
    testCategories?: string[]; // ["dan", "encoding", "multi_turn"]
  };
  ragSecurity?: {
    enabled?: boolean;
    poisoningDetection?: boolean;
    integrityValidation?: boolean;
  };
  defenseValidation?: {
    enabled?: boolean;
    guardrailTesting?: boolean;
    architecturalValidation?: boolean;
    cotMonitoring?: boolean;
  };
  attackLibraries?: {
    promptInjection?: string[]; // Custom payloads
    jailbreak?: string[]; // Custom techniques
    ragPoisoning?: string[]; // Custom patterns
  };
};

export type CognitiveSecurityConfig = {
  enabled?: boolean;
  workspace?: string; // default: ~/.openclaw/security/cognitive/
  threatDetection?: {
    enabled?: boolean;
    realTimeDetection?: boolean;
    detectionTypes?: string[]; // ["persuasion", "injection", "trust_capture", "anomaly"]
  };
  decisionIntegrity?: {
    enabled?: boolean;
    oodaLoopEnabled?: boolean;
    policyChecks?: boolean;
    riskThreshold?: number; // 0-1
  };
  escalationControl?: {
    enabled?: boolean;
    maxChainDepth?: number;
    maxCumulativeRisk?: number;
    maxUncertainty?: number;
  };
  provenanceTracking?: {
    enabled?: boolean;
    trackAllInputs?: boolean;
    integrityScoring?: boolean;
  };
  gracefulDegradation?: {
    enabled?: boolean;
    autoModeSwitching?: boolean;
    riskThresholds?: {
      normal?: number;
      guarded?: number;
      restricted?: number;
      safe?: number;
    };
  };
  resilienceSimulation?: {
    enabled?: boolean;
    schedule?: string; // cron expression
    scenarioTypes?: string[]; // ["prompt_injection", "narrative_manipulation", "memory_poisoning"]
  };
  trustTrajectory?: {
    enabled?: boolean;
    timeWindow?: number; // seconds
    trackingEnabled?: boolean;
  };
};

export type AdversaryRecommenderConfig = {
  enabled?: boolean;
  workspace?: string; // default: ~/.openclaw/security/arr/
  attackGeneration?: {
    enabled?: boolean;
    testCount?: number; // default: 50
    attackFamilies?: string[]; // All 7 families by default
  };
  optimization?: {
    enabled?: boolean;
    maxIterations?: number; // default: 10
    mutationStrategies?: string[];
  };
  benchmarking?: {
    enabled?: boolean;
    schedule?: string; // cron expression, e.g., "0 2 * * *" for daily
    regressionThreshold?: number; // default: 0.2 (20% failure rate)
  };
  heartbeatIntegration?: {
    enabled?: boolean;
    runOnHeartbeat?: boolean; // Run ARR tests during heartbeat
    testCount?: number; // Reduced count for heartbeat runs
  };
  coverage?: {
    trackTechniqueCoverage?: boolean;
    trackSurfaceCoverage?: boolean;
    trackSeverityWeighted?: boolean;
  };
};

export type SwarmAgentConfig = {
  enabled?: boolean;
  workspace?: string; // default: ~/.openclaw/security/swarm/
  redTeamSwarm?: {
    enabled?: boolean;
    defaultSwarmSize?: number; // default: 4
    agents?: string[]; // ["attack_generator", "payload_optimizer", "evaluation_agent", "coverage_analyst"]
  };
  blueTeamSwarm?: {
    enabled?: boolean;
    defaultSwarmSize?: number; // default: 4
    agents?: string[]; // ["threat_detector", "defense_validator", "risk_assessor", "mitigation_planner"]
  };
  collaboration?: {
    enabled?: boolean;
    defaultMode?: "sequential" | "parallel" | "consensus"; // default: "consensus"
    communicationProtocol?: "broadcast" | "hierarchical" | "peer_to_peer"; // default: "peer_to_peer"
  };
  swarmVsSwarm?: {
    enabled?: boolean;
    schedule?: string; // cron expression for regular swarm battles
    duration?: number; // seconds, default: 3600
  };
  integration?: {
    arrIntegration?: boolean; // Integrate with ARR
    cognitiveIntegration?: boolean; // Integrate with cognitive security
    heartbeatIntegration?: boolean; // Run swarm operations during heartbeat
  };
};

export type SecurityConfig = {
  pentest?: PentestConfig;
  defense?: DefenseConfig;
  soc?: SocConfig;
  automation?: AutomationConfig;
  threatHunting?: ThreatHuntingConfig;
  speedAutomation?: SpeedAutomationConfig;
  webSecurity?: WebSecurityConfig;
  llmSecurity?: LLMSecurityConfig;
  cognitiveSecurity?: CognitiveSecurityConfig;
  adversaryRecommender?: AdversaryRecommenderConfig;
  swarmAgents?: SwarmAgentConfig;
};
