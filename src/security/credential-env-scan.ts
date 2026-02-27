/**
 * Credential Environment Scanner - Phase 5 Security Hardening
 *
 * Scans environment variables for exposed credentials and
 * offers migration to the secure vault.
 */

import { createSubsystemLogger } from "../logging/subsystem.js";
import type { CredentialScope, VaultOperationResult } from "./credential-vault.js";
import { storeCredential, hasCredential } from "./credential-vault.js";

const log = createSubsystemLogger("security/credential-env-scan");

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export type EnvCredentialFinding = {
  varName: string;
  scope: CredentialScope;
  provider: string;
  riskLevel: "high" | "medium" | "low";
  recommendation: "migrate" | "rotate" | "review";
  description: string;
};

export type EnvScanResult = {
  scannedAt: number;
  scannedVars: number;
  findings: EnvCredentialFinding[];
  migrationAvailable: boolean;
};

export type EnvMigrationResult = {
  varName: string;
  success: boolean;
  error?: string;
  vaultResult?: VaultOperationResult;
};

// -----------------------------------------------------------------------------
// Detection Patterns
// -----------------------------------------------------------------------------

type EnvCredentialPattern = {
  pattern: RegExp;
  scope: CredentialScope;
  provider: string;
  riskLevel: "high" | "medium" | "low";
  description: string;
};

