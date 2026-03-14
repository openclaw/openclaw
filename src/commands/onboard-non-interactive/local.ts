import { formatCliCommand } from "../../cli/command-format.js";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveGatewayPort, writeConfigFile } from "../../config/config.js";
import { logConfigUpdated } from "../../config/logging.js";
import type { RuntimeEnv } from "../../runtime.js";
import { DEFAULT_GATEWAY_DAEMON_RUNTIME } from "../daemon-runtime.js";
import { applyOnboardingLocalWorkspaceConfig } from "../onboard-config.js";
import {
  applyWizardMetadata,
  DEFAULT_WORKSPACE,
  ensureWorkspaceAndSessions,
  resolveControlUiLinks,
  waitForGatewayReachable,
} from "../onboard-helpers.js";
import type { OnboardOptions } from "../onboard-types.js";
import { inferAuthChoiceFromFlags } from "./local/auth-choice-inference.js";
import { applyNonInteractiveGatewayConfig } from "./local/gateway-config.js";
import {
  logNonInteractiveOnboardingFailure,
  logNonInteractiveOnboardingJson,
} from "./local/output.js";
import { applyNonInteractiveSkillsConfig } from "./local/skills-config.js";
import { resolveNonInteractiveWorkspaceDir } from "./local/workspace.js";

const INSTALL_DAEMON_HEALTH_DEADLINE_MS = 45_000;
const ATTACH_EXISTING_GATEWAY_HEALTH_DEADLINE_MS = 15_000;

async function collectGatewayHealthFailureDiagnostics(): Promise<
  | {
      service?: {
        label: string;
        loaded: boolean;
        loadedText: string;
        runtimeStatus?: string;
        state?: string;
        pid?: number;
        lastExitStatus?: number;
        lastExitReason?: string;
      };
      lastGatewayError?: string;
      inspectError?: string;
    }
  | undefined
> {
  const diagnostics: {
    service?: {
      label: string;
      loaded: boolean;
      loadedText: string;
      runtimeStatus?: string;
      state?: string;
      pid?: number;
      lastExitStatus?: number;
      lastExitReason?: string;
    };
    lastGatewayError?: string;
    inspectError?: string;
  } = {};

  try {
    const { resolveGatewayService } = await import("../../daemon/service.js");
    const service = resolveGatewayService();
    const env = process.env as Record<string, string | undefined>;
    const [loaded, runtime] = await Promise.all([
      service.isLoaded({ env }).catch(() => false),
      service.readRuntime(env).catch(() => undefined),
    ]);
    diagnostics.service = {
      label: service.label,
      loaded,
      loadedText: service.loadedText,
      runtimeStatus: runtime?.status,
      state: runtime?.state,
      pid: runtime?.pid,
      lastExitStatus: runtime?.lastExitStatus,
      lastExitReason: runtime?.lastExitReason,
    };
  } catch (err) {
    diagnostics.inspectError = `service diagnostics failed: ${String(err)}`;
  }

  try {
    const { readLastGatewayErrorLine } = await import("../../daemon/diagnostics.js");
    diagnostics.lastGatewayError = (await readLastGatewayErrorLine(process.env)) ?? undefined;
  } catch (err) {
    diagnostics.inspectError = diagnostics.inspectError
      ? `${diagnostics.inspectError}; log diagnostics failed: ${String(err)}`
      : `log diagnostics failed: ${String(err)}`;
  }

  return diagnostics.service || diagnostics.lastGatewayError || diagnostics.inspectError
    ? diagnostics
    : undefined;
}

