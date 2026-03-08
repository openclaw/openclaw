/**
 * Config-driven Gmail setup - enables fully automated Gmail webhook configuration
 * without requiring interactive CLI wizards.
 *
 * Supports:
 * - GCP Service Account authentication (skips `gcloud auth login`)
 * - gog OAuth token injection (skips `gog auth login`)
 * - Tailscale auth key (skips `tailscale up` interactive flow)
 * - Auto-creation of Pub/Sub topic and subscription
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "../config/config.js";
import { createSubsystemLogger } from "../logging.js";
import { runCommandWithTimeout } from "../process/exec.js";
import { resolveUserPath } from "../utils.js";
import {
  ensureSubscription,
  ensureTailscaleEndpoint,
  ensureTopic,
  runGcloud,
} from "./gmail-setup-utils.js";
import {
  buildTopicPath,
  DEFAULT_GMAIL_SUBSCRIPTION,
  DEFAULT_GMAIL_TOPIC,
  generateHookToken,
  parseTopicPath,
} from "./gmail.js";

const log = createSubsystemLogger("gmail-auto-setup");

export type GmailAutoSetupResult = {
  ok: boolean;
  error?: string;
  skipped?: boolean;
  reason?: string;
  projectId?: string;
  topic?: string;
  subscription?: string;
  pushEndpoint?: string;
};

/**
 * Check if gcloud is authenticated (either via user or service account)
 */
async function isGcloudAuthenticated(): Promise<boolean> {
  const result = await runCommandWithTimeout(
    ["gcloud", "auth", "list", "--filter", "status:ACTIVE", "--format", "value(account)"],
    { timeoutMs: 30_000 },
  );
  return result.code === 0 && result.stdout.trim().length > 0;
}

/**
 * Authenticate gcloud using a service account key
 */
async function authenticateWithServiceAccount(
  keyJsonOrPath: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  let keyPath: string;
  let tempFile = false;

  // Check if it's a file path or JSON string
  if (keyJsonOrPath.trim().startsWith("{")) {
    // It's JSON - write to temp file
    const tempDir = os.tmpdir();
    keyPath = path.join(tempDir, "gcloud-sa-key-" + crypto.randomUUID() + ".json");
    try {
      fs.writeFileSync(keyPath, keyJsonOrPath, { mode: 0o600 });
      tempFile = true;
    } catch (err) {
      return { ok: false, error: `Failed to write service account key: ${String(err)}` };
    }
  } else {
    // It's a file path
    keyPath = resolveUserPath(keyJsonOrPath);
    if (!fs.existsSync(keyPath)) {
      return { ok: false, error: `Service account key file not found: ${keyPath}` };
    }
  }

  try {
    const result = await runCommandWithTimeout(
      ["gcloud", "auth", "activate-service-account", "--key-file", keyPath],
      { timeoutMs: 60_000 },
    );

    if (result.code !== 0) {
      return { ok: false, error: `gcloud auth failed: ${result.stderr || result.stdout}` };
    }

    log.info("Authenticated gcloud with service account");
    return { ok: true };
  } finally {
    // Clean up temp file
    if (tempFile) {
      try {
        fs.unlinkSync(keyPath);
      } catch {
        // ignore cleanup errors
      }
    }
  }
}

/**
 * Set up gog credentials from config (refresh token or credentials file)
 */