const ENV_CREDENTIAL_PATTERNS: EnvCredentialPattern[] = [
  // LLM Provider API Keys (high risk - can generate significant costs)
  {
    pattern: /^ANTHROPIC_API_KEY$/i,
    scope: "provider",
    provider: "anthropic",
    riskLevel: "high",
    description: "Anthropic API key for Claude models",
  },
  {
    pattern: /^OPENAI_API_KEY$/i,
    scope: "provider",
    provider: "openai",
    riskLevel: "high",
    description: "OpenAI API key for GPT models",
  },
  {
    pattern: /^GOOGLE_API_KEY$/i,
    scope: "provider",
    provider: "google",
    riskLevel: "high",
    description: "Google AI/Firebase API key",
  },
  {
    pattern: /^PERPLEXITY_API_KEY$/i,
    scope: "provider",
    provider: "perplexity",
    riskLevel: "high",
    description: "Perplexity AI API key",
  },
  {
    pattern: /^GROQ_API_KEY$/i,
    scope: "provider",
    provider: "groq",
    riskLevel: "high",
    description: "Groq API key",
  },
  {
    pattern: /^MISTRAL_API_KEY$/i,
    scope: "provider",
    provider: "mistral",
    riskLevel: "high",
    description: "Mistral AI API key",
  },
  {
    pattern: /^COHERE_API_KEY$/i,
    scope: "provider",
    provider: "cohere",
    riskLevel: "high",
    description: "Cohere API key",
  },
  {
    pattern: /^HUGGINGFACE_(?:API_KEY|TOKEN)$/i,
    scope: "provider",
    provider: "huggingface",
    riskLevel: "medium",
    description: "Hugging Face API token",
  },

  // Channel Tokens (medium risk - can send messages as bot)
  {
    pattern: /^TELEGRAM_BOT_TOKEN$/i,
    scope: "channel",
    provider: "telegram",
    riskLevel: "medium",
    description: "Telegram bot token",
  },
  {
    pattern: /^DISCORD_(?:BOT_)?TOKEN$/i,
    scope: "channel",
    provider: "discord",
    riskLevel: "medium",
    description: "Discord bot token",
  },
  {
    pattern: /^SLACK_BOT_TOKEN$/i,
    scope: "channel",
    provider: "slack",
    riskLevel: "medium",
    description: "Slack bot token (xoxb-*)",
  },
  {
    pattern: /^SLACK_APP_TOKEN$/i,
    scope: "channel",
    provider: "slack",
    riskLevel: "medium",
    description: "Slack app token (xapp-*)",
  },
  {
    pattern: /^SLACK_SIGNING_SECRET$/i,
    scope: "channel",
    provider: "slack",
    riskLevel: "medium",
    description: "Slack signing secret for request verification",
  },

  // Integration Tokens (varies - depends on service)
  {
    pattern: /^GITHUB_(?:TOKEN|PAT)$/i,
    scope: "integration",
    provider: "github",
    riskLevel: "high",
    description: "GitHub personal access token",
  },
  {
    pattern: /^GITLAB_(?:TOKEN|PAT)$/i,
    scope: "integration",
    provider: "gitlab",
    riskLevel: "high",
    description: "GitLab personal access token",
  },
  {
    pattern: /^STRIPE_(?:SECRET|API)_KEY$/i,
    scope: "integration",
    provider: "stripe",
    riskLevel: "high",
    description: "Stripe API secret key",
  },
  {
    pattern: /^SENDGRID_API_KEY$/i,
    scope: "integration",
    provider: "sendgrid",
    riskLevel: "medium",
    description: "SendGrid API key for email",
  },
  {
    pattern: /^TWILIO_(?:AUTH_TOKEN|API_KEY)$/i,
    scope: "integration",
    provider: "twilio",
    riskLevel: "medium",
    description: "Twilio authentication token",
  },
  {
    pattern: /^AWS_(?:SECRET_ACCESS_KEY|SESSION_TOKEN)$/i,
    scope: "integration",
    provider: "aws",
    riskLevel: "high",
    description: "AWS credential (secret key or session token)",
  },
  {
    pattern: /^AZURE_(?:CLIENT_SECRET|SUBSCRIPTION_KEY)$/i,
    scope: "integration",
    provider: "azure",
    riskLevel: "high",
    description: "Azure service credential",
  },
  {
    pattern: /^GCP_(?:SERVICE_ACCOUNT_KEY|API_KEY)$/i,
    scope: "integration",
    provider: "gcp",
    riskLevel: "high",
    description: "Google Cloud Platform credential",
  },

  // Internal OpenClaw Tokens
  {
    pattern: /^OPENCLAW_GATEWAY_TOKEN$/i,
    scope: "internal",
    provider: "gateway",
    riskLevel: "medium",
    description: "OpenClaw gateway authentication token",
  },
  {
    pattern: /^OPENCLAW_HOOKS_TOKEN$/i,
    scope: "internal",
    provider: "hooks",
    riskLevel: "medium",
    description: "OpenClaw webhook authentication token",
  },
  {
    pattern: /^OPENCLAW_API_KEY$/i,
    scope: "internal",
    provider: "api",
    riskLevel: "medium",
    description: "OpenClaw API key",
  },

  // Database Credentials (high risk - direct data access)
  {
    pattern: /^(?:DATABASE|DB|POSTGRES|MYSQL|MONGO(?:DB)?|REDIS)_(?:PASSWORD|SECRET|URI|URL)$/i,
    scope: "integration",
    provider: "database",
    riskLevel: "high",
    description: "Database connection credential",
  },

  // Generic patterns (low confidence)
  {
    pattern: /^[A-Z0-9_]*(?:SECRET|PASSWORD|PRIVATE_KEY|AUTH_TOKEN)$/i,
    scope: "integration",
    provider: "unknown",
    riskLevel: "low",
    description: "Generic secret or password variable",
  },
];

