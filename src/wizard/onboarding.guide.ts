import { formatCliCommand } from "../cli/command-format.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveControlUiLinks } from "../commands/onboard-helpers.js";
import type { VerificationResult } from "./onboarding.verify.js";
import type { WizardFlow } from "./onboarding.types.js";

export type NextStepsGuide = {
  title: string;
  steps: string[];
  commands: Array<{ label: string; command: string }>;
  links: Array<{ label: string; url: string }>;
};

/**
 * Generate personalized next steps guide based on onboarding choices.
 */
export function generateNextStepsGuide(
  config: OpenClawConfig,
  verification: VerificationResult,
  flow: WizardFlow,
  gatewayToken?: string,
): NextStepsGuide {
  const steps: string[] = [];
  const commands: Array<{ label: string; command: string }> = [];
  const links: Array<{ label: string; url: string }> = [];

  // Gateway status
  if (verification.gateway.ok) {
    const port = config.gateway?.port ?? 18789;
    const bind = config.gateway?.bind ?? "loopback";
    const host = bind === "loopback" ? "127.0.0.1" : "0.0.0.0";
    const links = resolveControlUiLinks({
      bind,
      port,
      customBindHost: config.gateway?.customBindHost,
      basePath: config.gateway?.controlUi?.basePath,
    });

    steps.push("Your Gateway is running and accessible");
    commands.push({
      label: "Open Dashboard",
      command: formatCliCommand(`openclaw dashboard`),
    });

    if (gatewayToken) {
      const authedUrl = `${links.httpUrl}#token=${encodeURIComponent(gatewayToken)}`;
      links.push({
        label: "Dashboard (with token)",
        url: authedUrl,
      });
    }
  } else {
    steps.push("Gateway verification failed - check gateway status");
    commands.push({
      label: "Check Gateway Status",
      command: formatCliCommand("openclaw gateway status"),
    });
    commands.push({
      label: "Start Gateway",
      command: formatCliCommand("openclaw gateway run"),
    });
  }

  // Workspace
  if (verification.workspace.ok) {
    steps.push("Workspace is set up and ready");
  } else {
    steps.push("Workspace setup needs attention");
    commands.push({
      label: "Check Workspace",
      command: formatCliCommand("openclaw agents list"),
    });
  }

  // Provider
  if (verification.provider.ok) {
    steps.push("AI provider is configured");
  } else {
    steps.push("Configure your AI provider");
    commands.push({
      label: "Configure Provider",
      command: formatCliCommand("openclaw configure --section agents"),
    });
  }

  // Channels
  if (verification.channels.length > 0) {
    const enabledChannels = verification.channels.filter((c) => c.ok);
    if (enabledChannels.length > 0) {
      steps.push(`${enabledChannels.length} channel(s) configured`);
    }
  } else {
    steps.push("No channels configured yet");
    commands.push({
      label: "Add Channels",
      command: formatCliCommand("openclaw configure --section channels"),
    });
  }

  // QuickStart vs Advanced specific guidance
  if (flow === "quickstart") {
    steps.push("QuickStart mode: Use defaults or customize later");
    commands.push({
      label: "Customize Configuration",
      command: formatCliCommand("openclaw configure"),
    });
  } else {
    steps.push("Advanced mode: Full control over configuration");
  }

  // Web search setup
  const hasWebSearch =
    Boolean(config.tools?.web?.search?.apiKey) ||
    Boolean(process.env.BRAVE_API_KEY);
  if (!hasWebSearch) {
    steps.push("Optional: Set up web search for better agent capabilities");
    commands.push({
      label: "Configure Web Search",
      command: formatCliCommand("openclaw configure --section web"),
    });
  }

  // Security verification status
  if (verification.security) {
    if (verification.security.ok) {
      const enabledFeatures = verification.security.details.filter((d) => d.ok).length;
      steps.push(`Security features verified (${enabledFeatures} feature(s) checked)`);
    } else {
      steps.push("Security feature verification found issues - review configuration");
      const failedFeatures = verification.security.details.filter((d) => !d.ok);
      for (const feature of failedFeatures) {
        steps.push(`  - ${feature.feature}: ${feature.detail ?? "Failed"}`);
      }
    }
  } else if (config.security) {
    steps.push("Security features configured (verification skipped)");
  }

  // First message guidance
  if (verification.gateway.ok && verification.channels.length > 0) {
    steps.push("Ready to send your first message!");
    commands.push({
      label: "Send Test Message",
      command: formatCliCommand("openclaw message send --help"),
    });
  }

  // Security audit prompt
  if (config.security) {
    steps.push("Run security audit to check for common issues");
    commands.push({
      label: "Run Security Audit",
      command: formatCliCommand("openclaw security audit --deep"),
    });
  }

  // Security reminders
  steps.push("Review security settings and pairing rules");
  links.push({
    label: "Security Guide",
    url: "https://docs.openclaw.ai/gateway/security",
  });
  links.push({
    label: "Pairing & Allowlists",
    url: "https://docs.openclaw.ai/channels/pairing",
  });

  // Feature-specific next steps
  if (config.security?.llmSecurity?.enabled) {
    steps.push("LLM Security enabled - test prompt injection detection");
    links.push({
      label: "LLM Security Documentation",
      url: "https://docs.openclaw.ai/security/llm-security",
    });
  }

  if (config.security?.cognitiveSecurity?.enabled) {
    steps.push("Cognitive Security enabled - monitor threat detection");
    links.push({
      label: "Cognitive Security Documentation",
      url: "https://docs.openclaw.ai/security/cognitive-security",
    });
  }

  if (config.security?.adversaryRecommender?.enabled) {
    steps.push("Adversary Recommender enabled - review attack recommendations");
    links.push({
      label: "ARR Documentation",
      url: "https://docs.openclaw.ai/security/adversary-recommender",
    });
  }

  if (config.security?.swarmAgents?.enabled) {
    steps.push("Swarm Agents enabled - configure swarm operations");
    links.push({
      label: "Swarm Agents Documentation",
      url: "https://docs.openclaw.ai/security/swarm-agent-planning",
    });
  }

  // Common next steps
  commands.push({
    label: "View Status",
    command: formatCliCommand("openclaw status"),
  });
  commands.push({
    label: "Check Health",
    command: formatCliCommand("openclaw health"),
  });

  links.push({
    label: "Documentation",
    url: "https://docs.openclaw.ai",
  });
  links.push({
    label: "Showcase",
    url: "https://openclaw.ai/showcase",
  });

  return {
    title: "What's Next?",
    steps,
    commands,
    links,
  };
}

/**
 * Format next steps guide for display.
 */
export function formatNextStepsGuide(guide: NextStepsGuide): string {
  const lines: string[] = [];
  lines.push(guide.title);
  lines.push("");

  if (guide.steps.length > 0) {
    lines.push("Setup Status:");
    for (const step of guide.steps) {
      lines.push(`  • ${step}`);
    }
    lines.push("");
  }

  if (guide.commands.length > 0) {
    lines.push("Useful Commands:");
    for (const cmd of guide.commands) {
      lines.push(`  ${cmd.label}:`);
      lines.push(`    ${cmd.command}`);
    }
    lines.push("");
  }

  if (guide.links.length > 0) {
    lines.push("Helpful Links:");
    for (const link of guide.links) {
      lines.push(`  ${link.label}: ${link.url}`);
    }
  }

  return lines.join("\n");
}
