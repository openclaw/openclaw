import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { modelSelectionShouldEnsureCopilotSdk as routingShouldEnsure } from "../agents/copilot-routing.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "../wizard/prompts.js";

/**
 * On-demand install for `@github/copilot-sdk`, the runtime dependency of
 * the bundled `copilot` agent runtime extension.
 *
 * The extension itself is shipped inside the openclaw tarball, but the
 * SDK and its platform-specific CLI binary add ~260 MB of download to a
 * baseline openclaw install. Most openclaw users do not use the Copilot
 * runtime, so we install the SDK lazily: the wizard offers to install
 * it the first time the user selects a `github-copilot/*` model.
 *
 * Mirrors the codex on-demand install pattern in
 * `./codex-runtime-plugin-install.ts`, but installs a single npm
 * package (the SDK) rather than a full openclaw plugin, so the install
 * machinery here is much smaller than `ensureCodexRuntimePluginForModelSelection`.
 *
 * The constants `COPILOT_SDK_FALLBACK_DIR` and `COPILOT_SDK_SPEC` are
 * mirrored in the copilot extension's sdk-loader module; a contract test
 * in that file asserts equality so the two never drift.
 */
export const COPILOT_SDK_FALLBACK_DIR = path.join(homedir(), ".openclaw", "npm-runtime", "copilot");

export const COPILOT_SDK_SPEC = "@github/copilot-sdk@1.0.0-beta.4";

export const COPILOT_SDK_PACKAGE_LABEL = "GitHub Copilot SDK (@github/copilot-sdk)";

export type CopilotSdkInstallStatus = "already-installed" | "installed" | "declined" | "failed";

export type CopilotSdkInstallResult = {
  cfg: OpenClawConfig;
  required: boolean;
  installed: boolean;
  status?: CopilotSdkInstallStatus;
};

export function selectedModelShouldEnsureCopilotSdk(params: {
  cfg: OpenClawConfig;
  model?: string;
}): boolean {
  return routingShouldEnsure({ config: params.cfg, model: params.model });
}

export function isCopilotSdkInstalled(fallbackDir: string = COPILOT_SDK_FALLBACK_DIR): boolean {
  const sdkPath = path.join(fallbackDir, "node_modules", "@github", "copilot-sdk");
  return existsSync(sdkPath);
}

export interface InstallCopilotSdkOptions {
  readonly fallbackDir?: string;
  readonly spec?: string;
  readonly logger?: (message: string) => void;
  readonly runInstall?: (cmd: { dir: string; spec: string }) => Promise<void>;
}

export interface InstallCopilotSdkResult {
  readonly installed: boolean;
  readonly fallbackDir: string;
  readonly spec: string;
}

export async function installCopilotSdk(
  options: InstallCopilotSdkOptions = {},
): Promise<InstallCopilotSdkResult> {
  const fallbackDir = options.fallbackDir ?? COPILOT_SDK_FALLBACK_DIR;
  const spec = options.spec ?? COPILOT_SDK_SPEC;
  const logger = options.logger ?? (() => undefined);

  if (isCopilotSdkInstalled(fallbackDir)) {
    logger(`[copilot] @github/copilot-sdk already installed at ${fallbackDir}`);
    return { installed: false, fallbackDir, spec };
  }

  mkdirSync(fallbackDir, { recursive: true });
  const pkgPath = path.join(fallbackDir, "package.json");
  if (!existsSync(pkgPath)) {
    writeFileSync(
      pkgPath,
      JSON.stringify(
        { name: "openclaw-copilot-runtime", version: "0.0.0", private: true },
        null,
        2,
      ) + "\n",
    );
  }

  const runInstall = options.runInstall ?? defaultRunInstall;
  logger(`[copilot] installing ${spec} into ${fallbackDir} ...`);
  await runInstall({ dir: fallbackDir, spec });
  if (!isCopilotSdkInstalled(fallbackDir)) {
    throw new Error(
      `[copilot] install of ${spec} appeared to succeed but ${path.join(
        fallbackDir,
        "node_modules",
        "@github",
        "copilot-sdk",
      )} is missing`,
    );
  }
  logger(`[copilot] installed ${spec}`);
  return { installed: true, fallbackDir, spec };
}

async function defaultRunInstall(cmd: { dir: string; spec: string }): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      "npm",
      ["install", cmd.spec, "--prefix", cmd.dir, "--no-audit", "--no-fund", "--loglevel=error"],
      {
        stdio: ["ignore", "inherit", "inherit"],
        shell: process.platform === "win32",
      },
    );
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`[copilot] npm install ${cmd.spec} exited with code ${code ?? "null"}`));
    });
  });
}

/**
 * Wizard hook called from `src/plugins/provider-auth-choice.ts` after
 * the user selects a model. If the selected model needs the Copilot
 * SDK and it is not installed, prompts the user to install it now.
 *
 * Returns `{ required: false }` and a no-op if the selection does not
 * need the SDK; this is the hot path for most model selections.
 */
export async function ensureCopilotSdkForModelSelection(params: {
  cfg: OpenClawConfig;
  model?: string;
  prompter: WizardPrompter;
  runtime: RuntimeEnv;
  isInstalled?: () => boolean;
  install?: (options: InstallCopilotSdkOptions) => Promise<InstallCopilotSdkResult>;
}): Promise<CopilotSdkInstallResult> {
  if (!selectedModelShouldEnsureCopilotSdk({ cfg: params.cfg, model: params.model })) {
    return { cfg: params.cfg, required: false, installed: false };
  }

  const isInstalled = params.isInstalled ?? (() => isCopilotSdkInstalled());
  if (isInstalled()) {
    return {
      cfg: params.cfg,
      required: true,
      installed: false,
      status: "already-installed",
    };
  }

  const proceed = await params.prompter.confirm({
    message:
      "The Copilot agent runtime needs @github/copilot-sdk (~260 MB on first install, downloads the @github/copilot CLI binary for your platform). Install now?",
    initialValue: true,
  });

  if (!proceed) {
    await params.prompter.note(
      "Skipped. The Copilot agent runtime will fail at first invocation with an install message. Re-run setup or install manually with `npm install @github/copilot-sdk@1.0.0-beta.4 --prefix ~/.openclaw/npm-runtime/copilot`.",
      COPILOT_SDK_PACKAGE_LABEL,
    );
    return { cfg: params.cfg, required: true, installed: false, status: "declined" };
  }

  const progress = params.prompter.progress(`Installing ${COPILOT_SDK_PACKAGE_LABEL}`);
  try {
    const installer = params.install ?? installCopilotSdk;
    const result = await installer({
      logger: (message) => {
        progress.update(message);
        params.runtime.log(message);
      },
    });
    progress.stop(result.installed ? "Installed." : "Already installed.");
    return {
      cfg: params.cfg,
      required: true,
      installed: result.installed,
      status: "installed",
    };
  } catch (err) {
    progress.stop("Install failed.");
    const message = err instanceof Error ? err.message : String(err);
    await params.prompter.note(
      `Install failed: ${message}\n\nYou can install manually with:\n  npm install @github/copilot-sdk@1.0.0-beta.4 --prefix ~/.openclaw/npm-runtime/copilot`,
      COPILOT_SDK_PACKAGE_LABEL,
    );
    return { cfg: params.cfg, required: true, installed: false, status: "failed" };
  }
}