// Value patterns to validate actual credential content
const VALUE_VALIDATORS: Array<{ pattern: RegExp; riskMultiplier: number }> = [
  // Anthropic keys
  { pattern: /^sk-ant-(?:api|admin)\d+-[A-Za-z0-9_-]{20,}$/, riskMultiplier: 1.5 },
  // OpenAI keys
  { pattern: /^sk-[A-Za-z0-9_-]{20,}$/, riskMultiplier: 1.5 },
  // AWS keys
  { pattern: /^AKIA[A-Z0-9]{16}$/, riskMultiplier: 1.5 },
  // Slack tokens
  { pattern: /^xox[baprs]-/, riskMultiplier: 1.2 },
  // Telegram tokens
  { pattern: /^\d{6,}:[A-Za-z0-9_-]{20,}$/, riskMultiplier: 1.2 },
  // GitHub tokens
  { pattern: /^gh[ps]_[A-Za-z0-9]{36}$/, riskMultiplier: 1.3 },
  // Generic high-entropy (base64-like, 32+ chars)
  { pattern: /^[A-Za-z0-9+/=_-]{32,}$/, riskMultiplier: 1.0 },
];

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------

/**
 * Scan environment variables for exposed credentials.
 */
export function scanEnvironmentForCredentials(env: NodeJS.ProcessEnv = process.env): EnvScanResult {
  const findings: EnvCredentialFinding[] = [];
  const scannedVars = Object.keys(env).length;

  for (const [varName, value] of Object.entries(env)) {
    if (!value || value.length < 8) {
      continue;
    }

    for (const pattern of ENV_CREDENTIAL_PATTERNS) {
      if (pattern.pattern.test(varName)) {
        // Validate the value looks like a real credential
        const hasHighEntropyValue = VALUE_VALIDATORS.some((v) => v.pattern.test(value));

        // Skip generic patterns if value doesn't look like a credential
        if (pattern.provider === "unknown" && !hasHighEntropyValue) {
          continue;
        }

        findings.push({
          varName,
          scope: pattern.scope,
          provider: pattern.provider,
          riskLevel: pattern.riskLevel,
          recommendation: pattern.riskLevel === "high" ? "migrate" : "review",
          description: pattern.description,
        });

        break; // Don't match multiple patterns for same var
      }
    }
  }

  // Sort by risk level (high first)
  const riskOrder: Record<string, number> = { high: 0, medium: 1, low: 2 };
  findings.sort((a, b) => riskOrder[a.riskLevel] - riskOrder[b.riskLevel]);

  log.info("environment scan complete", {
    scannedVars,
    findingsCount: findings.length,
    highRisk: findings.filter((f) => f.riskLevel === "high").length,
  });

  return {
    scannedAt: Date.now(),
    scannedVars,
    findings,
    migrationAvailable: findings.length > 0,
  };
}

/**
 * Migrate a credential from environment to the vault.
 */
export async function migrateEnvToVault(
  varName: string,
  env: NodeJS.ProcessEnv = process.env,
  options?: {
    removeFromEnv?: boolean;
  },
): Promise<EnvMigrationResult> {
  const value = env[varName];

  if (!value) {
    return {
      varName,
      success: false,
      error: `Environment variable "${varName}" not found or empty`,
    };
  }

  // Find the matching pattern to determine scope and provider
  let scope: CredentialScope = "integration";
  let provider = "unknown";

  for (const pattern of ENV_CREDENTIAL_PATTERNS) {
    if (pattern.pattern.test(varName)) {
      scope = pattern.scope;
      provider = pattern.provider;
      break;
    }
  }

  // Generate credential name from var name
  const credName = varName.toLowerCase().replace(/_/g, "-");

  // Check if already in vault
  if (hasCredential(credName, scope)) {
    return {
      varName,
      success: false,
      error: `Credential "${credName}" already exists in vault scope "${scope}"`,
    };
  }

  // Store in vault
  const vaultResult = storeCredential(credName, value, scope);

  if (!vaultResult.ok) {
    return {
      varName,
      success: false,
      error: vaultResult.error,
      vaultResult,
    };
  }

  // Optionally remove from environment
  if (options?.removeFromEnv) {
    delete env[varName];
    log.info("removed credential from environment", { varName });
  }

  log.info("migrated credential to vault", {
    varName,
    credName,
    scope,
    provider,
  });

  return {
    varName,
    success: true,
    vaultResult,
  };
}

/**
 * Migrate all detected credentials from environment to vault.
 */
