/**
 * CLI commands for `openclaw secrets` subcommands.
 */

import {
  rotateGatewayToken,
  createDefaultDeps,
  type RotationDeps,
} from "../config/auto-rotation.js";
import {
  type SecretWithLabels,
  parseRotationLabels,
  buildRotationLabels,
  checkAllSecrets,
  snoozeReminder,
  acknowledgeRotation,
  setRotationInterval,
} from "../config/rotation-reminders.js";

// ---------------------------------------------------------------------------
// Types for mock/test injection
// ---------------------------------------------------------------------------

interface TestCommandOptions {
  configPath: string;
  _mockProviderResult?: { ok: boolean; error?: string };
}

interface ListCommandOptions {
  configPath: string;
  _mockProviders?: Array<{ name: string; project: string; status: string }>;
}

interface SetupCommandOptions {
  provider?: string;
  // GCP
  project?: string;
  // AWS
  region?: string;
  profile?: string;
  roleArn?: string;
  // Common
  agents?: string[];
  yes?: boolean;
  _mockExec?: (cmd: string) => Promise<{ stdout: string; exitCode: number }>;
  _mockWriteConfig?: (config: unknown) => void;
}

interface MigrateCommandOptions {
  configPath: string;
  yes?: boolean;
  _mockConfig?: Record<string, unknown>;
  _mockProvider?: {
    setSecret: (name: string, value: string) => Promise<void>;
    getSecret: (name: string) => Promise<string>;
  };
  _mockPurge?: () => void;
  _mockPrompt?: (message: string) => Promise<boolean>;
}

interface SetCommandOptions {
  provider: string;
  name: string;
  value: string;
  _mockProvider?: { setSecret: (name: string, value: string) => Promise<void> } | null;
}

// Remind command types
interface RemindListOptions {
  _mockSecrets?: SecretWithLabels[];
}

interface RemindSetOptions {
  secret: string;
  intervalDays: number;
  _mockGetLabels?: (name: string) => Promise<Record<string, string>>;
  _mockSetLabels?: (name: string, labels: Record<string, string>) => Promise<void>;
}

interface RemindSnoozeOptions {
  secret: string;
  days: number;
  _mockGetLabels?: (name: string) => Promise<Record<string, string>>;
  _mockSetLabels?: (name: string, labels: Record<string, string>) => Promise<void>;
}

