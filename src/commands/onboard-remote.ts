import type { OpenClawConfig } from "../config/config.js";
import type { SecretInput } from "../config/types.secrets.js";
import { isSecureWebSocketUrl } from "../gateway/net.js";
import { cliT } from "../i18n/cli.js";
import type { GatewayBonjourBeacon } from "../infra/bonjour-discovery.js";
import { discoverGatewayBeacons } from "../infra/bonjour-discovery.js";
import { resolveWideAreaDiscoveryDomain } from "../infra/widearea-dns.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import { detectBinary } from "./onboard-helpers.js";
import type { SecretInputMode } from "./onboard-types.js";

const DEFAULT_GATEWAY_URL = "ws://127.0.0.1:18789";

function pickHost(beacon: GatewayBonjourBeacon): string | undefined {
  // Security: TXT is unauthenticated. Prefer the resolved service endpoint host.
  return beacon.host || beacon.tailnetDns || beacon.lanHost;
}

function buildLabel(
  beacon: GatewayBonjourBeacon,
  t: (key: Parameters<typeof cliT>[0], vars?: Record<string, string | number>) => string,
): string {
  const host = pickHost(beacon);
  // Security: Prefer the resolved service endpoint port.
  const port = beacon.port ?? beacon.gatewayPort ?? 18789;
  const title = beacon.displayName ?? beacon.instanceName;
  const hint = host ? `${host}:${port}` : t("wizard.remoteHostUnknown");
  return `${title} (${hint})`;
}

function ensureWsUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return DEFAULT_GATEWAY_URL;
  }
  return trimmed;
}

function validateGatewayWebSocketUrl(
  value: string,
  t: (key: Parameters<typeof cliT>[0], vars?: Record<string, string | number>) => string,
): string | undefined {
  const trimmed = value.trim();
  if (!trimmed.startsWith("ws://") && !trimmed.startsWith("wss://")) {
    return t("wizard.remoteWsUrlMustStartError");
  }
  if (
    !isSecureWebSocketUrl(trimmed, {
      allowPrivateWs: process.env.OPENCLAW_ALLOW_INSECURE_PRIVATE_WS === "1",
    })
  ) {
    return t("wizard.remoteWsUrlSecurityError");
  }
  return undefined;
}

