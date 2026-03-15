import {
  normalizeGatewayTokenInput,
  randomToken,
  validateGatewayPasswordInput,
} from "../commands/onboard-helpers.js";
import type { GatewayAuthChoice, SecretInputMode } from "../commands/onboard-types.js";
import type { GatewayBindMode, GatewayTailscaleMode, OpenClawConfig } from "../config/config.js";
import { ensureControlUiAllowedOriginsForNonLoopbackBind } from "../config/gateway-control-ui-origins.js";
import {
  normalizeSecretInputString,
  resolveSecretInputRef,
  type SecretInput,
} from "../config/types.secrets.js";
import {
  maybeAddTailnetOriginToControlUiAllowedOrigins,
  TAILSCALE_EXPOSURE_OPTIONS,
} from "../gateway/gateway-config-prompts.shared.js";
import { DEFAULT_DANGEROUS_NODE_COMMANDS } from "../gateway/node-command-policy.js";
import { cliT } from "../i18n/cli.js";
import { findTailscaleBinary } from "../infra/tailscale.js";
import type { RuntimeEnv } from "../runtime.js";
import { validateIPv4AddressInput } from "../shared/net/ipv4.js";
import { resolveOnboardingSecretInputString } from "./onboarding.secret-input.js";
import type {
  GatewayWizardSettings,
  QuickstartGatewayDefaults,
  WizardFlow,
} from "./onboarding.types.js";
import type { WizardPrompter } from "./prompts.js";

type ConfigureGatewayOptions = {
  flow: WizardFlow;
  baseConfig: OpenClawConfig;
  nextConfig: OpenClawConfig;
  localPort: number;
  quickstartGateway: QuickstartGatewayDefaults;
  secretInputMode?: SecretInputMode;
  prompter: WizardPrompter;
  runtime: RuntimeEnv;
};

type ConfigureGatewayResult = {
  nextConfig: OpenClawConfig;
  settings: GatewayWizardSettings;
};

