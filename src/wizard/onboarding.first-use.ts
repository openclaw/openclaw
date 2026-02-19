import type { OpenClawConfig } from "../config/config.js";

export type FirstUseHelp = {
  title: string;
  sections: Array<{
    heading: string;
    content: string[];
  }>;
  quickReference: Array<{ command: string; description: string }>;
  links: Array<{ label: string; url: string }>;
};

/**
 * Generate first-use help content explaining the "blackboard" pattern
 * and how to use OpenClaw effectively.
 */
export function generateFirstUseHelp(config: OpenClawConfig): FirstUseHelp {
  const sections: Array<{ heading: string; content: string[] }> = [];

  // Welcome and blackboard pattern explanation
  sections.push({
    heading: "Welcome to OpenClaw",
    content: [
      "OpenClaw uses a 'blackboard' pattern where AI models write their input to you, the expert system.",
      "You triage ideas, pick the best ones, and determine how to move forward.",
      "",
      "Think of it like having multiple specialized assistants working together:",
      "  • Some models are enthusiastic explorers (like Claude) - great for finding possibilities",
      "  • Others are calm analysts (like Gemini) - great for providing context and caution",
      "  • You are the expert who synthesizes their inputs and makes decisions",
      "",
      "⚠️  Security First:",
      "  • Configure pairing/allowlists for channels",
      "  • Use gateway authentication (token or password)",
      "  • Run security audits regularly",
      "  • Keep secrets out of agent-accessible files",
    ],
  });

  // Using multiple models effectively
  sections.push({
    heading: "Using Multiple Models Effectively",
    content: [
      "Different models have different strengths:",
      "",
      "  • Use Claude for creative exploration and finding vulnerabilities",
      "  • Use Gemini for holistic analysis and catching edge cases",
      "  • Use specialized models for specific tasks (coding, analysis, etc.)",
      "",
      "The key is knowing when to trust each model's output and when to cross-check.",
    ],
  });

  // Security features
  if (config.security) {
    sections.push({
      heading: "Security Features",
      content: [
        "Your security features are configured and ready:",
        "",
        ...(config.security.llmSecurity?.enabled
          ? ["  • LLM Security: Prompt injection and jailbreak detection enabled"]
          : []),
        ...(config.security.cognitiveSecurity?.enabled
          ? ["  • Cognitive Security: Threat detection and decision integrity enabled"]
          : []),
        ...(config.security.adversaryRecommender?.enabled
          ? ["  • Adversary Recommender: Automated red team testing enabled"]
          : []),
        ...(config.security.swarmAgents?.enabled
          ? ["  • Swarm Agents: Multi-agent collaboration enabled"]
          : []),
        "",
        "Run 'openclaw security audit --deep' regularly to check for issues.",
      ],
    });
  }

  // Quick reference
  const quickReference: Array<{ command: string; description: string }> = [
    {
      command: "openclaw status",
      description: "Check system status and agent health",
    },
    {
      command: "openclaw health",
      description: "Run comprehensive health check",
    },
    {
      command: "openclaw dashboard",
      description: "Open the web control UI",
    },
    {
      command: "openclaw configure",
      description: "Edit configuration interactively",
    },
  ];

  if (config.security) {
    quickReference.push({
      command: "openclaw security audit --deep",
      description: "Run security audit",
    });
  }

  // Links
  const links: Array<{ label: string; url: string }> = [
    {
      label: "Documentation",
      url: "https://docs.openclaw.ai",
    },
    {
      label: "Security Guide",
      url: "https://docs.openclaw.ai/gateway/security",
    },
    {
      label: "Showcase",
      url: "https://openclaw.ai/showcase",
    },
  ];

  if (config.security?.llmSecurity?.enabled) {
    links.push({
      label: "LLM Security",
      url: "https://docs.openclaw.ai/security/llm-security",
    });
  }

  if (config.security?.cognitiveSecurity?.enabled) {
    links.push({
      label: "Cognitive Security",
      url: "https://docs.openclaw.ai/security/cognitive-security",
    });
  }

  return {
    title: "Getting Started with OpenClaw",
    sections,
    quickReference,
    links,
  };
}

/**
 * Format first-use help for display.
 */
export function formatFirstUseHelp(help: FirstUseHelp): string {
  const lines: string[] = [];
  lines.push(help.title);
  lines.push("");

  for (const section of help.sections) {
    lines.push(section.heading);
    lines.push("");
    for (const line of section.content) {
      lines.push(line);
    }
    lines.push("");
  }

  if (help.quickReference.length > 0) {
    lines.push("Quick Reference:");
    lines.push("");
    for (const ref of help.quickReference) {
      lines.push(`  ${ref.command}`);
      lines.push(`    ${ref.description}`);
      lines.push("");
    }
  }

  if (help.links.length > 0) {
    lines.push("Helpful Links:");
    for (const link of help.links) {
      lines.push(`  ${link.label}: ${link.url}`);
    }
  }

  return lines.join("\n");
}