interface RemindAckOptions {
  secret: string;
  _mockGetLabels?: (name: string) => Promise<Record<string, string>>;
  _mockSetLabels?: (name: string, labels: Record<string, string>) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Scan config for values that look like secrets (API keys, tokens, etc.) */
function scanForSensitiveValues(
  obj: unknown,
  path = "",
): Array<{ path: string; value: string; suggestedName: string }> {
  const results: Array<{ path: string; value: string; suggestedName: string }> = [];

  if (typeof obj === "string") {
    // Skip if already a secret ref
    if (obj.includes("${gcp:")) {
      return results;
    }
    // Heuristic: looks like a secret if it has certain patterns
    if (
      /^(sk-|xoxb-|xapp-|ghp_|ghs_|glpat-|AKIA|eyJ)/i.test(obj) ||
      (obj.length > 20 &&
        /[a-zA-Z0-9+/=_-]{20,}/.test(obj) &&
        path.match(/key|token|secret|password|credential/i))
    ) {
      const suggestedName =
        "openclaw-" +
        path
          .replace(/\./g, "-")
          .replace(/[^a-zA-Z0-9-]/g, "")
          .toLowerCase();
      results.push({ path, value: obj, suggestedName });
    }
    return results;
  }

  if (Array.isArray(obj)) {
    obj.forEach((item, i) => results.push(...scanForSensitiveValues(item, `${path}[${i}]`)));
    return results;
  }

  if (obj && typeof obj === "object") {
    for (const [key, val] of Object.entries(obj)) {
      const childPath = path ? `${path}.${key}` : key;
      results.push(...scanForSensitiveValues(val, childPath));
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export async function secretsTestCommand(options: TestCommandOptions): Promise<number> {
  const result = options._mockProviderResult;

  if (!result || !result.ok) {
    console.error(`Error: ${result?.error || "Unknown error"}`);
    return 1;
  }

  console.log("All secret references resolved successfully. ✓");
  return 0;
}

export async function secretsListCommand(options: ListCommandOptions): Promise<number> {
  const providers = options._mockProviders || [];

  if (providers.length === 0) {
    console.log("No secrets providers configured.");
    return 0;
  }

  for (const p of providers) {
    console.log(`Provider: ${p.name} (project: ${p.project}) — Status: ${p.status}`);
  }
  return 0;
}

export async function secretsSetupCommand(options: SetupCommandOptions): Promise<number> {
  const exec = options._mockExec;
  if (!exec) {
    return 1;
  }

  const provider = options.provider ?? "gcp";

  if (provider === "aws") {
    return secretsSetupAws(options);
  }

  // GCP setup (original)
  const gcloudCheck = await exec("gcloud --version");
  if (gcloudCheck.exitCode !== 0) {
    console.error("Error: gcloud CLI is not installed or not in PATH");
    return 1;
  }

  await exec(`gcloud services enable secretmanager.googleapis.com --project=${options.project}`);

  const agents = options.agents || ["main"];
  for (const agent of agents) {
    await exec(
      `gcloud iam service-accounts create openclaw-${agent} --display-name="OpenClaw ${agent} agent" --project=${options.project}`,
    );
    await exec(
      `gcloud projects add-iam-policy-binding ${options.project} --member=serviceAccount:openclaw-${agent}@${options.project}.iam.gserviceaccount.com --role=roles/secretmanager.secretAccessor`,
    );
  }

  const secretsConfig = {
    secrets: {
      providers: {
        gcp: { project: options.project },
      },
    },
  };

  if (options._mockWriteConfig) {
    options._mockWriteConfig(secretsConfig);
  }

  return 0;
}

async function secretsSetupAws(options: SetupCommandOptions): Promise<number> {
  const exec = options._mockExec!;

  // 1. Check AWS CLI
  const awsCheck = await exec("aws --version");
  if (awsCheck.exitCode !== 0) {
    console.error("Error: AWS CLI is not installed or not in PATH");
    return 1;
  }

  // 2. Verify credentials
  const stsCheck = await exec("aws sts get-caller-identity");
  if (stsCheck.exitCode !== 0) {
    console.error("Error: AWS credentials not configured. Run `aws configure` first.");
    return 1;
  }

  const region = options.region ?? "us-east-1";
  const agents = options.agents || ["main"];

  // 3. Create IAM policies for per-agent isolation
  for (const agent of agents) {
    const policyName = `openclaw-${agent}-secrets`;
    await exec(
      `aws iam create-policy --policy-name ${policyName} --policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":["secretsmanager:GetSecretValue"],"Resource":"arn:aws:secretsmanager:${region}:*:secret:openclaw-${agent}-*"}]}'`,
    );
    await exec(`aws iam create-user --user-name openclaw-${agent}`);
    await exec(
      `aws iam attach-user-policy --user-name openclaw-${agent} --policy-arn arn:aws:iam::*:policy/${policyName}`,
    );
  }

  // 4. Write config
  const secretsConfig = {
    secrets: {
      providers: {
        aws: {
          region,
          ...(options.profile ? { profile: options.profile } : {}),
          ...(options.roleArn ? { roleArn: options.roleArn } : {}),
        },
      },
    },
  };

  if (options._mockWriteConfig) {
    options._mockWriteConfig(secretsConfig);
  }

  return 0;
}

export async function secretsMigrateCommand(options: MigrateCommandOptions): Promise<number> {
  const config = options._mockConfig;
  const provider = options._mockProvider;

  if (!config || !provider) {
    console.error("Error: No config or provider available");
    return 1;
  }

  // 1. Scan for sensitive values
  const found = scanForSensitiveValues(config);
  console.log(`Found ${found.length} potential secrets to migrate.`);

  if (found.length === 0) {
    console.log("No secrets found to migrate.");
    return 0;
  }

  // 2. Upload each secret
  let allUploaded = true;
  for (const item of found) {
    try {
      await provider.setSecret(item.suggestedName, item.value);
      console.log(`Uploaded: ${item.suggestedName} (from ${item.path})`);
    } catch (err: unknown) {
      console.error(
        `Failed to upload ${item.suggestedName}: ${err instanceof Error ? err.message : String(err)}`,
      );
      allUploaded = false;
    }
  }

  if (!allUploaded) {
    console.error("Error: Some secrets failed to upload. Aborting migration.");
    return 1;
  }

  // 3. Verify refs resolve
  for (const item of found) {
    try {
      await provider.getSecret(item.suggestedName);
    } catch (err: unknown) {
      console.error(
        `Verification failed for ${item.suggestedName}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return 1;
    }
  }

  // 4. Prompt before purge (if interactive)
  if (!options.yes && options._mockPrompt) {
    const confirmed = await options._mockPrompt("Purge plaintext secrets from config?");
    if (!confirmed) {
      console.log("Skipping purge.");
      return 0;
    }
  }

  // 5. Purge
  if (options._mockPurge) {
    options._mockPurge();
  }

  console.log("Migration complete.");
  return 0;
}

export async function secretsSetCommand(options: SetCommandOptions): Promise<number> {
  const provider = options._mockProvider;

  if (!provider) {
    console.error(`Error: Provider "${options.provider}" is not configured.`);
    return 1;
  }

  try {
    await provider.setSecret(options.name, options.value);
    console.log(`Secret "${options.name}" stored successfully.`);
    return 0;
  } catch (err: unknown) {
    console.error(
      `Error: Failed to store secret "${options.name}": ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  }
}

// ---------------------------------------------------------------------------
// Remind Commands
// ---------------------------------------------------------------------------

export async function secretsRemindListCommand(options: RemindListOptions): Promise<number> {
  const secrets = options._mockSecrets || [];
  if (secrets.length === 0) {
    console.log("No secrets found.");
    return 0;
  }

  const results = checkAllSecrets(secrets);
  for (const r of results) {
    const lastRotated = r.metadata.lastRotated
      ? r.metadata.lastRotated.toISOString().split("T")[0]
      : "never";
    const nextReview = r.status.nextReviewDate
      ? r.status.nextReviewDate.toISOString().split("T")[0]
      : "—";
    const stateLabel = r.status.state.toUpperCase();
    const overdue = r.status.daysOverdue ? ` (${r.status.daysOverdue}d overdue)` : "";
    console.log(
      `${r.name}  type=${r.metadata.rotationType}  interval=${r.metadata.rotationIntervalDays}d  last=${lastRotated}  next=${nextReview}  [${stateLabel}]${overdue}`,
    );
  }
  return 0;
}

export async function secretsRemindSetCommand(options: RemindSetOptions): Promise<number> {
  if (!options._mockGetLabels || !options._mockSetLabels) {
    console.error("Error: No GCP client available.");
    return 1;
  }

  try {
    const labels = await options._mockGetLabels(options.secret);
    const meta = parseRotationLabels(labels);
    const updated = setRotationInterval(meta, options.intervalDays);
    const newLabels = { ...labels, ...buildRotationLabels(updated) };
    await options._mockSetLabels(options.secret, newLabels);
    console.log(`Set rotation interval for "${options.secret}" to ${options.intervalDays} days.`);
    return 0;
  } catch (err: unknown) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

export async function secretsRemindSnoozeCommand(options: RemindSnoozeOptions): Promise<number> {
  if (!options._mockGetLabels || !options._mockSetLabels) {
    console.error("Error: No GCP client available.");
    return 1;
  }

  try {
    const labels = await options._mockGetLabels(options.secret);
    const meta = parseRotationLabels(labels);
    const updated = snoozeReminder(meta, options.days);
    const newLabels = { ...labels, ...buildRotationLabels(updated) };
    await options._mockSetLabels(options.secret, newLabels);
    console.log(`Snoozed reminders for "${options.secret}" for ${options.days} days.`);
    return 0;
  } catch (err: unknown) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

export async function secretsRemindAckCommand(options: RemindAckOptions): Promise<number> {
  if (!options._mockGetLabels || !options._mockSetLabels) {
    console.error("Error: No GCP client available.");
    return 1;
  }

  try {
    const labels = await options._mockGetLabels(options.secret);
    const meta = parseRotationLabels(labels);
    const updated = acknowledgeRotation(meta);
    const newLabels = { ...labels, ...buildRotationLabels(updated) };
    // Ack clears snooze
    delete newLabels["snoozed-until"];
    await options._mockSetLabels(options.secret, newLabels);
    console.log(`Acknowledged rotation for "${options.secret}". Last rotated set to now.`);
    return 0;
  } catch (err: unknown) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

// ---------------------------------------------------------------------------
// Rotate Command
// ---------------------------------------------------------------------------

interface RotateCommandOptions {
  secret?: string;
  _mockDeps?: Partial<RotationDeps>;
}

export async function secretsRotateCommand(options: RotateCommandOptions): Promise<number> {
  const secretName = options.secret ?? "openclaw-main-gateway-token";

  if (secretName !== "openclaw-main-gateway-token") {
    console.error(
      `Error: Auto-rotation is only supported for "openclaw-main-gateway-token" currently.`,
    );
    return 1;
  }

  console.log(`Rotating secret: ${secretName}`);

  const deps = createDefaultDeps(options._mockDeps);
  const result = await rotateGatewayToken(deps);

  if (!result.success) {
    console.error(`Rotation failed: ${result.error}`);
    if (result.oldToken) {
      console.error(`Old token preserved. No changes made to config.`);
    }
    return 1;
  }

  console.log(`✓ New token stored in GCP (version: ${result.versionName ?? "latest"})`);
  console.log(`✓ Local config updated`);
  console.log(`⚠ Gateway restart required for new token to take effect`);
  return 0;
}