async function setupGogCredentials(
  account: string,
  config: NonNullable<OpenClawConfig["hooks"]>["gmail"],
): Promise<{ ok: true } | { ok: false; error: string }> {
  const gog = config?.gog;
  if (!gog) {
    return { ok: true };
  }

  const credentialsDir = resolveUserPath("~/.config/gogcli");

  // If credentials file is provided, copy it
  if (gog.credentialsFile) {
    const srcPath = resolveUserPath(gog.credentialsFile);
    if (!fs.existsSync(srcPath)) {
      return { ok: false, error: `gog credentials file not found: ${srcPath}` };
    }
    try {
      fs.mkdirSync(credentialsDir, { recursive: true });
      const destPath = path.join(credentialsDir, "credentials.json");
      fs.copyFileSync(srcPath, destPath);
      fs.chmodSync(destPath, 0o600);
      log.info("Copied gog credentials file");
      return { ok: true };
    } catch (err) {
      return { ok: false, error: `Failed to copy gog credentials: ${String(err)}` };
    }
  }

  // If refresh token is provided, create credentials file and import token
  if (gog.refreshToken && gog.clientId && gog.clientSecret) {
    // gog expects flat {client_id, client_secret} at top level
    const credentials = {
      client_id: gog.clientId,
      client_secret: gog.clientSecret,
    };

    try {
      fs.mkdirSync(credentialsDir, { recursive: true });
      const destPath = path.join(credentialsDir, "credentials.json");
      fs.writeFileSync(destPath, JSON.stringify(credentials, null, 2), { mode: 0o600 });

      // Configure gog to use file-based keyring (no system keyring in containers)
      const configPath = path.join(credentialsDir, "config.json");
      if (!fs.existsSync(configPath)) {
        fs.writeFileSync(configPath, JSON.stringify({ keyring_backend: "file" }, null, 2), {
          mode: 0o600,
        });
      }

      // Ensure GOG_KEYRING_PASSWORD is set for file-based keyring
      if (!process.env.GOG_KEYRING_PASSWORD) {
        process.env.GOG_KEYRING_PASSWORD = "openclaw-auto";
      }

      const DEFAULT_SERVICES = ["gmail"];
      const DEFAULT_SCOPES = [
        "https://www.googleapis.com/auth/gmail.modify",
        "https://www.googleapis.com/auth/gmail.settings.basic",
        "https://www.googleapis.com/auth/userinfo.email",
      ];

      // Import refresh token into gog's keyring via CLI
      const tokenData = {
        email: account,
        refresh_token: gog.refreshToken,
        services: gog.services ?? DEFAULT_SERVICES,
        scopes: gog.scopes ?? DEFAULT_SCOPES,
      };
      const tmpTokenPath = path.join(os.tmpdir(), "gog-token-" + crypto.randomUUID() + ".json");
      fs.writeFileSync(tmpTokenPath, JSON.stringify(tokenData, null, 2), { mode: 0o600 });

      const importResult = await runCommandWithTimeout(
        ["gog", "auth", "tokens", "import", tmpTokenPath, "--no-input"],
        { timeoutMs: 30_000 },
      );

      // Clean up temp file
      try {
        fs.unlinkSync(tmpTokenPath);
      } catch {
        // ignore
      }

      if (importResult.code !== 0) {
        return {
          ok: false,
          error: `gog token import failed: ${importResult.stderr || importResult.stdout}`,
        };
      }
      log.info("Imported gog refresh token for " + account);

      return { ok: true };
    } catch (err) {
      return { ok: false, error: `Failed to create gog credentials: ${String(err)}` };
    }
  }

  return { ok: true };
}

/**
 * Set up Tailscale using auth key (automated login)
 */
async function setupTailscaleWithAuthKey(
  authKey: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  // Check if already connected
  const status = await runCommandWithTimeout(["tailscale", "status", "--json"], {
    timeoutMs: 30_000,
  });
  if (status.code === 0) {
    try {
      const parsed = JSON.parse(status.stdout) as { BackendState?: string };
      if (parsed.BackendState === "Running") {
        log.info("Tailscale already connected");
        return { ok: true };
      }
    } catch {
      // continue to auth
    }
  }

  // Authenticate with auth key
  const result = await runCommandWithTimeout(["tailscale", "up", "--authkey", authKey], {
    timeoutMs: 120_000,
  });

  if (result.code !== 0) {
    return { ok: false, error: `tailscale up failed: ${result.stderr || result.stdout}` };
  }

  log.info("Tailscale connected with auth key");
  return { ok: true };
}

/**
 * Auto-setup GCP Pub/Sub topic and subscription
 */
async function autoSetupPubSub(
  projectId: string,
  topicName: string,
  subscription: string,
  pushEndpoint: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    // Enable required APIs (best-effort — may fail if SA lacks serviceusage perms,
    // but the APIs might already be enabled so we continue regardless)
    log.info(`Enabling Gmail and Pub/Sub APIs for project ${projectId}`);
    try {
      await runGcloud([
        "services",
        "enable",
        "gmail.googleapis.com",
        "pubsub.googleapis.com",
        "--project",
        projectId,
      ]);
    } catch (err) {
      log.warn(`API enablement failed (continuing — APIs may already be enabled): ${String(err)}`);
    }

    // Create topic
    log.info(`Ensuring Pub/Sub topic: ${topicName}`);
    await ensureTopic(projectId, topicName);

    // Add IAM binding for Gmail push
    log.info("Adding IAM binding for Gmail push");
    await runGcloud([
      "pubsub",
      "topics",
      "add-iam-policy-binding",
      topicName,
      "--project",
      projectId,
      "--member",
      "serviceAccount:gmail-api-push@system.gserviceaccount.com",
      "--role",
      "roles/pubsub.publisher",
    ]);

    // Create subscription
    log.info(`Ensuring Pub/Sub subscription: ${subscription}`);
    await ensureSubscription(projectId, subscription, topicName, pushEndpoint);

    return { ok: true };
  } catch (err) {
    return { ok: false, error: `Pub/Sub setup failed: ${String(err)}` };
  }
}

