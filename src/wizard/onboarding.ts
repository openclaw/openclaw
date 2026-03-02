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
import type { RuntimeEnv } from "../runtime.js";
import { defaultRuntime } from "../runtime.js";
import { resolveUserPath } from "../utils.js";
import type { QuickstartGatewayDefaults, WizardFlow } from "./onboarding.types.js";
import { WizardCancelledError, type WizardPrompter } from "./prompts.js";

async function requireRiskAcknowledgement(params: {
  opts: OnboardOptions;
  prompter: WizardPrompter;
}) {
  if (params.opts.acceptRisk === true) {
    return;
  }

  await params.prompter.note(
    [
      "安全警告 — 请阅读。",
      "",
      "OpenClaw 仍处于测试阶段。请注意潜在的风险。",
      "默认情况下，OpenClaw 是个人代理：单一受信任的操作边界。",
      "如果启用了工具，此机器人可以在您的设备上读取文件和执行操作。",
      "恶意的提示词可能会诱使它执行不安全的操作。",
      "",
      "OpenClaw 并非预设为敌对的多租户边界。",
      "如果多个用户可以向同一个启用工具的代理发送消息，他们将共享该代理的任务权限。",
      "",
      "如果您对基本的安全机制和访问控制不熟悉，请不要运行 OpenClaw。",
      "在启用工具或将其暴露到公网之前，请寻求有经验的人士帮助。",
      "",
      "建议的安全基准：",
      "- Pairing/allowlists + 仅被 @ 时响应。",
      "- 多用户/共享收件箱：拆分信任边界（独立的网关/凭证，最好是独立的 OS 用户/主机）。",
      "- 沙盒环境 + 最低权限原则。",
      "- 共享收件箱：隔离 DM 会话 (`session.dmScope: per-channel-peer`) 保持最小化的工具访问。",
      "- 让包含机密信息的文件远离 Agent 能访问到的目录。",
      "- 任何带有工具或暴露给不受信任来源的机器人，应使用最强力的模型 (如 Qwen-Max / GPT-4 等)。",
      "",
      "请定期运行以核查安全状态：",
      "openclaw security audit --deep",
      "openclaw security audit --fix",
      "",
      "必读指南: https://docs.openclaw.ai/gateway/security",
    ].join("\n"),
    "安全警告 (Security)",
  );

  const ok = await params.prompter.confirm({
    message: "我已了解这是一款强大的工具且存在固有的安全风险。继续吗？",
    initialValue: false,
  });
  if (!ok) {
    throw new WizardCancelledError("风险确认未通过");
  }
}

