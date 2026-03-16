import fs from "node:fs/promises";
import path from "node:path";
import { DEFAULT_BOOTSTRAP_FILENAME } from "../agents/workspace.js";
import { formatCliCommand } from "../cli/command-format.js";
import {
  buildGatewayInstallPlan,
  gatewayInstallErrorHint,
} from "../commands/daemon-install-helpers.js";
import {
  DEFAULT_GATEWAY_DAEMON_RUNTIME,
  GATEWAY_DAEMON_RUNTIME_OPTIONS,
} from "../commands/daemon-runtime.js";
import { resolveGatewayInstallToken } from "../commands/gateway-install-token.js";
import { formatHealthCheckFailure } from "../commands/health-format.js";
import { healthCommand } from "../commands/health.js";
import {
  detectBrowserOpenSupport,
  formatControlUiSshHint,
  openUrl,
  probeGatewayReachable,
  waitForGatewayReachable,
  resolveControlUiLinks,
} from "../commands/onboard-helpers.js";
import type { OnboardOptions } from "../commands/onboard-types.js";
import type { OpenClawConfig } from "../config/config.js";
import { describeGatewayServiceRestart, resolveGatewayService } from "../daemon/service.js";
import { isSystemdUserServiceAvailable } from "../daemon/systemd.js";
import { ensureControlUiAssetsBuilt } from "../infra/control-ui-assets.js";
import type { RuntimeEnv } from "../runtime.js";
import { restoreTerminalState } from "../terminal/restore.js";
import { runTui } from "../tui/tui.js";
import { resolveUserPath } from "../utils.js";
import type { WizardPrompter } from "./prompts.js";
import { setupWizardShellCompletion } from "./setup.completion.js";
import { resolveSetupSecretInputString } from "./setup.secret-input.js";
import type { GatewayWizardSettings, WizardFlow } from "./setup.types.js";

type FinalizeOnboardingOptions = {
  flow: WizardFlow;
  opts: OnboardOptions;
  baseConfig: OpenClawConfig;
  nextConfig: OpenClawConfig;
  workspaceDir: string;
  settings: GatewayWizardSettings;
  prompter: WizardPrompter;
  runtime: RuntimeEnv;
};

