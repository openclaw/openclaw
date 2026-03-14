import { formatCliCommand } from "../cli/command-format.js";
import type {
  GatewayAuthChoice,
  OnboardMode,
  OnboardOptions,
  ResetScope,
} from "../commands/onboard-types.js";
import type { OpenClawConfig } from "../config/config.js";
import {
  DEFAULT_GATEWAY_PORT,
  readConfigFileSnapshot,
  resolveGatewayPort,
  writeConfigFile,
} from "../config/config.js";
import { normalizeSecretInputString } from "../config/types.secrets.js";
import { cliT, parseCliLocale, resolveCliLocale } from "../i18n/cli.js";
import type { RuntimeEnv } from "../runtime.js";
import { defaultRuntime } from "../runtime.js";
import { resolveUserPath } from "../utils.js";
import { resolveOnboardingSecretInputString } from "./onboarding.secret-input.js";
import type { QuickstartGatewayDefaults, WizardFlow } from "./onboarding.types.js";
import { WizardCancelledError, type WizardPrompter } from "./prompts.js";

async function promptCliLocaleSelection(params: {
  prompter: WizardPrompter;
  baseConfig: OpenClawConfig;
}): Promise<"en" | "zh-CN" | undefined> {
  const explicit = parseCliLocale(process.env.OPENCLAW_LOCALE);
  if (explicit) {
    process.env.OPENCLAW_LOCALE = explicit;
    return undefined;
  }

  const configured = parseCliLocale(params.baseConfig.cli?.locale);
  if (configured) {
    process.env.OPENCLAW_LOCALE = configured;
    return configured;
  }

  const langDetected = resolveCliLocale({ LANG: process.env.LANG });
  if (langDetected === "zh-CN") {
    process.env.OPENCLAW_LOCALE = langDetected;
    return langDetected;
  }

  const localeRaw = await params.prompter.select({
    message: cliT("wizard.languageQuestion", process.env),
    options: [
      {
        value: "en",
        label: cliT("wizard.languageOptionEnglish", process.env),
        hint: cliT("wizard.languageOptionEnglishHint", process.env),
      },
      {
        value: "zh-CN",
        label: cliT("wizard.languageOptionZhCn", process.env),
        hint: cliT("wizard.languageOptionZhCnHint", process.env),
      },
    ],
    initialValue: langDetected,
  });
  const locale = parseCliLocale(String(localeRaw)) ?? "en";
  process.env.OPENCLAW_LOCALE = locale;
  return locale;
}

async function requireRiskAcknowledgement(params: {
  opts: OnboardOptions;
  prompter: WizardPrompter;
}) {
  if (params.opts.acceptRisk === true) {
    return;
  }

  await params.prompter.note(
    cliT("wizard.securityWarningBody", process.env, {
      auditDeepCommand: formatCliCommand("openclaw security audit --deep"),
      auditFixCommand: formatCliCommand("openclaw security audit --fix"),
    }),
    cliT("wizard.securityTitle", process.env),
  );

  const ok = await params.prompter.confirm({
    message: cliT("wizard.securityConfirm", process.env),
    initialValue: false,
  });
  if (!ok) {
    throw new WizardCancelledError("risk not accepted");
  }
}