export async function runOnboardingWizard(
  opts: OnboardOptions,
  runtime: RuntimeEnv = defaultRuntime,
  prompter: WizardPrompter,
) {
  const onboardHelpers = await import("../commands/onboard-helpers.js");
  onboardHelpers.printWizardHeader(runtime);
  await prompter.intro("OpenClaw 初始化配置 (Onboarding)");
  await requireRiskAcknowledgement({ opts, prompter });

  const snapshot = await readConfigFileSnapshot();
  let baseConfig: OpenClawConfig = snapshot.valid ? snapshot.config : {};

  if (snapshot.exists && !snapshot.valid) {
    await prompter.note(
      onboardHelpers.summarizeExistingConfig(baseConfig),
      "配置无效 (Invalid config)",
    );
    if (snapshot.issues.length > 0) {
      await prompter.note(
        [
          ...snapshot.issues.map((iss) => `- ${iss.path}: ${iss.message}`),
          "",
          "Docs: https://docs.openclaw.ai/gateway/configuration",
        ].join("\n"),
        "配置问题 (Config issues)",
      );
    }
    await prompter.outro(
      `配置无效。请运行 \`${formatCliCommand("openclaw doctor")}\` 修复，然后再重新运行 onboarding。`,
    );
    runtime.exit(1);
    return;
  }

  const quickstartHint = `稍后可以通过 ${formatCliCommand("openclaw configure")} 配置详情。`;
  const manualHint = "手动配置端口、网络、Tailscale 以及相关鉴权选项。";
  const explicitFlowRaw = opts.flow?.trim();
  const normalizedExplicitFlow = explicitFlowRaw === "manual" ? "advanced" : explicitFlowRaw;
  if (
    normalizedExplicitFlow &&
    normalizedExplicitFlow !== "quickstart" &&
    normalizedExplicitFlow !== "advanced"
  ) {
    runtime.error("无效的 --flow 参数 (请使用 quickstart, manual, 或 advanced)。");
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
      message: "选择配置模式 (Onboarding mode)",
      options: [
        { value: "quickstart", label: "快速启动 (QuickStart)", hint: quickstartHint },
        { value: "advanced", label: "手动设置 (Manual)", hint: manualHint },
      ],
      initialValue: "quickstart",
    }));

  if (opts.mode === "remote" && flow === "quickstart") {
    await prompter.note(
      "快速启动(QuickStart)目前仅支持本地网关。正在为您切换到手动模式(Manual)。",
      "快速启动说明",
    );
    flow = "advanced";
  }

  if (snapshot.exists) {
    await prompter.note(
      onboardHelpers.summarizeExistingConfig(baseConfig),
      "检测到已存在的配置文件",
    );

    const action = await prompter.select({
      message: "配置文件处理方式",
      options: [
        { value: "keep", label: "保留当前值 (Use existing values)" },
        { value: "modify", label: "修改配置 (Update values)" },
        { value: "reset", label: "重置 (Reset)" },
      ],
    });

    if (action === "reset") {
      const workspaceDefault =
        baseConfig.agents?.defaults?.workspace ?? onboardHelpers.DEFAULT_WORKSPACE;
      const resetScope = (await prompter.select({
        message: "选择重置范围 (Reset scope)",
        options: [
          { value: "config", label: "仅配置项 (Config only)" },
          {
            value: "config+creds+sessions",
            label: "配置项 + 凭证 + 对话会话",
          },
          {
            value: "full",
            label: "彻底清理 (配置项 + 凭证 + 会话 + 工作区文件)",
          },
        ],
      })) as ResetScope;
      await onboardHelpers.handleReset(resetScope, resolveUserPath(workspaceDefault), runtime);
      baseConfig = {};
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
        return "本地回环 (127.0.0.1)";
      }
      if (value === "lan") {
        return "局域网 (LAN)";
      }
      if (value === "custom") {
        return "自定义 IP";
      }
      if (value === "tailnet") {
        return "Tailnet (Tailscale IP)";
      }
      return "自动分配 (Auto)";
    };
    const formatAuth = (value: GatewayAuthChoice) => {
      if (value === "token") {
        return "Token (默认)";
      }
      return "密码 (Password)";
    };
    const formatTailscale = (value: "off" | "serve" | "funnel") => {
      if (value === "off") {
        return "关闭 (Off)";
      }
      if (value === "serve") {
        return "Serve";
      }
      return "Funnel";
    };
    const quickstartLines = quickstartGateway.hasExisting
      ? [
          "保持您当前的网关设置：",
          `网关端口: ${quickstartGateway.port}`,
          `网关绑定: ${formatBind(quickstartGateway.bind)}`,
          ...(quickstartGateway.bind === "custom" && quickstartGateway.customBindHost
            ? [`网关自定义 IP: ${quickstartGateway.customBindHost}`]
            : []),
          `网关认证方式: ${formatAuth(quickstartGateway.authMode)}`,
          `Tailscale 暴露模式: ${formatTailscale(quickstartGateway.tailscaleMode)}`,
          "将直接进入聊天频道 (Direct to chat channels)。",
        ]
      : [
          `网关端口: ${DEFAULT_GATEWAY_PORT}`,
          "网关绑定: 本地回环 (127.0.0.1)",
          "网关认证方式: Token (默认)",
          "Tailscale 暴露模式: 关闭 (Off)",
          "将直接进入聊天频道 (Direct to chat channels)。",
        ];
    await prompter.note(quickstartLines.join("\n"), "快速启动配置 (QuickStart)");
  }

  const localPort = resolveGatewayPort(baseConfig);
  const localUrl = `ws://127.0.0.1:${localPort}`;
  const localProbe = await onboardHelpers.probeGatewayReachable({
    url: localUrl,
    token: baseConfig.gateway?.auth?.token ?? process.env.OPENCLAW_GATEWAY_TOKEN,
    password: baseConfig.gateway?.auth?.password ?? process.env.OPENCLAW_GATEWAY_PASSWORD,
  });
  const remoteUrl = baseConfig.gateway?.remote?.url?.trim() ?? "";
  const remoteProbe = remoteUrl
    ? await onboardHelpers.probeGatewayReachable({
        url: remoteUrl,
        token: baseConfig.gateway?.remote?.token,
      })
    : null;

  const mode =
    opts.mode ??
    (flow === "quickstart"
      ? "local"
      : ((await prompter.select({
          message: "您希望设置哪种网关?",
          options: [
            {
              value: "local",
              label: "本地网关 (Local gateway - 当前机器)",
              hint: localProbe.ok ? `网关已就绪 (${localUrl})` : `未检测到网关 (${localUrl})`,
            },
            {
              value: "remote",
              label: "远程网关 (Remote gateway - 仅限信息读取)",
              hint: !remoteUrl
                ? "尚未配置远程 URL"
                : remoteProbe?.ok
                  ? `网关已就绪 (${remoteUrl})`
                  : `已配置但无法连接 (${remoteUrl})`,
            },
          ],
        })) as OnboardMode));

  if (mode === "remote") {
    const { promptRemoteGatewayConfig } = await import("../commands/onboard-remote.js");
    const { logConfigUpdated } = await import("../config/logging.js");
    let nextConfig = await promptRemoteGatewayConfig(baseConfig, prompter);
    nextConfig = onboardHelpers.applyWizardMetadata(nextConfig, { command: "onboard", mode });
    await writeConfigFile(nextConfig);
    logConfigUpdated(runtime);
    await prompter.outro("远程网关配置已完成 (Remote gateway configured)。");
    return;
  }

  const workspaceInput =
    opts.workspace ??
    (flow === "quickstart"
      ? (baseConfig.agents?.defaults?.workspace ?? onboardHelpers.DEFAULT_WORKSPACE)
      : await prompter.text({
          message: "工作区目录 (Workspace directory)",
          initialValue: baseConfig.agents?.defaults?.workspace ?? onboardHelpers.DEFAULT_WORKSPACE,
        }));

  const workspaceDir = resolveUserPath(workspaceInput.trim() || onboardHelpers.DEFAULT_WORKSPACE);

  const { applyOnboardingLocalWorkspaceConfig } = await import("../commands/onboard-config.js");
  let nextConfig: OpenClawConfig = applyOnboardingLocalWorkspaceConfig(baseConfig, workspaceDir);

  const { ensureAuthProfileStore } = await import("../agents/auth-profiles.js");
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
        token: opts.authChoice === "apiKey" && opts.token ? opts.token : undefined,
        siliconflowGlobalApiKey: opts.siliconflowGlobalApiKey,
        siliconflowCnApiKey: opts.siliconflowCnApiKey,
      },
    });
    nextConfig = authResult.config;
  }

  if (authChoiceFromPrompt && authChoice !== "custom-api-key") {
    const modelSelection = await promptDefaultModel({
      config: nextConfig,
      prompter,
      allowKeep: true,
      ignoreAllowlist: true,
      includeVllm: true,
      preferredProvider: resolvePreferredProviderForAuthChoice(authChoice),
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
    prompter,
    runtime,
  });
  nextConfig = gateway.nextConfig;
  const settings = gateway.settings;

  if (opts.skipChannels ?? opts.skipProviders) {
    await prompter.note("跳过频道配置拉取 (Skipping channel setup)。", "频道配置 (Channels)");
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
    });
  }

  await writeConfigFile(nextConfig);
  const { logConfigUpdated } = await import("../config/logging.js");
  logConfigUpdated(runtime);
  await onboardHelpers.ensureWorkspaceAndSessions(workspaceDir, runtime, {
    skipBootstrap: Boolean(nextConfig.agents?.defaults?.skipBootstrap),
  });

  if (opts.skipSkills) {
    await prompter.note("跳过插件安装 (Skipping skills setup)。", "能力插件 (Skills)");
  } else {
    const { setupSkills } = await import("../commands/onboard-skills.js");
    nextConfig = await setupSkills(nextConfig, workspaceDir, runtime, prompter);
  }

  // Setup hooks (session memory on /new)
  const { setupInternalHooks } = await import("../commands/onboard-hooks.js");
  nextConfig = await setupInternalHooks(nextConfig, runtime, prompter);

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
