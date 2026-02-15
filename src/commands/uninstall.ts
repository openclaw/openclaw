import { cancel, confirm, isCancel, multiselect } from "@clack/prompts";
import path from "node:path";
import type { RuntimeEnv } from "../runtime.js";
import {
  isNixMode,
  loadConfig,
  resolveConfigPath,
  resolveOAuthDir,
  resolveStateDir,
} from "../config/config.js";
import { resolveGatewayService } from "../daemon/service.js";
import { stylePromptHint, stylePromptMessage, stylePromptTitle } from "../terminal/prompt-style.js";
import { resolveHomeDir } from "../utils.js";
import { collectWorkspaceDirs, isPathWithin, removePath } from "./cleanup-utils.js";
import { t } from "../i18n/index.js";

type UninstallScope = "service" | "state" | "workspace" | "app";

export type UninstallOptions = {
  service?: boolean;
  state?: boolean;
  workspace?: boolean;
  app?: boolean;
  all?: boolean;
  yes?: boolean;
  nonInteractive?: boolean;
  dryRun?: boolean;
};

const multiselectStyled = <T>(params: Parameters<typeof multiselect<T>>[0]) =>
  multiselect({
    ...params,
    message: stylePromptMessage(params.message),
    options: params.options.map((opt) =>
      opt.hint === undefined ? opt : { ...opt, hint: stylePromptHint(opt.hint) },
    ),
  });

function buildScopeSelection(opts: UninstallOptions): {
  scopes: Set<UninstallScope>;
  hadExplicit: boolean;
} {
  const hadExplicit = Boolean(opts.all || opts.service || opts.state || opts.workspace || opts.app);
  const scopes = new Set<UninstallScope>();
  if (opts.all || opts.service) {
    scopes.add("service");
  }
  if (opts.all || opts.state) {
    scopes.add("state");
  }
  if (opts.all || opts.workspace) {
    scopes.add("workspace");
  }
  if (opts.all || opts.app) {
    scopes.add("app");
  }
  return { scopes, hadExplicit };
}

async function stopAndUninstallService(runtime: RuntimeEnv): Promise<boolean> {
  if (isNixMode) {
    runtime.error(t("commands.uninstall.nix_mode_disabled"));
    return false;
  }
  const service = resolveGatewayService();
  let loaded = false;
  try {
    loaded = await service.isLoaded({ env: process.env });
  } catch (err) {
    runtime.error(t("commands.uninstall.service_check_failed", { error: String(err) }));
    return false;
  }
  if (!loaded) {
    runtime.log(t("commands.uninstall.service_not_loaded", { status: service.notLoadedText }));
    return true;
  }
  try {
    await service.stop({ env: process.env, stdout: process.stdout });
  } catch (err) {
    runtime.error(t("commands.uninstall.service_stop_failed", { error: String(err) }));
  }
  try {
    await service.uninstall({ env: process.env, stdout: process.stdout });
    return true;
  } catch (err) {
    runtime.error(t("commands.uninstall.service_uninstall_failed", { error: String(err) }));
    return false;
  }
}

async function removeMacApp(runtime: RuntimeEnv, dryRun?: boolean) {
  if (process.platform !== "darwin") {
    return;
  }
  await removePath("/Applications/OpenClaw.app", runtime, {
    dryRun,
    label: "/Applications/OpenClaw.app",
  });
}

export async function uninstallCommand(runtime: RuntimeEnv, opts: UninstallOptions) {
  const { scopes, hadExplicit } = buildScopeSelection(opts);
  const interactive = !opts.nonInteractive;
  if (!interactive && !opts.yes) {
    runtime.error(t("commands.uninstall.non_interactive_needs_yes"));
    runtime.exit(1);
    return;
  }

  if (!hadExplicit) {
    if (!interactive) {
      runtime.error(t("commands.uninstall.non_interactive_needs_scopes"));
      runtime.exit(1);
      return;
    }
    const selection = await multiselectStyled<UninstallScope>({
      message: t("commands.uninstall.select_components"),
      options: [
        {
          value: "service",
          label: t("commands.uninstall.option_service"),
          hint: t("commands.uninstall.option_service_hint"),
        },
        { 
          value: "state", 
          label: t("commands.uninstall.option_state"), 
          hint: t("commands.uninstall.option_state_hint") 
        },
        { 
          value: "workspace", 
          label: t("commands.uninstall.option_workspace"), 
          hint: t("commands.uninstall.option_workspace_hint") 
        },
        {
          value: "app",
          label: t("commands.uninstall.option_app"),
          hint: t("commands.uninstall.option_app_hint"),
        },
      ],
      initialValues: ["service", "state", "workspace"],
    });
    if (isCancel(selection)) {
      cancel(stylePromptTitle(t("commands.uninstall.cancelled")) ?? t("commands.uninstall.cancelled"));
      runtime.exit(0);
      return;
    }
    for (const value of selection) {
      scopes.add(value);
    }
  }

  if (scopes.size === 0) {
    runtime.log(t("commands.uninstall.nothing_selected"));
    return;
  }

  if (interactive && !opts.yes) {
    const ok = await confirm({
      message: stylePromptMessage(t("commands.uninstall.proceed_confirm")),
    });
    if (isCancel(ok) || !ok) {
      cancel(stylePromptTitle(t("commands.uninstall.cancelled")) ?? t("commands.uninstall.cancelled"));
      runtime.exit(0);
      return;
    }
  }

  const dryRun = Boolean(opts.dryRun);
  const cfg = loadConfig();
  const stateDir = resolveStateDir();
  const configPath = resolveConfigPath();
  const oauthDir = resolveOAuthDir();
  const configInsideState = isPathWithin(configPath, stateDir);
  const oauthInsideState = isPathWithin(oauthDir, stateDir);
  const workspaceDirs = collectWorkspaceDirs(cfg);

  if (scopes.has("service")) {
    if (dryRun) {
      runtime.log(t("commands.uninstall.dry_run_service"));
    } else {
      await stopAndUninstallService(runtime);
    }
  }

  if (scopes.has("state")) {
    await removePath(stateDir, runtime, { dryRun, label: stateDir });
    if (!configInsideState) {
      await removePath(configPath, runtime, { dryRun, label: configPath });
    }
    if (!oauthInsideState) {
      await removePath(oauthDir, runtime, { dryRun, label: oauthDir });
    }
  }

  if (scopes.has("workspace")) {
    for (const workspace of workspaceDirs) {
      await removePath(workspace, runtime, { dryRun, label: workspace });
    }
  }

  if (scopes.has("app")) {
    await removeMacApp(runtime, dryRun);
  }

  runtime.log(t("commands.uninstall.cli_still_installed"));

  if (scopes.has("state") && !scopes.has("workspace")) {
    const home = resolveHomeDir();
    if (home && workspaceDirs.some((dir) => dir.startsWith(path.resolve(home)))) {
      runtime.log(t("commands.uninstall.workspaces_preserved"));
    }
  }
}