export async function migrateAllEnvToVault(
  env: NodeJS.ProcessEnv = process.env,
  options?: {
    removeFromEnv?: boolean;
    riskLevelFilter?: "high" | "medium" | "low";
  },
): Promise<{
  total: number;
  migrated: number;
  failed: number;
  skipped: number;
  results: EnvMigrationResult[];
}> {
  const scanResult = scanEnvironmentForCredentials(env);
  const results: EnvMigrationResult[] = [];

  let migrated = 0;
  let failed = 0;
  let skipped = 0;

  for (const finding of scanResult.findings) {
    // Apply risk level filter if specified
    if (options?.riskLevelFilter) {
      const riskOrder: Record<string, number> = { high: 0, medium: 1, low: 2 };
      const filterLevel = riskOrder[options.riskLevelFilter];
      const findingLevel = riskOrder[finding.riskLevel];
      if (findingLevel > filterLevel) {
        skipped++;
        continue;
      }
    }

    const result = await migrateEnvToVault(finding.varName, env, {
      removeFromEnv: options?.removeFromEnv,
    });

    results.push(result);

    if (result.success) {
      migrated++;
    } else {
      failed++;
    }
  }

  return {
    total: scanResult.findings.length,
    migrated,
    failed,
    skipped,
    results,
  };
}

/**
 * Generate a secure .env template with vault references.
 */
export function generateSecureEnvTemplate(scanResult?: EnvScanResult): string {
  const result = scanResult ?? scanEnvironmentForCredentials();

  const lines: string[] = [
    "# Secure Environment Template",
    "# Generated by OpenClaw credential scanner",
    "#",
    "# IMPORTANT: Do not store actual credentials in this file.",
    "# Use the OpenClaw vault instead:",
    "#   openclaw credential store --name <name> --scope <scope>",
    "#",
    "",
  ];

  // Group by scope
  const byScope: Record<CredentialScope, EnvCredentialFinding[]> = {
    provider: [],
    channel: [],
    integration: [],
    internal: [],
  };

  for (const finding of result.findings) {
    byScope[finding.scope].push(finding);
  }

  const scopeLabels: Record<CredentialScope, string> = {
    provider: "LLM Provider Credentials",
    channel: "Channel Tokens",
    integration: "Integration Credentials",
    internal: "Internal OpenClaw Credentials",
  };

  for (const [scope, scopeFindings] of Object.entries(byScope)) {
    if (scopeFindings.length === 0) {
      continue;
    }

    lines.push(`# ${scopeLabels[scope as CredentialScope]}`);
    lines.push(`# Scope: ${scope}`);

    for (const finding of scopeFindings) {
      lines.push(`# ${finding.varName}=${finding.riskLevel.toUpperCase()}_RISK`);
      lines.push(
        `# → Run: openclaw credential store --name ${finding.varName.toLowerCase().replace(/_/g, "-")} --scope ${scope}`,
      );
    }

    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Check if any high-risk credentials are exposed in environment.
 */
export function hasExposedHighRiskCredentials(env: NodeJS.ProcessEnv = process.env): boolean {
  const result = scanEnvironmentForCredentials(env);
  return result.findings.some((f) => f.riskLevel === "high");
}

/**
 * Get a summary of credential exposure for display.
 */
export function getCredentialExposureSummary(env: NodeJS.ProcessEnv = process.env): {
  high: number;
  medium: number;
  low: number;
  total: number;
  providers: string[];
} {
  const result = scanEnvironmentForCredentials(env);

  const high = result.findings.filter((f) => f.riskLevel === "high").length;
  const medium = result.findings.filter((f) => f.riskLevel === "medium").length;
  const low = result.findings.filter((f) => f.riskLevel === "low").length;

  const providers = [...new Set(result.findings.map((f) => f.provider))];

  return {
    high,
    medium,
    low,
    total: result.findings.length,
    providers,
  };
}
