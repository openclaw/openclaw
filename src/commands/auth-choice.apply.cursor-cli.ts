import { spawn } from "node:child_process";
import { readCursorCliCredentials } from "../agents/cli-credentials.js";
import type { ApplyAuthChoiceParams, ApplyAuthChoiceResult } from "./auth-choice.apply.js";

const CURSOR_CLI_MODEL_REF = "cursor-cli/auto";

async function checkCursorCliInstalled(): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn("cursor", ["--version"], {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5000,
    });
    proc.on("error", () => resolve(false));
    proc.on("close", (code) => resolve(code === 0));
  });
}

async function runCursorAgentLogin(params: ApplyAuthChoiceParams): Promise<boolean> {
  await params.prompter.note(
    [
      "Cursor CLI requires OAuth authentication.",
      "",
      "Run the following command in your terminal:",
      "",
      "  cursor agent login",
      "",
      "Then return here and press Enter to continue.",
    ].join("\n"),
    "Cursor CLI Auth",
  );

  const confirmed = await params.prompter.confirm({
    message: "Have you completed `cursor agent login`?",
    initialValue: true,
  });

  return confirmed;
}

export async function applyAuthChoiceCursorCli(
  params: ApplyAuthChoiceParams,
): Promise<ApplyAuthChoiceResult | null> {
  if (params.authChoice !== "cursor-cli") {
    return null;
  }

  // Check if cursor CLI is installed
  const installed = await checkCursorCliInstalled();
  if (!installed) {
    await params.prompter.note(
      [
        "Cursor CLI not found on PATH.",
        "",
        "Install Cursor from https://cursor.sh and ensure the CLI is available.",
        "You may need to run 'Install cursor command' from the Command Palette.",
      ].join("\n"),
      "Cursor CLI Not Found",
    );
    return { config: params.config };
  }

  // Check if already authenticated
  const creds = readCursorCliCredentials();
  if (!creds) {
    // Prompt user to run cursor agent login
    const completed = await runCursorAgentLogin(params);
    if (!completed) {
      await params.prompter.note(
        "Skipping Cursor CLI auth. You can run `cursor agent login` later.",
        "Cursor CLI",
      );
      return { config: params.config };
    }

    // Verify credentials after login
    const credsAfterLogin = readCursorCliCredentials();
    if (!credsAfterLogin) {
      await params.prompter.note(
        [
          "Could not detect Cursor CLI credentials in keychain.",
          "Make sure `cursor agent login` completed successfully.",
          "You can try again later.",
        ].join("\n"),
        "Cursor CLI Auth",
      );
      return { config: params.config };
    }
  }

  await params.prompter.note(
    [
      "Cursor CLI authenticated via keychain.",
      "",
      `Default model will be set to: ${CURSOR_CLI_MODEL_REF}`,
    ].join("\n"),
    "Cursor CLI Ready",
  );

  // Set cursor-cli as the default model
  const nextConfig = params.setDefaultModel
    ? {
        ...params.config,
        agents: {
          ...params.config.agents,
          defaults: {
            ...params.config.agents?.defaults,
            model: {
              ...params.config.agents?.defaults?.model,
              primary: CURSOR_CLI_MODEL_REF,
            },
          },
        },
      }
    : params.config;

  return {
    config: nextConfig,
    agentModelOverride: params.setDefaultModel ? undefined : CURSOR_CLI_MODEL_REF,
  };
}