export async function runOnboardingWizard(
  opts: OnboardOptions,
  runtime: RuntimeEnv = defaultRuntime,
  prompter: WizardPrompter,
) {
  const onboardHelpers = await import("../commands/onboard-helpers.js");
  const snapshot = await readConfigFileSnapshot();
  let baseConfig: OpenClawConfig = snapshot.valid ? (snapshot.exists ? snapshot.config : {}) : {};

  if (snapshot.exists && !snapshot.valid) {
    await prompter.note(
      onboardHelpers.summarizeExistingConfig(baseConfig),
      cliT("wizard.invalidConfigTitle", process.env),
    );
    if (snapshot.issues.length > 0) {
      await prompter.note(
        [
          ...snapshot.issues.map((iss) => `- ${iss.path}: ${iss.message}`),
          "",
          cliT("wizard.docsConfigLine", process.env),
        ].join("\n"),
        cliT("wizard.configIssuesTitle", process.env),
      );
    }
    await prompter.outro(
      cliT("wizard.configInvalidOutro", process.env, {
        doctorCommand: formatCliCommand("openclaw doctor"),
      }),
    );
    runtime.exit(1);
    return;
  }

  const selectedLocale = await promptCliLocaleSelection({ prompter, baseConfig });
  const applySelectedLocale = (config: OpenClawConfig): OpenClawConfig => {
    if (!selectedLocale) {
      return config;
    }
    return {
      ...config,
      cli: {
        ...config.cli,
        locale: selectedLocale,
      },
    };
  };
  baseConfig = applySelectedLocale(baseConfig);

  const t = (key: Parameters<typeof cliT>[0], vars?: Record<string, string | number>) =>
    cliT(key, process.env, vars);
  onboardHelpers.printWizardHeader(runtime);
  await prompter.intro(t("wizard.onboardingTitle"));
  await requireRiskAcknowledgement({ opts, prompter });

  const quickstartHint = cliT("wizard.modeQuickstartHint", process.env, {
    configureCommand: formatCliCommand("openclaw configure"),
  });
  const manualHint = t("wizard.modeManualHint");
  const explicitFlowRaw = opts.flow?.trim();
  const normalizedExplicitFlow = explicitFlowRaw === "manual" ? "advanced" : explicitFlowRaw;
  if (
    normalizedExplicitFlow &&
    normalizedExplicitFlow !== "quickstart" &&
    normalizedExplicitFlow !== "advanced"
  ) {
    runtime.error(t("wizard.errorInvalidFlow"));
    runtime.exit(1);
    return;
  }
  const explicitFlow: WizardFlow | undefined =
    normalizedExplicitFlow === "quickstart" || normalizedExplicitFlow === "advanced"
      ? normalizedExplicitFlow
      : undefined;
  let flow: WizardFlow =
    explicitFlow ??
    (await prompter.select({
      message: t("wizard.modeQuestion"),
      options: [
        { value: "quickstart", label: t("wizard.modeQuickstart"), hint: quickstartHint },
        { value: "advanced", label: t("wizard.modeManual"), hint: manualHint },
      ],
      initialValue: "quickstart",
    }));

  if (opts.mode === "remote" && flow === "quickstart") {
    await prompter.note(t("wizard.quickstartSwitchToManual"), t("wizard.quickstartTitle"));
    flow = "advanced";
  }

  if (snapshot.exists) {
    await prompter.note(
      onboardHelpers.summarizeExistingConfig(baseConfig),
      t("wizard.existingConfigDetectedTitle"),
    );

    const action = await prompter.select({
      message: t("wizard.configHandlingQuestion"),
      options: [
        { value: "keep", label: t("wizard.configHandlingUseExisting") },
        { value: "modify", label: t("wizard.configHandlingUpdate") },
        { value: "reset", label: t("wizard.configHandlingReset") },
      ],
    });

    if (action === "reset") {
      const workspaceDefault =
        baseConfig.agents?.defaults?.workspace ?? onboardHelpers.DEFAULT_WORKSPACE;
      const resetScope = (await prompter.select({
        message: t("wizard.resetScopeQuestion"),
        options: [
          { value: "config", label: t("wizard.resetScopeConfigOnly") },
          {
            value: "config+creds+sessions",
            label: t("wizard.resetScopeConfigCredsSessions"),
          },
          {
            value: "full",
            label: t("wizard.resetScopeFull"),
          },
        ],
      })) as ResetScope;
      await onboardHelpers.handleReset(resetScope, resolveUserPath(workspaceDefault), runtime);
      baseConfig = applySelectedLocale({});
    }
  }

  const quickstartGateway: QuickstartGatewayDefaults = (() => {
    const hasExisting =
      typeof baseConfig.gateway?.port === "number" ||
      baseConfig.gateway?.bind !== undefined ||
      baseConfig.gateway?.auth?.mode !== undefined ||
      baseConfig.gateway?.auth?.token !== undefined ||
      baseConfig.gateway?.auth?.password !== undefined ||
      baseConfig.gateway?.customBindHost !== undefined ||
      baseConfig.gateway?.tailscale?.mode !== undefined;

    const bindRaw = baseConfig.gateway?.bind;
    const bind =
      bindRaw === "loopback" ||
      bindRaw === "lan" ||
      bindRaw === "auto" ||
      bindRaw === "custom" ||
      bindRaw === "tailnet"
        ? bindRaw
        : "loopback";

    let authMode: GatewayAuthChoice = "token";
    if (
      baseConfig.gateway?.auth?.mode === "token" ||
      baseConfig.gateway?.auth?.mode === "password"
    ) {
      authMode = baseConfig.gateway.auth.mode;
    } else if (baseConfig.gateway?.auth?.token) {
      authMode = "token";
    } else if (baseConfig.gateway?.auth?.password) {
      authMode = "password";
    }

    const tailscaleRaw = baseConfig.gateway?.tailscale?.mode;
    const tailscaleMode =
      tailscaleRaw === "off" || tailscaleRaw === "serve" || tailscaleRaw === "funnel"
        ? tailscaleRaw
        : "off";

    return {
      hasExisting,
      port: resolveGatewayPort(baseConfig),
      bind,
      authMode,
      tailscaleMode,
      token: baseConfig.gateway?.auth?.token,
      password: baseConfig.gateway?.auth?.password,
      customBindHost: baseConfig.gateway?.customBindHost,
      tailscaleResetOnExit: baseConfig.gateway?.tailscale?.resetOnExit ?? false,
    };
  })();

  if (flow === "quickstart") {
    const formatBind = (value: "loopback" | "lan" | "auto" | "custom" | "tailnet") => {
      if (value === "loopback") {
        return t("wizard.quickstartBindLoopback");
      }
      if (value === "lan") {
        return t("wizard.quickstartBindLan");
      }
      if (value === "custom") {
        return t("wizard.quickstartBindCustom");
      }
      if (value === "tailnet") {
        return t("wizard.quickstartBindTailnet");
      }
      return t("wizard.quickstartBindAuto");
    };
    const formatAuth = (value: GatewayAuthChoice) => {
      if (value === "token") {
        return t("wizard.quickstartAuthTokenDefault");
      }
      return t("wizard.quickstartAuthPassword");
    };
    const formatTailscale = (value: "off" | "serve" | "funnel") => {
      if (value === "off") {
        return t("wizard.quickstartTailscaleOff");
      }
      if (value === "serve") {
        return t("wizard.quickstartTailscaleServe");
      }
      return t("wizard.quickstartTailscaleFunnel");
    };
    const quickstartLines = quickstartGateway.hasExisting
      ? [
          t("wizard.quickstartSummaryKeepExisting"),
          t("wizard.quickstartGatewayPortLine", { port: quickstartGateway.port }),
          t("wizard.quickstartGatewayBindLine", { bind: formatBind(quickstartGateway.bind) }),
          ...(quickstartGateway.bind === "custom" && quickstartGateway.customBindHost
            ? [
                t("wizard.quickstartGatewayCustomIpLine", {
                  host: quickstartGateway.customBindHost,
                }),
              ]
            : []),
          t("wizard.quickstartGatewayAuthLine", {
            auth: formatAuth(quickstartGateway.authMode),
          }),
          t("wizard.quickstartTailscaleExposureLine", {
            tailscale: formatTailscale(quickstartGateway.tailscaleMode),
          }),
          t("wizard.quickstartDirectChatLine"),
        ]
      : [
          t("wizard.quickstartGatewayPortLine", { port: DEFAULT_GATEWAY_PORT }),
          t("wizard.quickstartDefaultGatewayBindLine"),
          t("wizard.quickstartDefaultGatewayAuthLine"),
          t("wizard.quickstartDefaultTailscaleLine"),
          t("wizard.quickstartDirectChatLine"),
        ];
    await prompter.note(quickstartLines.join("\n"), t("wizard.quickstartTitle"));
  }

  const localPort = resolveGatewayPort(baseConfig);
  const localUrl = `ws://127.0.0.1:${localPort}`;
  let localGatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN ?? process.env.CLAWDBOT_GATEWAY_TOKEN;
  try {
    const resolvedGatewayToken = await resolveOnboardingSecretInputString({
      config: baseConfig,
      value: baseConfig.gateway?.auth?.token,
      path: "gateway.auth.token",
      env: process.env,
    });
    if (resolvedGatewayToken) {
      localGatewayToken = resolvedGatewayToken;
    }
  } catch (error) {
    await prompter.note(
      [
        "Could not resolve gateway.auth.token SecretRef for onboarding probe.",
        error instanceof Error ? error.message : String(error),
      ].join("\n"),
      "Gateway auth",
    );
  }
  let localGatewayPassword =
    process.env.OPENCLAW_GATEWAY_PASSWORD ?? process.env.CLAWDBOT_GATEWAY_PASSWORD;
  try {
    const resolvedGatewayPassword = await resolveOnboardingSecretInputString({
      config: baseConfig,
      value: baseConfig.gateway?.auth?.password,
      path: "gateway.auth.password",
      env: process.env,
    });
    if (resolvedGatewayPassword) {
      localGatewayPassword = resolvedGatewayPassword;
    }
  } catch (error) {
    await prompter.note(
      [
        t("wizard.gatewayAuthResolveProbeError"),
        error instanceof Error ? error.message : String(error),
      ].join("\n"),
      t("wizard.gatewayAuthTitle"),
    );
  }

  const localProbe = await onboardHelpers.probeGatewayReachable({
    url: localUrl,
    token: localGatewayToken,
    password: localGatewayPassword,
  });
  const remoteUrl = baseConfig.gateway?.remote?.url?.trim() ?? "";
  let remoteGatewayToken = normalizeSecretInputString(baseConfig.gateway?.remote?.token);
  try {
    const resolvedRemoteGatewayToken = await resolveOnboardingSecretInputString({
      config: baseConfig,
      value: baseConfig.gateway?.remote?.token,
      path: "gateway.remote.token",
      env: process.env,
    });
    if (resolvedRemoteGatewayToken) {
      remoteGatewayToken = resolvedRemoteGatewayToken;
    }
  } catch (error) {
    await prompter.note(
      [
        "Could not resolve gateway.remote.token SecretRef for onboarding probe.",
        error instanceof Error ? error.message : String(error),
      ].join("\n"),
      "Gateway auth",
    );
  }
  const remoteProbe = remoteUrl
    ? await onboardHelpers.probeGatewayReachable({
        url: remoteUrl,
        token: remoteGatewayToken,
      })
    : null;

  const mode =
    opts.mode ??
    (flow === "quickstart"
      ? "local"
      : ((await prompter.select({
          message: t("wizard.setupTargetQuestion"),
          options: [
            {
              value: "local",
              label: t("wizard.setupTargetLocal"),
              hint: localProbe.ok
                ? cliT("wizard.setupTargetLocalReachableHint", process.env, { url: localUrl })
                : cliT("wizard.setupTargetLocalUnreachableHint", process.env, { url: localUrl }),
            },
            {
              value: "remote",
              label: t("wizard.setupTargetRemote"),
              hint: !remoteUrl
                ? t("wizard.setupTargetRemoteNoConfigHint")
                : remoteProbe?.ok
                  ? cliT("wizard.setupTargetRemoteReachableHint", process.env, { url: remoteUrl })
                  : cliT("wizard.setupTargetRemoteUnreachableHint", process.env, {
                      url: remoteUrl,
                    }),
            },
          ],
        })) as OnboardMode));

  if (mode === "remote") {
    const { promptRemoteGatewayConfig } = await import("../commands/onboard-remote.js");
    const { logConfigUpdated } = await import("../config/logging.js");
    let nextConfig = await promptRemoteGatewayConfig(baseConfig, prompter, {
      secretInputMode: opts.secretInputMode,
    });
    nextConfig = applySelectedLocale(nextConfig);
    nextConfig = onboardHelpers.applyWizardMetadata(nextConfig, { command: "onboard", mode });
    await writeConfigFile(nextConfig);
    logConfigUpdated(runtime);
    await prompter.outro(t("wizard.remoteConfigured"));
    return;
  }

  const workspaceInput =
    opts.workspace ??
    (flow === "quickstart"
      ? (baseConfig.agents?.defaults?.workspace ?? onboardHelpers.DEFAULT_WORKSPACE)
      : await prompter.text({
          message: t("wizard.workspaceDirectoryQuestion"),
          initialValue: baseConfig.agents?.defaults?.workspace ?? onboardHelpers.DEFAULT_WORKSPACE,
        }));

  const workspaceDir = resolveUserPath(workspaceInput.trim() || onboardHelpers.DEFAULT_WORKSPACE);

  const { applyOnboardingLocalWorkspaceConfig } = await import("../commands/onboard-config.js");
  let nextConfig: OpenClawConfig = applySelectedLocale(
    applyOnboardingLocalWorkspaceConfig(baseConfig, workspaceDir),
  );

  const { ensureAuthProfileStore } = await import("../agents/auth-profiles.runtime.js");
  const { promptAuthChoiceGrouped } = await import("../commands/auth-choice-prompt.js");
  const { promptCustomApiConfig } = await import("../commands/onboard-custom.js");
  const { applyAuthChoice, resolvePreferredProviderForAuthChoice, warnIfModelConfigLooksOff } =
    await import("../commands/auth-choice.js");
  const { applyPrimaryModel, promptDefaultModel } = await import("../commands/model-picker.js");

  const authStore = ensureAuthProfileStore(undefined, {
    allowKeychainPrompt: false,
  });
  const authChoiceFromPrompt = opts.authChoice === undefined;
  const authChoice =
    opts.authChoice ??
    (await promptAuthChoiceGrouped({
      prompter,
      store: authStore,
      includeSkip: true,
      config: nextConfig,
      workspaceDir,
    }));

  if (authChoice === "custom-api-key") {
    const customResult = await promptCustomApiConfig({
      prompter,
      runtime,
      config: nextConfig,
      secretInputMode: opts.secretInputMode,
    });
    nextConfig = customResult.config;
  } else {
    const authResult = await applyAuthChoice({
      authChoice,
      config: nextConfig,
      prompter,
      runtime,
      setDefaultModel: true,
      opts: {
        tokenProvider: opts.tokenProvider,
        token: opts.authChoice === "apiKey" && opts.token ? opts.token : undefined,
      },
    });
    nextConfig = authResult.config;

    if (authResult.agentModelOverride) {
      nextConfig = applyPrimaryModel(nextConfig, authResult.agentModelOverride);
    }
  }

  if (authChoiceFromPrompt && authChoice !== "custom-api-key") {
    const modelSelection = await promptDefaultModel({
      config: nextConfig,
      prompter,
      allowKeep: true,
      ignoreAllowlist: true,
      includeProviderPluginSetups: true,
      preferredProvider: resolvePreferredProviderForAuthChoice({
        choice: authChoice,
        config: nextConfig,
        workspaceDir,
      }),
      workspaceDir,
      runtime,
    });
    if (modelSelection.config) {
      nextConfig = modelSelection.config;
    }
    if (modelSelection.model) {
      nextConfig = applyPrimaryModel(nextConfig, modelSelection.model);
    }
  }

  await warnIfModelConfigLooksOff(nextConfig, prompter);

  const { configureGatewayForOnboarding } = await import("./onboarding.gateway-config.js");
  const gateway = await configureGatewayForOnboarding({
    flow,
    baseConfig,
    nextConfig,
    localPort,
    quickstartGateway,
    secretInputMode: opts.secretInputMode,
    prompter,
    runtime,
  });
  nextConfig = gateway.nextConfig;
  const settings = gateway.settings;

  if (opts.skipChannels ?? opts.skipProviders) {
    await prompter.note(t("wizard.skipChannelsNote"), t("wizard.channelsTitle"));
  } else {
    const { listChannelPlugins } = await import("../channels/plugins/index.js");
    const { setupChannels } = await import("../commands/onboard-channels.js");
    const quickstartAllowFromChannels =
      flow === "quickstart"
        ? listChannelPlugins()
            .filter((plugin) => plugin.meta.quickstartAllowFrom)
            .map((plugin) => plugin.id)
        : [];
    nextConfig = await setupChannels(nextConfig, runtime, prompter, {
      allowSignalInstall: true,
      forceAllowFromChannels: quickstartAllowFromChannels,
      skipDmPolicyPrompt: flow === "quickstart",
      skipConfirm: flow === "quickstart",
      quickstartDefaults: flow === "quickstart",
      secretInputMode: opts.secretInputMode,
    });
  }

  nextConfig = applySelectedLocale(nextConfig);
  await writeConfigFile(nextConfig);
  const { logConfigUpdated } = await import("../config/logging.js");
  logConfigUpdated(runtime);
  await onboardHelpers.ensureWorkspaceAndSessions(workspaceDir, runtime, {
    skipBootstrap: Boolean(nextConfig.agents?.defaults?.skipBootstrap),
  });

  if (opts.skipSearch) {
    await prompter.note("Skipping search setup.", "Search");
  } else {
    const { setupSearch } = await import("../commands/onboard-search.js");
    nextConfig = await setupSearch(nextConfig, runtime, prompter, {
      quickstartDefaults: flow === "quickstart",
      secretInputMode: opts.secretInputMode,
    });
  }

  if (opts.skipSkills) {
    await prompter.note(t("wizard.skipSkillsNote"), t("wizard.skillsTitle"));
  } else {
    const { setupSkills } = await import("../commands/onboard-skills.js");
    nextConfig = await setupSkills(nextConfig, workspaceDir, runtime, prompter);
  }

  // Setup hooks (session memory on /new)
  const { setupInternalHooks } = await import("../commands/onboard-hooks.js");
  nextConfig = await setupInternalHooks(nextConfig, runtime, prompter);

  nextConfig = applySelectedLocale(nextConfig);
  nextConfig = onboardHelpers.applyWizardMetadata(nextConfig, { command: "onboard", mode });
  await writeConfigFile(nextConfig);

  const { finalizeOnboardingWizard } = await import("./onboarding.finalize.js");
  const { launchedTui } = await finalizeOnboardingWizard({
    flow,
    opts,
    baseConfig,
    nextConfig,
    workspaceDir,
    settings,
    prompter,
    runtime,
  });
  if (launchedTui) {
    return;
  }
}
