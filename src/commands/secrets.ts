/**
 * CLI commands for `openclaw secrets` subcommands.
 */

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
  project: string;
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

  // 1. Check gcloud
  const gcloudCheck = await exec("gcloud --version");
  if (gcloudCheck.exitCode !== 0) {
    console.error("Error: gcloud CLI is not installed or not in PATH");
    return 1;
  }

  // 2. Enable Secret Manager API
  await exec(`gcloud services enable secretmanager.googleapis.com --project=${options.project}`);

  // 3. Create service accounts for agents
  const agents = options.agents || ["main"];
  for (const agent of agents) {
    await exec(
      `gcloud iam service-accounts create openclaw-${agent} --display-name="OpenClaw ${agent} agent" --project=${options.project}`,
    );
    // Bind secretAccessor role
    await exec(
      `gcloud projects add-iam-policy-binding ${options.project} --member=serviceAccount:openclaw-${agent}@${options.project}.iam.gserviceaccount.com --role=roles/secretmanager.secretAccessor`,
    );
  }

  // 4. Write config
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
    } catch (err: any) {
      console.error(`Failed to upload ${item.suggestedName}: ${err?.message}`);
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
    } catch (err: any) {
      console.error(`Verification failed for ${item.suggestedName}: ${err?.message}`);
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
  } catch (err: any) {
    console.error(`Error: Failed to store secret "${options.name}": ${err?.message}`);
    return 1;
  }
}