export async function finalizeSetupWizard(
  options: FinalizeOnboardingOptions,
): Promise<{ launchedTui: boolean }> {
  const { flow, opts, baseConfig, nextConfig, settings, prompter, runtime } = options;

  const withWizardProgress = async <T>(
    label: string,
    options: { doneMessage?: string | (() => string | undefined) },
    work: (progress: { update: (message: string) => void }) => Promise<T>,
  ): Promise<T> => {
    const progress = prompter.progress(label);
    try {
      return await work(progress);
    } finally {
      progress.stop(
        typeof options.doneMessage === "function" ? options.doneMessage() : options.doneMessage,
      );
    }
  };

  const systemdAvailable =
    process.platform === "linux" ? await isSystemdUserServiceAvailable() : true;
  if (process.platform === "linux" && !systemdAvailable) {
    await prompter.note("Systemd 用户服务不可用。跳过 lingering 检查和服务安装。", "Systemd");
  }

  if (process.platform === "linux" && systemdAvailable) {
    const { ensureSystemdUserLingerInteractive } = await import("../commands/systemd-linger.js");
    await ensureSystemdUserLingerInteractive({
      runtime,
      prompter: {
        confirm: prompter.confirm,
        note: prompter.note,
      },
      reason:
        "Linux 安装默认使用 systemd 用户服务。如果不启用 lingering，systemd 会在登出/空闲时停止用户会话并终止网关。",
      requireConfirm: false,
    });
  }

  const explicitInstallDaemon =
    typeof opts.installDaemon === "boolean" ? opts.installDaemon : undefined;
  let installDaemon: boolean;
  if (explicitInstallDaemon !== undefined) {
    installDaemon = explicitInstallDaemon;
  } else if (process.platform === "linux" && !systemdAvailable) {
    installDaemon = false;
  } else if (flow === "quickstart") {
    installDaemon = true;
  } else {
    installDaemon = await prompter.confirm({
      message: "安装网关服务（推荐）",
      initialValue: true,
    });
  }

  if (process.platform === "linux" && !systemdAvailable && installDaemon) {
    await prompter.note(
      "Systemd 用户服务不可用；跳过服务安装。请使用容器管理器或 `docker compose up -d`。",
      "网关服务",
    );
    installDaemon = false;
  }

  if (installDaemon) {
    const daemonRuntime =
      flow === "quickstart"
        ? DEFAULT_GATEWAY_DAEMON_RUNTIME
        : await prompter.select({
            message: "网关服务运行时",
            options: GATEWAY_DAEMON_RUNTIME_OPTIONS,
            initialValue: opts.daemonRuntime ?? DEFAULT_GATEWAY_DAEMON_RUNTIME,
          });
    if (flow === "quickstart") {
      await prompter.note(
        "快速开始使用 Node 作为网关服务运行时（稳定且受支持）。",
        "网关服务运行时",
      );
    }
    const service = resolveGatewayService();
    const loaded = await service.isLoaded({ env: process.env });
    let restartWasScheduled = false;
    if (loaded) {
      const action = await prompter.select({
        message: "网关服务已安装",
        options: [
          { value: "restart", label: "重启" },
          { value: "reinstall", label: "重新安装" },
          { value: "skip", label: "跳过" },
        ],
      });
      if (action === "restart") {
        let restartDoneMessage = "网关服务已重启。";
        await withWizardProgress(
          "网关服务",
          { doneMessage: () => restartDoneMessage },
          async (progress) => {
            progress.update("正在重启网关服务…");
            const restartResult = await service.restart({
              env: process.env,
              stdout: process.stdout,
            });
            const restartStatus = describeGatewayServiceRestart("Gateway", restartResult);
            restartDoneMessage = restartStatus.scheduled
              ? "网关服务重启已排定。"
              : restartStatus.progressMessage;
            restartWasScheduled = restartStatus.scheduled;
          },
        );
      } else if (action === "reinstall") {
        await withWizardProgress(
          "网关服务",
          { doneMessage: "网关服务已卸载。" },
          async (progress) => {
            progress.update("正在卸载网关服务…");
            await service.uninstall({ env: process.env, stdout: process.stdout });
          },
        );
      }
    }

    if (
      !loaded ||
      (!restartWasScheduled && loaded && !(await service.isLoaded({ env: process.env })))
    ) {
      const progress = prompter.progress("网关服务");
      let installError: string | null = null;
      try {
        progress.update("正在准备网关服务…");
        const tokenResolution = await resolveGatewayInstallToken({
          config: nextConfig,
          env: process.env,
        });
        for (const warning of tokenResolution.warnings) {
          await prompter.note(warning, "网关服务");
        }
        if (tokenResolution.unavailableReason) {
          installError = [
            "网关安装被阻止：",
            tokenResolution.unavailableReason,
            "请修复网关认证配置/令牌输入后重新运行设置。",
          ].join(" ");
        } else {
          const { programArguments, workingDirectory, environment } = await buildGatewayInstallPlan(
            {
              env: process.env,
              port: settings.port,
              runtime: daemonRuntime,
              warn: (message, title) => prompter.note(message, title),
              config: nextConfig,
            },
          );

          progress.update("正在安装网关服务…");
          await service.install({
            env: process.env,
            stdout: process.stdout,
            programArguments,
            workingDirectory,
            environment,
          });
        }
      } catch (err) {
        installError = err instanceof Error ? err.message : String(err);
      } finally {
        progress.stop(installError ? "网关服务安装失败。" : "网关服务已安装。");
      }
      if (installError) {
        await prompter.note(`网关服务安装失败：${installError}`, "网关");
        await prompter.note(gatewayInstallErrorHint(), "网关");
      }
    }
  }

  if (!opts.skipHealth) {
    const probeLinks = resolveControlUiLinks({
      bind: nextConfig.gateway?.bind ?? "loopback",
      port: settings.port,
      customBindHost: nextConfig.gateway?.customBindHost,
      basePath: undefined,
    });
    // Daemon install/restart can briefly flap the WS; wait a bit so health check doesn't false-fail.
    await waitForGatewayReachable({
      url: probeLinks.wsUrl,
      token: settings.gatewayToken,
      deadlineMs: 15_000,
    });
    try {
      await healthCommand({ json: false, timeoutMs: 10_000 }, runtime);
    } catch (err) {
      runtime.error(formatHealthCheckFailure(err));
      await prompter.note(
        [
          "文档：",
          "https://docs.openclaw.ai/gateway/health",
          "https://docs.openclaw.ai/gateway/troubleshooting",
        ].join("\n"),
        "健康检查帮助",
      );
    }
  }

  const controlUiEnabled =
    nextConfig.gateway?.controlUi?.enabled ?? baseConfig.gateway?.controlUi?.enabled ?? true;
  if (!opts.skipUi && controlUiEnabled) {
    const controlUiAssets = await ensureControlUiAssetsBuilt(runtime);
    if (!controlUiAssets.ok && controlUiAssets.message) {
      runtime.error(controlUiAssets.message);
    }
  }

  await prompter.note(
    [
      "添加节点以获取更多功能：",
      "- macOS 应用（系统集成 + 通知）",
      "- iOS 应用（相机/画布）",
      "- Android 应用（相机/画布）",
    ].join("\n"),
    "可选应用",
  );

  const controlUiBasePath =
    nextConfig.gateway?.controlUi?.basePath ?? baseConfig.gateway?.controlUi?.basePath;
  const links = resolveControlUiLinks({
    bind: settings.bind,
    port: settings.port,
    customBindHost: settings.customBindHost,
    basePath: controlUiBasePath,
  });
  const authedUrl =
    settings.authMode === "token" && settings.gatewayToken
      ? `${links.httpUrl}#token=${encodeURIComponent(settings.gatewayToken)}`
      : links.httpUrl;
  let resolvedGatewayPassword = "";
  if (settings.authMode === "password") {
    try {
      resolvedGatewayPassword =
        (await resolveSetupSecretInputString({
          config: nextConfig,
          value: nextConfig.gateway?.auth?.password,
          path: "gateway.auth.password",
          env: process.env,
        })) ?? "";
    } catch (error) {
      await prompter.note(
        [
          "无法解析 gateway.auth.password 的 SecretRef 以用于设置认证。",
          error instanceof Error ? error.message : String(error),
        ].join("\n"),
        "网关认证",
      );
    }
  }

  const gatewayProbe = await probeGatewayReachable({
    url: links.wsUrl,
    token: settings.authMode === "token" ? settings.gatewayToken : undefined,
    password: settings.authMode === "password" ? resolvedGatewayPassword : "",
  });
  const gatewayStatusLine = gatewayProbe.ok
    ? "网关：可达"
    : `网关：未检测到${gatewayProbe.detail ? `（${gatewayProbe.detail}）` : ""}`;
  const bootstrapPath = path.join(
    resolveUserPath(options.workspaceDir),
    DEFAULT_BOOTSTRAP_FILENAME,
  );
  const hasBootstrap = await fs
    .access(bootstrapPath)
    .then(() => true)
    .catch(() => false);

  await prompter.note(
    [
      `Web UI：${links.httpUrl}`,
      settings.authMode === "token" && settings.gatewayToken
        ? `Web UI（含令牌）：${authedUrl}`
        : undefined,
      `网关 WS：${links.wsUrl}`,
      gatewayStatusLine,
      "文档：https://docs.openclaw.ai/web/control-ui",
    ]
      .filter(Boolean)
      .join("\n"),
    "控制 UI",
  );

  let controlUiOpened = false;
  let controlUiOpenHint: string | undefined;
  let seededInBackground = false;
  let hatchChoice: "tui" | "web" | "later" | null = null;
  let launchedTui = false;

  if (!opts.skipUi && gatewayProbe.ok) {
    if (hasBootstrap) {
      await prompter.note(
        [
          "这是让你的智能体真正成为“你的智能体”的关键一步。",
          "请慢慢来。",
          "你告诉它的信息越多，后续体验通常越好。",
          '将会发送："Wake up, my friend!"',
        ].join("\n"),
        "启动 TUI（最佳选择）",
      );
    }

    await prompter.note(
      [
        "网关令牌用于网关和 Control UI 的共享认证。",
        "存储位置：~/.openclaw/openclaw.json（gateway.auth.token）或 OPENCLAW_GATEWAY_TOKEN。",
        `查看令牌：${formatCliCommand("openclaw config get gateway.auth.token")}`,
        `生成令牌：${formatCliCommand("openclaw doctor --generate-gateway-token")}`,
        "Web UI 会在当前标签页内存中保存仪表盘 URL 里的令牌，并在加载后从 URL 中移除。",
        `随时打开仪表盘：${formatCliCommand("openclaw dashboard --no-open")}`,
        "如有提示，请将令牌粘贴到 Control UI 设置中（或直接使用带令牌的仪表盘链接）。",
      ].join("\n"),
      "令牌",
    );

    hatchChoice = await prompter.select({
      message: "你想如何开始使用智能体？",
      options: [
        { value: "tui", label: "在 TUI 中启动（推荐）" },
        { value: "web", label: "打开 Web UI" },
        { value: "later", label: "稍后再做" },
      ],
      initialValue: "tui",
    });

    if (hatchChoice === "tui") {
      restoreTerminalState("pre-setup tui", { resumeStdinIfPaused: true });
      await runTui({
        url: links.wsUrl,
        token: settings.authMode === "token" ? settings.gatewayToken : undefined,
        password: settings.authMode === "password" ? resolvedGatewayPassword : "",
        // Safety: setup TUI should not auto-deliver to lastProvider/lastTo.
        deliver: false,
        message: hasBootstrap ? "Wake up, my friend!" : undefined,
      });
      launchedTui = true;
    } else if (hatchChoice === "web") {
      const browserSupport = await detectBrowserOpenSupport();
      if (browserSupport.ok) {
        controlUiOpened = await openUrl(authedUrl);
        if (!controlUiOpened) {
          controlUiOpenHint = formatControlUiSshHint({
            port: settings.port,
            basePath: controlUiBasePath,
            token: settings.authMode === "token" ? settings.gatewayToken : undefined,
          });
        }
      } else {
        controlUiOpenHint = formatControlUiSshHint({
          port: settings.port,
          basePath: controlUiBasePath,
          token: settings.authMode === "token" ? settings.gatewayToken : undefined,
        });
      }
      await prompter.note(
        [
          `仪表盘链接（含令牌）：${authedUrl}`,
          controlUiOpened
            ? "已在浏览器中打开。保留该标签页即可控制 OpenClaw。"
            : "请在本机浏览器中复制/粘贴此 URL 以控制 OpenClaw。",
          controlUiOpenHint,
        ]
          .filter(Boolean)
          .join("\n"),
        "仪表盘已就绪",
      );
    } else {
      await prompter.note(
        `准备好后执行：${formatCliCommand("openclaw dashboard --no-open")}`,
        "稍后",
      );
    }
  } else if (opts.skipUi) {
    await prompter.note("已跳过 Control UI/TUI 提示。", "控制 UI");
  }

  await prompter.note(
    ["请备份你的智能体工作区。", "文档：https://docs.openclaw.ai/concepts/agent-workspace"].join(
      "\n",
    ),
    "工作区备份",
  );

  await prompter.note(
    "在你的电脑上运行智能体有风险，请加固你的设置：https://docs.openclaw.ai/security",
    "安全",
  );

  await setupWizardShellCompletion({ flow, prompter });

  const shouldOpenControlUi =
    !opts.skipUi &&
    settings.authMode === "token" &&
    Boolean(settings.gatewayToken) &&
    hatchChoice === null;
  if (shouldOpenControlUi) {
    const browserSupport = await detectBrowserOpenSupport();
    if (browserSupport.ok) {
      controlUiOpened = await openUrl(authedUrl);
      if (!controlUiOpened) {
        controlUiOpenHint = formatControlUiSshHint({
          port: settings.port,
          basePath: controlUiBasePath,
          token: settings.gatewayToken,
        });
      }
    } else {
      controlUiOpenHint = formatControlUiSshHint({
        port: settings.port,
        basePath: controlUiBasePath,
        token: settings.gatewayToken,
      });
    }

    await prompter.note(
      [
        `仪表盘链接（含令牌）：${authedUrl}`,
        controlUiOpened
          ? "已在浏览器中打开。保留该标签页即可控制 OpenClaw。"
          : "请在本机浏览器中复制/粘贴此 URL 以控制 OpenClaw。",
        controlUiOpenHint,
      ]
        .filter(Boolean)
        .join("\n"),
      "仪表盘已就绪",
    );
  }

  const webSearchProvider = nextConfig.tools?.web?.search?.provider;
  const webSearchEnabled = nextConfig.tools?.web?.search?.enabled;
  if (webSearchProvider) {
    const { SEARCH_PROVIDER_OPTIONS, resolveExistingKey, hasExistingKey, hasKeyInEnv } =
      await import("../commands/onboard-search.js");
    const entry = SEARCH_PROVIDER_OPTIONS.find((e) => e.value === webSearchProvider);
    const label = entry?.label ?? webSearchProvider;
    const storedKey = resolveExistingKey(nextConfig, webSearchProvider);
    const keyConfigured = hasExistingKey(nextConfig, webSearchProvider);
    const envAvailable = entry ? hasKeyInEnv(entry) : false;
    const hasKey = keyConfigured || envAvailable;
    const keySource = storedKey
      ? "API Key：已存储在配置中。"
      : keyConfigured
        ? "API Key：已通过密钥引用配置。"
        : envAvailable
          ? `API Key：通过 ${entry?.envKeys.join(" / ")} 环境变量提供。`
          : undefined;
    if (webSearchEnabled !== false && hasKey) {
      await prompter.note(
        [
          "已启用网页搜索，因此你的智能体可在需要时在线检索信息。",
          "",
          `提供方：${label}`,
          ...(keySource ? [keySource] : []),
          "文档：https://docs.openclaw.ai/tools/web",
        ].join("\n"),
        "网页搜索",
      );
    } else if (!hasKey) {
      await prompter.note(
        [
          `已选择提供方 ${label}，但未找到 API Key。`,
          "在添加密钥之前，`web_search` 无法工作。",
          `  ${formatCliCommand("openclaw configure --section web")}`,
          "",
          `获取密钥：${entry?.signupUrl ?? "https://docs.openclaw.ai/tools/web"}`,
          "文档：https://docs.openclaw.ai/tools/web",
        ].join("\n"),
        "网页搜索",
      );
    } else {
      await prompter.note(
        [
          `网页搜索（${label}）已配置，但当前处于关闭状态。`,
          `重新启用：${formatCliCommand("openclaw configure --section web")}`,
          "",
          "文档：https://docs.openclaw.ai/tools/web",
        ].join("\n"),
        "网页搜索",
      );
    }
  } else {
    // Legacy configs may have a working key (e.g. apiKey or BRAVE_API_KEY) without
    // an explicit provider. Runtime auto-detects these, so avoid saying "skipped".
    const { SEARCH_PROVIDER_OPTIONS, hasExistingKey, hasKeyInEnv } =
      await import("../commands/onboard-search.js");
    const legacyDetected = SEARCH_PROVIDER_OPTIONS.find(
      (e) => hasExistingKey(nextConfig, e.value) || hasKeyInEnv(e),
    );
    if (legacyDetected) {
      await prompter.note(
        [
          `可通过 ${legacyDetected.label} 使用网页搜索（自动检测）。`,
          "文档：https://docs.openclaw.ai/tools/web",
        ].join("\n"),
        "网页搜索",
      );
    } else {
      await prompter.note(
        [
          "已跳过网页搜索。你可以稍后启用：",
          `  ${formatCliCommand("openclaw configure --section web")}`,
          "",
          "文档：https://docs.openclaw.ai/tools/web",
        ].join("\n"),
        "网页搜索",
      );
    }
  }

  await prompter.note(
    '接下来可以看看：https://openclaw.ai/showcase（"What People Are Building"）。',
    "接下来",
  );

  await prompter.outro(
    controlUiOpened
      ? "设置完成。仪表盘已打开；保留该标签页即可控制 OpenClaw。"
      : seededInBackground
        ? "设置完成。Web UI 已在后台预热；你可以随时通过上方仪表盘链接打开。"
        : "设置完成。请使用上方仪表盘链接控制 OpenClaw。",
  );

  return { launchedTui };
}