/**
 * Run config-driven Gmail auto-setup on gateway startup.
 * This is called before startGmailWatcher if gcp.autoSetup is enabled.
 */
export async function runGmailAutoSetup(cfg: OpenClawConfig): Promise<GmailAutoSetupResult> {
  const gmail = cfg.hooks?.gmail;
  if (!gmail?.account) {
    return { ok: true, skipped: true, reason: "no gmail account configured" };
  }

  const gcp = gmail.gcp;
  const shouldAutoSetup = gcp?.autoSetup === true;

  // Step 1: Service account auth (if configured)
  const saKey = gcp?.serviceAccountKey || gcp?.serviceAccountKeyFile;
  if (saKey) {
    const isAuthed = await isGcloudAuthenticated();
    if (!isAuthed) {
      log.info("Authenticating gcloud with service account");
      const authResult = await authenticateWithServiceAccount(saKey);
      if (!authResult.ok) {
        return { ok: false, error: authResult.error };
      }
    }
  }

  // Step 2: Set up gog credentials (if configured)
  const gogResult = await setupGogCredentials(gmail.account, gmail);
  if (!gogResult.ok) {
    return { ok: false, error: gogResult.error };
  }

  // Step 3: Tailscale auth key (if configured)
  const tailscaleAuthKey = gmail.tailscale?.authKey;
  if (tailscaleAuthKey) {
    const tsResult = await setupTailscaleWithAuthKey(tailscaleAuthKey);
    if (!tsResult.ok) {
      log.warn(`Tailscale setup failed (non-fatal): ${tsResult.error}`);
    }
  }

  // Step 4: Auto-setup Pub/Sub (if enabled)
  if (shouldAutoSetup) {
    // Resolve project ID
    const topicInput = gmail.topic ?? DEFAULT_GMAIL_TOPIC;
    const parsedTopic = parseTopicPath(topicInput);
    const projectId = gcp?.projectId ?? parsedTopic?.projectId;

    if (!projectId) {
      return {
        ok: false,
        error: "gcp.projectId required for autoSetup (or include in topic path)",
      };
    }

    const topicName = parsedTopic?.topicName ?? topicInput;
    const subscription = gmail.subscription ?? DEFAULT_GMAIL_SUBSCRIPTION;
    const pushToken = gmail.pushToken ?? generateHookToken();

    // Resolve push endpoint: explicit config > Tailscale > fail
    let resolvedPushEndpoint: string | undefined;

    // Option 1: Explicit push endpoint in config (e.g. Fly.io public URL)
    const configEndpoint = gcp?.pushEndpoint;
    if (configEndpoint) {
      // Append push token as query param if not already present
      const sep = configEndpoint.includes("?") ? "&" : "?";
      resolvedPushEndpoint = `${configEndpoint}${sep}token=${pushToken}`;
    }

    // Option 2: Tailscale endpoint
    if (!resolvedPushEndpoint && gmail.tailscale?.mode && gmail.tailscale.mode !== "off") {
      try {
        resolvedPushEndpoint = await ensureTailscaleEndpoint({
          mode: gmail.tailscale.mode,
          path: gmail.tailscale.path ?? "/gmail-pubsub",
          port: gmail.serve?.port ?? 8788,
          target: gmail.tailscale.target,
          token: pushToken,
        });
      } catch (err) {
        log.warn(`Tailscale endpoint setup failed: ${String(err)}`);
      }
    }

    if (!resolvedPushEndpoint) {
      log.warn(
        "autoSetup: no push endpoint available (set gcp.pushEndpoint or configure tailscale)",
      );
      return {
        ok: true,
        skipped: false,
        reason: "no push endpoint configured",
        projectId,
        topic: buildTopicPath(projectId, topicName),
      };
    }

    const pubsubResult = await autoSetupPubSub(
      projectId,
      topicName,
      subscription,
      resolvedPushEndpoint,
    );
    if (!pubsubResult.ok) {
      return { ok: false, error: pubsubResult.error };
    }

    return {
      ok: true,
      projectId,
      topic: buildTopicPath(projectId, topicName),
      subscription,
      pushEndpoint: resolvedPushEndpoint,
    };
  }

  return {
    ok: true,
    skipped: !shouldAutoSetup,
    reason: shouldAutoSetup ? undefined : "autoSetup not enabled",
  };
}
