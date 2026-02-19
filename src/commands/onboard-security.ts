import type { OpenClawConfig } from "../config/config.js";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "../wizard/prompts.js";

/**
 * Automated security configuration setup.
 * Configures security features with sensible defaults based on user preferences.
 */
export async function setupSecurityConfig(
  baseConfig: OpenClawConfig,
  runtime: RuntimeEnv,
  prompter: WizardPrompter,
  options: {
    enableLLMSecurity?: boolean;
    enableCognitiveSecurity?: boolean;
    enableARR?: boolean;
    enableSwarmAgents?: boolean;
    securityLevel?: "basic" | "standard" | "advanced";
  } = {},
): Promise<OpenClawConfig> {
  const config = { ...baseConfig };

  // Determine security level
  const securityLevel = options.securityLevel ?? "standard";

  // Setup security config if not exists
  if (!config.security) {
    config.security = {};
  }

  // LLM Security Configuration
  if (options.enableLLMSecurity !== false) {
    config.security.llmSecurity = {
      enabled: true,
      workspace: "~/.openclaw/security/llm-security/",
      promptInjection: {
        enabled: true,
        detectionEnabled: true,
        testInterval: securityLevel === "advanced" ? "0 2 * * *" : "0 3 * * 0", // Daily for advanced, weekly for standard
      },
      jailbreakTesting: {
        enabled: true,
        automatedRedTeam: securityLevel === "advanced",
        testCategories: ["dan", "encoding", "multi_turn"],
      },
      ragSecurity: {
        enabled: true,
        poisoningDetection: true,
        integrityValidation: securityLevel === "advanced",
      },
      defenseValidation: {
        enabled: true,
        guardrailTesting: true,
        architecturalValidation: securityLevel === "advanced",
        cotMonitoring: securityLevel === "advanced",
      },
    };
  }

  // Cognitive Security Configuration
  if (options.enableCognitiveSecurity !== false) {
    config.security.cognitiveSecurity = {
      enabled: true,
      workspace: "~/.openclaw/security/cognitive/",
      threatDetection: {
        enabled: true,
        realTimeDetection: securityLevel !== "basic",
        detectionTypes: ["persuasion", "injection", "trust_capture", "anomaly"],
      },
      decisionIntegrity: {
        enabled: true,
        oodaLoopEnabled: true,
        policyChecks: true,
        riskThreshold: securityLevel === "advanced" ? 0.3 : securityLevel === "standard" ? 0.4 : 0.5,
      },
      escalationControl: {
        enabled: true,
        maxChainDepth: securityLevel === "advanced" ? 8 : 10,
        maxCumulativeRisk: securityLevel === "advanced" ? 0.7 : 0.8,
        maxUncertainty: securityLevel === "advanced" ? 0.6 : 0.7,
      },
      provenanceTracking: {
        enabled: true,
        trackAllInputs: securityLevel !== "basic",
        integrityScoring: true,
      },
      gracefulDegradation: {
        enabled: true,
        autoModeSwitching: securityLevel !== "basic",
        riskThresholds: {
          normal: 0.3,
          guarded: 0.5,
          restricted: 0.7,
          safe: 1.0,
        },
      },
      resilienceSimulation: {
        enabled: securityLevel === "advanced",
        schedule: "0 4 * * *", // Daily at 4am
        scenarioTypes: ["prompt_injection", "narrative_manipulation", "memory_poisoning"],
      },
      trustTrajectory: {
        enabled: true,
        timeWindow: 3600,
        trackingEnabled: securityLevel !== "basic",
      },
    };
  }

  // Adversary Recommender (ARR) Configuration
  if (options.enableARR !== false && securityLevel !== "basic") {
    config.security.adversaryRecommender = {
      enabled: true,
      workspace: "~/.openclaw/security/arr/",
      attackGeneration: {
        enabled: true,
        testCount: securityLevel === "advanced" ? 50 : 30,
        attackFamilies: [
          "boundary_confusion",
          "indirect_injection",
          "rag_poisoning",
          "memory_poisoning",
          "multi_turn_persuasion",
          "context_flooding",
          "tool_misuse",
        ],
      },
      optimization: {
        enabled: true,
        maxIterations: 10,
      },
      benchmarking: {
        enabled: true,
        schedule: securityLevel === "advanced" ? "0 2 * * *" : "0 3 * * 0", // Daily for advanced, weekly for standard
        regressionThreshold: 0.2,
      },
      heartbeatIntegration: {
        enabled: true,
        runOnHeartbeat: true,
        testCount: 10,
      },
      coverage: {
        trackTechniqueCoverage: true,
        trackSurfaceCoverage: true,
        trackSeverityWeighted: true,
      },
    };
  }

  // Swarm Agents Configuration
  if (options.enableSwarmAgents !== false && securityLevel === "advanced") {
    config.security.swarmAgents = {
      enabled: true,
      workspace: "~/.openclaw/security/swarm/",
      redTeamSwarm: {
        enabled: true,
        defaultSwarmSize: 4,
        agents: ["attack_generator", "payload_optimizer", "evaluation_agent", "coverage_analyst"],
      },
      blueTeamSwarm: {
        enabled: true,
        defaultSwarmSize: 4,
        agents: ["threat_detector", "defense_validator", "risk_assessor", "mitigation_planner"],
      },
      collaboration: {
        enabled: true,
        defaultMode: "consensus",
        communicationProtocol: "peer_to_peer",
      },
      swarmVsSwarm: {
        enabled: true,
        schedule: "0 3 * * *", // Daily at 3am
        duration: 3600,
      },
      integration: {
        arrIntegration: true,
        cognitiveIntegration: true,
        heartbeatIntegration: true,
      },
    };
  }

  return config;
}

