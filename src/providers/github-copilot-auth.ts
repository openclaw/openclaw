import { CopilotClient } from "@github/copilot-sdk";
import { intro, note, outro, spinner } from "@clack/prompts";

import { ensureAuthProfileStore, upsertAuthProfile } from "../agents/auth-profiles.js";
import { updateConfig } from "../commands/models/shared.js";
import { applyAuthProfileConfig } from "../commands/onboard-auth.js";
import { logConfigUpdated } from "../config/logging.js";
import { runCommandWithTimeout } from "../process/exec.js";
import type { RuntimeEnv } from "../runtime.js";
import { stylePromptTitle } from "../terminal/prompt-style.js";

const COPILOT_LOGIN_TIMEOUT_MS = 15 * 60 * 1000;

export async function githubCopilotLoginCommand(
  opts: { profileId?: string; yes?: boolean },
  runtime: RuntimeEnv,
) {
  if (!process.stdin.isTTY) {
    throw new Error("github-copilot login requires an interactive TTY.");
  }

  intro(stylePromptTitle("GitHub Copilot login"));

  const profileId = opts.profileId?.trim() || "github-copilot:github";
  const store = ensureAuthProfileStore(undefined, {
    allowKeychainPrompt: false,
  });

  if (store.profiles[profileId] && !opts.yes) {
    note(
      `Auth profile already exists: ${profileId}\nRe-running will overwrite it.`,
      stylePromptTitle("Existing credentials"),
    );
  }

  const loginSpin = spinner();
  loginSpin.start("Starting Copilot CLI login...");
  const loginResult = await runCommandWithTimeout(["copilot", "auth", "login"], {
    timeoutMs: COPILOT_LOGIN_TIMEOUT_MS,
  });
  loginSpin.stop("Copilot CLI login complete");

  if (loginResult.code !== 0) {
    const message =
      loginResult.stderr.trim() || loginResult.stdout.trim() || "Copilot login failed";
    throw new Error(message);
  }

  const clientSpin = spinner();
  clientSpin.start("Validating Copilot SDK connection...");
  const client = new CopilotClient();
  try {
    await client.start();
    await client.ping("clawdbot");
  } finally {
    await client.stop();
  }
  clientSpin.stop("Copilot SDK ready");

  upsertAuthProfile({
    profileId,
    credential: {
      type: "token",
      provider: "github-copilot",
      token: "",
    },
  });

  await updateConfig((cfg) =>
    applyAuthProfileConfig(cfg, {
      provider: "github-copilot",
      profileId,
      mode: "token",
    }),
  );

  logConfigUpdated(runtime);
  runtime.log(`Auth profile: ${profileId} (github-copilot/cli)`);

  outro("Done");
}