export async function configureGatewayForOnboarding(
  opts: ConfigureGatewayOptions,
): Promise<ConfigureGatewayResult> {
  const { flow, localPort, quickstartGateway, prompter } = opts;
  let { nextConfig } = opts;
  const t = (key: Parameters<typeof cliT>[0], vars?: Record<string, string | number>) =>
    cliT(key, process.env, vars);

  const port =
    flow === "quickstart"
      ? quickstartGateway.port
      : Number.parseInt(
          String(
            await prompter.text({
              message: t("wizard.gatewayPortQuestion"),
              initialValue: String(localPort),
              validate: (value) =>
                Number.isFinite(Number(value)) ? undefined : t("wizard.invalidPortError"),
            }),
          ),
          10,
        );

  let bind: GatewayWizardSettings["bind"] =
    flow === "quickstart"
      ? quickstartGateway.bind
      : await prompter.select<GatewayWizardSettings["bind"]>({
          message: t("wizard.gatewayBindQuestion"),
          options: [
            { value: "loopback", label: t("wizard.gatewayBindLoopbackLabel") },
            { value: "lan", label: t("wizard.gatewayBindLanLabel") },
            { value: "tailnet", label: t("wizard.gatewayBindTailnetLabel") },
            { value: "auto", label: t("wizard.gatewayBindAutoLabel") },
            { value: "custom", label: t("wizard.gatewayBindCustomLabel") },
          ],
        });

  let customBindHost = quickstartGateway.customBindHost;
  if (bind === "custom") {
    const needsPrompt = flow !== "quickstart" || !customBindHost;
    if (needsPrompt) {
      const input = await prompter.text({
        message: t("wizard.customIpAddressQuestion"),
        placeholder: t("wizard.customIpAddressPlaceholder"),
        initialValue: customBindHost ?? "",
        validate: validateIPv4AddressInput,
      });
      customBindHost = typeof input === "string" ? input.trim() : undefined;
    }
  }

  let authMode =
    flow === "quickstart"
      ? quickstartGateway.authMode
      : ((await prompter.select({
          message: t("wizard.gatewayAuthQuestion"),
          options: [
            {
              value: "token",
              label: t("wizard.gatewayAuthTokenLabel"),
              hint: t("wizard.gatewayAuthTokenHint"),
            },
            { value: "password", label: t("wizard.gatewayAuthPasswordLabel") },
          ],
          initialValue: "token",
        })) as GatewayAuthChoice);

  const tailscaleExposureOptions = TAILSCALE_EXPOSURE_OPTIONS.map((option) => {
    if (option.value === "off") {
      return {
        value: option.value,
        label: t("wizard.tailscaleExposureOffLabel"),
        hint: t("wizard.tailscaleExposureOffHint"),
      };
    }
    if (option.value === "serve") {
      return {
        value: option.value,
        label: t("wizard.tailscaleExposureServeLabel"),
        hint: t("wizard.tailscaleExposureServeHint"),
      };
    }
    return {
      value: option.value,
      label: t("wizard.tailscaleExposureFunnelLabel"),
      hint: t("wizard.tailscaleExposureFunnelHint"),
    };
  });

  const tailscaleMode: GatewayWizardSettings["tailscaleMode"] =
    flow === "quickstart"
      ? quickstartGateway.tailscaleMode
      : await prompter.select<GatewayWizardSettings["tailscaleMode"]>({
          message: t("wizard.tailscaleExposureQuestion"),
          options: tailscaleExposureOptions,
        });

  // Detect Tailscale binary before proceeding with serve/funnel setup.
  // Persist the path so getTailnetHostname can reuse it for origin injection.
  let tailscaleBin: string | null = null;
  if (tailscaleMode !== "off") {
    tailscaleBin = await findTailscaleBinary();
    if (!tailscaleBin) {
      await prompter.note(
        t("wizard.tailscaleMissingBinaryBody"),
        t("wizard.tailscaleWarningTitle"),
      );
    }
  }

  let tailscaleResetOnExit = flow === "quickstart" ? quickstartGateway.tailscaleResetOnExit : false;
  if (tailscaleMode !== "off" && flow !== "quickstart") {
    await prompter.note(t("wizard.tailscaleDocsBody"), t("wizard.tailscaleTitle"));
    tailscaleResetOnExit = Boolean(
      await prompter.confirm({
        message: t("wizard.tailscaleResetOnExitQuestion"),
        initialValue: false,
      }),
    );
  }

  // Safety + constraints:
  // - Tailscale wants bind=loopback so we never expose a non-loopback server + tailscale serve/funnel at once.
  // - Funnel requires password auth.
  if (tailscaleMode !== "off" && bind !== "loopback") {
    await prompter.note(t("wizard.tailscaleRequiresLoopbackNote"), t("wizard.noteTitle"));
    bind = "loopback";
    customBindHost = undefined;
  }

  if (tailscaleMode === "funnel" && authMode !== "password") {
    await prompter.note(t("wizard.tailscaleFunnelRequiresPasswordNote"), t("wizard.noteTitle"));
    authMode = "password";
  }

  let gatewayToken: string | undefined;
  let gatewayTokenInput: SecretInput | undefined;
  if (authMode === "token") {
    const { promptSecretRefForOnboarding, resolveSecretInputModeForEnvSelection } =
      await import("../commands/auth-choice.apply-helpers.js");
    const quickstartTokenString = normalizeSecretInputString(quickstartGateway.token);
    const quickstartTokenRef = resolveSecretInputRef({
      value: quickstartGateway.token,
      defaults: nextConfig.secrets?.defaults,
    }).ref;
    const tokenMode =
      flow === "quickstart" && opts.secretInputMode !== "ref" // pragma: allowlist secret
        ? quickstartTokenRef
          ? "ref"
          : "plaintext"
        : await resolveSecretInputModeForEnvSelection({
            prompter,
            explicitMode: opts.secretInputMode,
            copy: {
              modeMessage: "How do you want to provide the gateway token?",
              plaintextLabel: "Generate/store plaintext token",
              plaintextHint: "Default",
              refLabel: "Use SecretRef",
              refHint: "Store a reference instead of plaintext",
            },
          });
    if (tokenMode === "ref") {
      if (flow === "quickstart" && quickstartTokenRef) {
        gatewayTokenInput = quickstartTokenRef;
        gatewayToken = await resolveOnboardingSecretInputString({
          config: nextConfig,
          value: quickstartTokenRef,
          path: "gateway.auth.token",
          env: process.env,
        });
      } else {
        const resolved = await promptSecretRefForOnboarding({
          provider: "gateway-auth-token",
          config: nextConfig,
          prompter,
          preferredEnvVar: "OPENCLAW_GATEWAY_TOKEN",
          copy: {
            sourceMessage: "Where is this gateway token stored?",
            envVarPlaceholder: "OPENCLAW_GATEWAY_TOKEN",
          },
        });
        gatewayTokenInput = resolved.ref;
        gatewayToken = resolved.resolvedValue;
      }
    } else if (flow === "quickstart") {
      gatewayToken =
        (quickstartTokenString ?? normalizeGatewayTokenInput(process.env.OPENCLAW_GATEWAY_TOKEN)) ||
        randomToken();
      gatewayTokenInput = gatewayToken;
    } else {
      const tokenInput = await prompter.text({
        message: t("wizard.gatewayTokenQuestion"),
        placeholder: t("wizard.gatewayTokenPlaceholder"),
        initialValue:
          quickstartTokenString ??
          normalizeGatewayTokenInput(process.env.OPENCLAW_GATEWAY_TOKEN) ??
          "",
      });
      gatewayToken = normalizeGatewayTokenInput(tokenInput) || randomToken();
      gatewayTokenInput = gatewayToken;
    }
  }

  if (authMode === "password") {
    let password: SecretInput | undefined =
      flow === "quickstart" && quickstartGateway.password ? quickstartGateway.password : undefined;
    if (!password) {
      const { promptSecretRefForOnboarding, resolveSecretInputModeForEnvSelection } =
        await import("../commands/auth-choice.apply-helpers.js");
      const selectedMode = await resolveSecretInputModeForEnvSelection({
        prompter,
        explicitMode: opts.secretInputMode,
        copy: {
          modeMessage: t("wizard.secretInputGatewayPasswordModeQuestion"),
          plaintextLabel: t("wizard.secretInputEnterPasswordNowLabel"),
          plaintextHint: t("wizard.secretInputEnterPasswordNowHint"),
        },
      });
      if (selectedMode === "ref") {
        const resolved = await promptSecretRefForOnboarding({
          provider: "gateway-auth-password",
          config: nextConfig,
          prompter,
          preferredEnvVar: "OPENCLAW_GATEWAY_PASSWORD",
          copy: {
            sourceMessage: t("wizard.secretInputGatewayPasswordSourceQuestion"),
            envVarPlaceholder: "OPENCLAW_GATEWAY_PASSWORD",
          },
        });
        password = resolved.ref;
      } else {
        password = String(
          (await prompter.text({
            message: t("wizard.gatewayPasswordQuestion"),
            validate: validateGatewayPasswordInput,
          })) ?? "",
        ).trim();
      }
    }
    nextConfig = {
      ...nextConfig,
      gateway: {
        ...nextConfig.gateway,
        auth: {
          ...nextConfig.gateway?.auth,
          mode: "password",
          password,
        },
      },
    };
  } else if (authMode === "token") {
    nextConfig = {
      ...nextConfig,
      gateway: {
        ...nextConfig.gateway,
        auth: {
          ...nextConfig.gateway?.auth,
          mode: "token",
          token: gatewayTokenInput,
        },
      },
    };
  }

  nextConfig = {
    ...nextConfig,
    gateway: {
      ...nextConfig.gateway,
      port,
      bind: bind as GatewayBindMode,
      ...(bind === "custom" && customBindHost ? { customBindHost } : {}),
      tailscale: {
        ...nextConfig.gateway?.tailscale,
        mode: tailscaleMode as GatewayTailscaleMode,
        resetOnExit: tailscaleResetOnExit,
      },
    },
  };

  nextConfig = ensureControlUiAllowedOriginsForNonLoopbackBind(nextConfig, {
    requireControlUiEnabled: true,
  }).config;
  nextConfig = await maybeAddTailnetOriginToControlUiAllowedOrigins({
    config: nextConfig,
    tailscaleMode,
    tailscaleBin,
  });

  // If this is a new gateway setup (no existing gateway settings), start with a
  // denylist for high-risk node commands. Users can arm these temporarily via
  // /phone arm ... (phone-control plugin).
  if (
    !quickstartGateway.hasExisting &&
    nextConfig.gateway?.nodes?.denyCommands === undefined &&
    nextConfig.gateway?.nodes?.allowCommands === undefined &&
    nextConfig.gateway?.nodes?.browser === undefined
  ) {
    nextConfig = {
      ...nextConfig,
      gateway: {
        ...nextConfig.gateway,
        nodes: {
          ...nextConfig.gateway?.nodes,
          denyCommands: [...DEFAULT_DANGEROUS_NODE_COMMANDS],
        },
      },
    };
  }

  return {
    nextConfig,
    settings: {
      port,
      bind: bind as GatewayBindMode,
      customBindHost: bind === "custom" ? customBindHost : undefined,
      authMode,
      gatewayToken,
      tailscaleMode: tailscaleMode as GatewayTailscaleMode,
      tailscaleResetOnExit,
    },
  };
}