/**
 * Interactive security setup during onboarding.
 */
export async function setupSecurityInteractive(
  baseConfig: OpenClawConfig,
  runtime: RuntimeEnv,
  prompter: WizardPrompter,
): Promise<OpenClawConfig> {
  await prompter.note(
    [
      "OpenClaw includes comprehensive security features:",
      "",
      "• LLM Security: Prompt injection detection, jailbreak testing, RAG poisoning detection",
      "• Cognitive Security: Threat detection, decision integrity, escalation control",
      "• Adversary Recommender: Automated red team testing",
      "• Swarm Agents: Multi-agent collaboration for attacks and defenses",
      "",
      "These features help protect against adversarial attacks and validate defenses.",
      "",
      "⚠️  IMPORTANT: Security features are strongly recommended for production use.",
      "   They help protect your agent from prompt injection, jailbreaks, and other attacks.",
    ].join("\n"),
    "Security Features",
  );

  const enableSecurity = await prompter.confirm({
    message: "Enable security features? (Strongly Recommended)",
    initialValue: true,
  });

  if (!enableSecurity) {
    await prompter.note(
      [
        "⚠️  Security features disabled.",
        "",
        "This is not recommended for production use. Your agent will be more vulnerable to:",
        "  • Prompt injection attacks",
        "  • Jailbreak attempts",
        "  • RAG poisoning",
        "  • Adversarial manipulation",
        "",
        "You can enable security features later via:",
        "  openclaw configure --section security",
        "  openclaw security audit --deep",
      ].join("\n"),
      "Security Warning",
    );
    return baseConfig;
  }

  const securityLevel = await prompter.select({
    message: "Security level?",
    options: [
      { value: "basic", label: "Basic - Essential protections only" },
      { value: "standard", label: "Standard - Recommended for most users" },
      { value: "advanced", label: "Advanced - Full security suite with swarm agents" },
    ],
    initialValue: "standard",
  });

  const enableLLM = await prompter.confirm({
    message: "Enable LLM security (prompt injection, jailbreak testing)?",
    initialValue: true,
  });

  const enableCognitive = await prompter.confirm({
    message: "Enable cognitive security (threat detection, decision integrity)?",
    initialValue: true,
  });

  const enableARR = securityLevel !== "basic"
    ? await prompter.confirm({
        message: "Enable Adversary Recommender (automated red team testing)?",
        initialValue: securityLevel === "advanced",
      })
    : false;

  const enableSwarm = securityLevel === "advanced"
    ? await prompter.confirm({
        message: "Enable swarm agents (multi-agent collaboration)?",
        initialValue: true,
      })
    : false;

  const config = await setupSecurityConfig(baseConfig, runtime, prompter, {
    enableLLMSecurity: enableLLM,
    enableCognitiveSecurity: enableCognitive,
    enableARR: enableARR,
    enableSwarmAgents: enableSwarm,
    securityLevel: securityLevel as "basic" | "standard" | "advanced",
  });

  // Ensure workspace directories are created
  try {
    const { ensureSecurityWorkspaces } = await import("../security/workspace.js");
    await ensureSecurityWorkspaces(config);
  } catch (error) {
    await prompter.note(
      `Warning: Failed to create security workspace directories: ${error instanceof Error ? error.message : String(error)}`,
      "Workspace Setup",
    );
  }

  // Security best practices reminder
  await prompter.note(
    [
      "Security features configured!",
      "",
      "Security best practices:",
      "  ✓ Pairing/allowlists: Configure channel access controls",
      "  ✓ Gateway auth: Use token or password authentication",
      "  ✓ Regular audits: Run 'openclaw security audit --deep' regularly",
      "  ✓ Keep secrets secure: Don't store API keys in agent-accessible files",
      "  ✓ Use sandbox: Enable sandbox for tool execution when possible",
      "",
      "Next steps:",
      "  • Review channel pairing/allowlist settings",
      "  • Verify gateway authentication is configured",
      "  • Run security audit after setup completes",
      "",
      "Docs: https://docs.openclaw.ai/gateway/security",
    ].join("\n"),
    "Security Configuration Complete",
  );

  return config;
}

/**
 * Non-interactive security setup with defaults.
 */
export async function setupSecurityNonInteractive(
  baseConfig: OpenClawConfig,
  runtime: RuntimeEnv,
  options: {
    securityLevel?: "basic" | "standard" | "advanced";
  } = {},
): Promise<OpenClawConfig> {
  return await setupSecurityConfig(baseConfig, runtime, {
    confirm: async () => Promise.resolve(true),
    select: async () => Promise.resolve("standard"),
    multiselect: async () => Promise.resolve([]),
    text: async () => Promise.resolve(""),
    note: async () => Promise.resolve(),
    intro: async () => Promise.resolve(),
    outro: async () => Promise.resolve(),
    progress: () => ({ update: () => {}, end: () => {} }),
  } as WizardPrompter, {
    enableLLMSecurity: true,
    enableCognitiveSecurity: true,
    enableARR: options.securityLevel !== "basic",
    enableSwarmAgents: options.securityLevel === "advanced",
    securityLevel: options.securityLevel ?? "standard",
  });
}