export async function promptRemoteGatewayConfig(
  cfg: OpenClawConfig,
  prompter: WizardPrompter,
  options?: { secretInputMode?: SecretInputMode },
): Promise<OpenClawConfig> {
  const t = (key: Parameters<typeof cliT>[0], vars?: Record<string, string | number>) =>
    cliT(key, process.env, vars);
  let selectedBeacon: GatewayBonjourBeacon | null = null;
  let suggestedUrl = cfg.gateway?.remote?.url ?? DEFAULT_GATEWAY_URL;

  const hasBonjourTool = (await detectBinary("dns-sd")) || (await detectBinary("avahi-browse"));
  const wantsDiscover = hasBonjourTool
    ? await prompter.confirm({
        message: t("wizard.remoteDiscoverLanQuestion"),
        initialValue: true,
      })
    : false;

  if (!hasBonjourTool) {
    await prompter.note(t("wizard.discoveryRequirementBody"), t("wizard.discoveryTitle"));
  }

  if (wantsDiscover) {
    const wideAreaDomain = resolveWideAreaDiscoveryDomain({
      configDomain: cfg.discovery?.wideArea?.domain,
    });
    const spin = prompter.progress(t("wizard.discoverySearchingProgress"));
    const beacons = await discoverGatewayBeacons({ timeoutMs: 2000, wideAreaDomain });
    spin.stop(
      beacons.length > 0
        ? t("wizard.discoveryFoundProgress", { count: beacons.length })
        : t("wizard.discoveryNoneProgress"),
    );

    if (beacons.length > 0) {
      const selection = await prompter.select({
        message: t("wizard.remoteSelectGatewayQuestion"),
        options: [
          ...beacons.map((beacon, index) => ({
            value: String(index),
            label: buildLabel(beacon, t),
          })),
          { value: "manual", label: t("wizard.remoteEnterUrlManuallyLabel") },
        ],
      });
      if (selection !== "manual") {
        const idx = Number.parseInt(String(selection), 10);
        selectedBeacon = Number.isFinite(idx) ? (beacons[idx] ?? null) : null;
      }
    }
  }

  if (selectedBeacon) {
    const host = pickHost(selectedBeacon);
    const port = selectedBeacon.port ?? selectedBeacon.gatewayPort ?? 18789;
    if (host) {
      const mode = await prompter.select({
        message: t("wizard.remoteConnectionMethodQuestion"),
        options: [
          {
            value: "direct",
            label: t("wizard.remoteConnectionDirectLabel", { host, port }),
          },
          { value: "ssh", label: t("wizard.remoteConnectionSshLabel") },
        ],
      });
      if (mode === "direct") {
        suggestedUrl = `wss://${host}:${port}`;
        await prompter.note(
          [
            t("wizard.remoteDirectDefaultsToTlsLine"),
            t("wizard.remoteDirectUsingLine", { url: suggestedUrl }),
            t("wizard.remoteDirectLoopbackHintLine"),
          ].join("\n"),
          t("wizard.directRemoteTitle"),
        );
      } else {
        suggestedUrl = DEFAULT_GATEWAY_URL;
        await prompter.note(
          [
            t("wizard.remoteSshStartTunnelLine"),
            `ssh -N -L 18789:127.0.0.1:18789 <user>@${host}${
              selectedBeacon.sshPort ? ` -p ${selectedBeacon.sshPort}` : ""
            }`,
            t("wizard.remoteSshDocsLine"),
          ].join("\n"),
          t("wizard.sshTunnelTitle"),
        );
      }
    }
  }

  const urlInput = await prompter.text({
    message: t("wizard.remoteGatewayWsUrlQuestion"),
    initialValue: suggestedUrl,
    validate: (value) => validateGatewayWebSocketUrl(String(value), t),
  });
  const url = ensureWsUrl(String(urlInput));

  const authChoice = await prompter.select({
    message: t("wizard.remoteGatewayAuthQuestion"),
    options: [
      { value: "token", label: t("wizard.remoteGatewayAuthTokenRecommendedLabel") },
      { value: "password", label: t("wizard.remoteGatewayAuthPasswordLabel") },
      { value: "off", label: t("wizard.remoteGatewayAuthOffLabel") },
    ],
  });

  let token: SecretInput | undefined = cfg.gateway?.remote?.token;
  let password: SecretInput | undefined = cfg.gateway?.remote?.password;
  if (authChoice === "token") {
    const { promptSecretRefForOnboarding, resolveSecretInputModeForEnvSelection } =
      await import("./auth-choice.apply-helpers.js");
    const selectedMode = await resolveSecretInputModeForEnvSelection({
      prompter,
      explicitMode: options?.secretInputMode,
      copy: {
        modeMessage: t("wizard.secretInputGatewayTokenModeQuestion"),
        plaintextLabel: t("wizard.secretInputEnterTokenNowLabel"),
        plaintextHint: t("wizard.secretInputEnterTokenNowHint"),
      },
    });
    if (selectedMode === "ref") {
      const resolved = await promptSecretRefForOnboarding({
        provider: "gateway-remote-token",
        config: cfg,
        prompter,
        preferredEnvVar: "OPENCLAW_GATEWAY_TOKEN",
        copy: {
          sourceMessage: t("wizard.secretInputGatewayTokenSourceQuestion"),
          envVarPlaceholder: "OPENCLAW_GATEWAY_TOKEN",
        },
      });
      token = resolved.ref;
    } else {
      token = String(
        await prompter.text({
          message: t("wizard.remoteGatewayTokenQuestion"),
          initialValue: typeof token === "string" ? token : undefined,
          validate: (value) => (value?.trim() ? undefined : t("wizard.requiredFieldError")),
        }),
      ).trim();
    }
    password = undefined;
  } else if (authChoice === "password") {
    const { promptSecretRefForOnboarding, resolveSecretInputModeForEnvSelection } =
      await import("./auth-choice.apply-helpers.js");
    const selectedMode = await resolveSecretInputModeForEnvSelection({
      prompter,
      explicitMode: options?.secretInputMode,
      copy: {
        modeMessage: t("wizard.secretInputRemoteGatewayPasswordModeQuestion"),
        plaintextLabel: t("wizard.secretInputEnterPasswordNowLabel"),
        plaintextHint: t("wizard.secretInputEnterPasswordNowHint"),
      },
    });
    if (selectedMode === "ref") {
      const resolved = await promptSecretRefForOnboarding({
        provider: "gateway-remote-password",
        config: cfg,
        prompter,
        preferredEnvVar: "OPENCLAW_GATEWAY_PASSWORD",
        copy: {
          sourceMessage: t("wizard.secretInputRemoteGatewayPasswordSourceQuestion"),
          envVarPlaceholder: "OPENCLAW_GATEWAY_PASSWORD",
        },
      });
      password = resolved.ref;
    } else {
      password = String(
        await prompter.text({
          message: t("wizard.remoteGatewayPasswordQuestion"),
          initialValue: typeof password === "string" ? password : undefined,
          validate: (value) => (value?.trim() ? undefined : t("wizard.requiredFieldError")),
        }),
      ).trim();
    }
    token = undefined;
  } else {
    token = undefined;
    password = undefined;
  }

  return {
    ...cfg,
    gateway: {
      ...cfg.gateway,
      mode: "remote",
      remote: {
        url,
        ...(token !== undefined ? { token } : {}),
        ...(password !== undefined ? { password } : {}),
      },
    },
  };
}