export async function runNonInteractiveOnboardingLocal(params: {
  opts: OnboardOptions;
  runtime: RuntimeEnv;
  baseConfig: OpenClawConfig;
}) {
  const { opts, runtime, baseConfig } = params;
  const mode = "local" as const;

  const workspaceDir = resolveNonInteractiveWorkspaceDir({
    opts,
    baseConfig,
    defaultWorkspaceDir: DEFAULT_WORKSPACE,
  });

  let nextConfig: OpenClawConfig = applyOnboardingLocalWorkspaceConfig(baseConfig, workspaceDir);

  const inferredAuthChoice = inferAuthChoiceFromFlags(opts);
  if (!opts.authChoice && inferredAuthChoice.matches.length > 1) {
    runtime.error(
      [
        "Multiple API key flags were provided for non-interactive onboarding.",
        "Use a single provider flag or pass --auth-choice explicitly.",
        `Flags: ${inferredAuthChoice.matches.map((match) => match.label).join(", ")}`,
      ].join("\n"),
    );
    runtime.exit(1);
    return;
  }
  const authChoice = opts.authChoice ?? inferredAuthChoice.choice ?? "skip";
  if (authChoice !== "skip") {
    const { applyNonInteractiveAuthChoice } = await import("./local/auth-choice.js");
    const nextConfigAfterAuth = await applyNonInteractiveAuthChoice({
      nextConfig,
      authChoice,
      opts,
      runtime,
      baseConfig,
    });
    if (!nextConfigAfterAuth) {
      return;
    }
    nextConfig = nextConfigAfterAuth;
  }

  const gatewayBasePort = resolveGatewayPort(baseConfig);
  const gatewayResult = applyNonInteractiveGatewayConfig({
    nextConfig,
    opts,
    runtime,
    defaultPort: gatewayBasePort,
  });
  if (!gatewayResult) {
    return;
  }
  nextConfig = gatewayResult.nextConfig;

  nextConfig = applyNonInteractiveSkillsConfig({ nextConfig, opts, runtime });

  nextConfig = applyWizardMetadata(nextConfig, { command: "onboard", mode });
  await writeConfigFile(nextConfig);
  logConfigUpdated(runtime);

  await ensureWorkspaceAndSessions(workspaceDir, runtime, {
    skipBootstrap: Boolean(nextConfig.agents?.defaults?.skipBootstrap),
  });

  if (opts.installDaemon) {
    const { installGatewayDaemonNonInteractive } = await import("./local/daemon-install.js");
    await installGatewayDaemonNonInteractive({
      nextConfig,
      opts,
      runtime,
      port: gatewayResult.port,
    });
  }

  const daemonRuntimeRaw = opts.daemonRuntime ?? DEFAULT_GATEWAY_DAEMON_RUNTIME;
  if (!opts.skipHealth) {
    const { healthCommand } = await import("../health.js");
    const links = resolveControlUiLinks({
      bind: gatewayResult.bind as "auto" | "lan" | "loopback" | "custom" | "tailnet",
      port: gatewayResult.port,
      customBindHost: nextConfig.gateway?.customBindHost,
      basePath: undefined,
    });
    const probe = await waitForGatewayReachable({
      url: links.wsUrl,
      token: gatewayResult.gatewayToken,
      deadlineMs: opts.installDaemon
        ? INSTALL_DAEMON_HEALTH_DEADLINE_MS
        : ATTACH_EXISTING_GATEWAY_HEALTH_DEADLINE_MS,
    });
    if (!probe.ok) {
      const diagnostics = opts.installDaemon
        ? await collectGatewayHealthFailureDiagnostics()
        : undefined;
      logNonInteractiveOnboardingFailure({
        opts,
        runtime,
        mode,
        phase: "gateway-health",
        message: `Gateway did not become reachable at ${links.wsUrl}.`,
        detail: probe.detail,
        gateway: {
          wsUrl: links.wsUrl,
          httpUrl: links.httpUrl,
        },
        installDaemon: Boolean(opts.installDaemon),
        daemonRuntime: opts.installDaemon ? daemonRuntimeRaw : undefined,
        diagnostics,
        hints: !opts.installDaemon
          ? [
              "Non-interactive local onboarding only waits for an already-running gateway unless you pass --install-daemon.",
              `Fix: start \`${formatCliCommand("openclaw gateway run")}\`, re-run with \`--install-daemon\`, or use \`--skip-health\`.`,
              process.platform === "win32"
                ? "Native Windows managed gateway install tries Scheduled Tasks first and falls back to a per-user Startup-folder login item when task creation is denied."
                : undefined,
            ].filter((value): value is string => Boolean(value))
          : [`Run \`${formatCliCommand("openclaw gateway status --deep")}\` for more detail.`],
      });
      runtime.exit(1);
      return;
    }
    await healthCommand({ json: false, timeoutMs: 10_000 }, runtime);
  }

  logNonInteractiveOnboardingJson({
    opts,
    runtime,
    mode,
    workspaceDir,
    authChoice,
    gateway: {
      port: gatewayResult.port,
      bind: gatewayResult.bind,
      authMode: gatewayResult.authMode,
      tailscaleMode: gatewayResult.tailscaleMode,
    },
    installDaemon: Boolean(opts.installDaemon),
    daemonRuntime: opts.installDaemon ? daemonRuntimeRaw : undefined,
    skipSkills: Boolean(opts.skipSkills),
    skipHealth: Boolean(opts.skipHealth),
  });

  if (!opts.json) {
    runtime.log(
      `Tip: run \`${formatCliCommand("openclaw configure --section web")}\` to store your Brave API key for web_search. Docs: https://docs.openclaw.ai/tools/web`,
    );
  }
}
