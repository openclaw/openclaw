import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
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

/**
 * Directory containing the checked-in {@link COPILOT_SDK_SPEC} install graph
 * (`package.json` + `package-lock.json`). Both files are generated via
 * `npm install --package-lock-only` and committed under
 * `src/commands/copilot-sdk-install-manifest/`. The build step in
 * `scripts/copy-copilot-sdk-manifest.ts` copies them alongside the
 * compiled output so `import.meta.url`-based resolution works in
 * published tarballs.
 *
 * Using `npm ci` against this graph means user installs cannot pull a
 * newer Copilot CLI or transitive dependency set than the one this PR
 * was reviewed against (review #2, P1).
 */
export const COPILOT_SDK_INSTALL_MANIFEST_DIR = fileURLToPath(
  new URL("./copilot-sdk-install-manifest/", import.meta.url),
);

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
  readonly manifestDir?: string;
  readonly logger?: (message: string) => void;
  readonly runInstall?: (cmd: { dir: string; spec: string; manifestDir: string }) => Promise<void>;
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
  const manifestDir = options.manifestDir ?? COPILOT_SDK_INSTALL_MANIFEST_DIR;
  // Stage the pinned package.json + package-lock.json into the fallback dir
  // so the subsequent `npm ci` resolves the same dependency graph that this
  // PR was reviewed against. We intentionally overwrite any prior copies so a
  // bumped manifest in a later openclaw release re-pins user installs cleanly.
  for (const file of ["package.json", "package-lock.json"]) {
    const source = path.join(manifestDir, file);
    if (!existsSync(source)) {
      throw new Error(
        `[copilot] missing Copilot SDK install manifest at ${source}; expected the openclaw build to copy src/commands/copilot-sdk-install-manifest/`,
      );
    }
    copyFileSync(source, path.join(fallbackDir, file));
  }

  const runInstall = options.runInstall ?? defaultRunInstall;
  logger(`[copilot] installing ${spec} into ${fallbackDir} (npm ci against pinned manifest) ...`);
  await runInstall({ dir: fallbackDir, spec, manifestDir });
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

async function defaultRunInstall(cmd: {
  dir: string;
  spec: string;
  manifestDir: string;
}): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    // `npm ci` requires the lockfile we just staged into cmd.dir and refuses
    // to resolve anything outside it; this is what gives us a deterministic
    // graph across user machines. We deliberately keep install scripts
    // enabled because the @github/copilot CLI has a postinstall that pulls
    // the platform-specific binary, which is the whole reason we run npm
    // here instead of a single tarball fetch.
    const child = spawn("npm", ["ci", "--no-audit", "--no-fund", "--loglevel=error"], {
      cwd: cmd.dir,
      stdio: ["ignore", "inherit", "inherit"],
      shell: process.platform === "win32",
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`[copilot] npm ci ${cmd.spec} exited with code ${code ?? "null"}`));
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
      "Skipped. The Copilot agent runtime will fail at first invocation with an install message. Re-run setup to retry; the pinned dependency graph ships with openclaw under src/commands/copilot-sdk-install-manifest/.",
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
      `Install failed: ${message}\n\nRe-run setup to retry the install (the pinned dependency graph ships with openclaw under src/commands/copilot-sdk-install-manifest/).`,
      COPILOT_SDK_PACKAGE_LABEL,
    );
    return { cfg: params.cfg, required: true, installed: false, status: "failed" };
  }
}
