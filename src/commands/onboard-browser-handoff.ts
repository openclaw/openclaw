// Browser-first guided onboarding handoff: open or print the dashboard, then
// wait for the Control UI client to prove it connected to the Gateway.
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../../packages/gateway-protocol/src/client-info.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { callGateway } from "../gateway/call.js";
import { resolveGatewayCredentialsWithSecretInputs } from "../gateway/credentials-secret-inputs.js";
import { openUrlPrivately } from "../infra/browser-handoff.js";
import type { SystemPresence } from "../infra/system-presence.js";
import { monotonicNow } from "../shared/monotonic-time.js";
import { sleep } from "../utils.js";
import { t } from "../wizard/i18n/index.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import {
  hasVerifiedControlUiLoopbackAlias,
  issueControlUiBrowserHandoff,
  resolveControlUiHandoffTarget,
  waitForControlUiDocument,
  type ControlUiHandoffTarget,
} from "./control-ui-handoff.js";
import {
  detectBrowserOpenSupport,
  formatControlUiSshHint,
  resolveAdvertisedControlUiLinks,
} from "./onboard-helpers.js";

const GUI_HANDOFF_TIMEOUT_MS = 60_000;
const HEADLESS_HANDOFF_TIMEOUT_MS = 300_000;
const HANDOFF_POLL_INTERVAL_MS = 1_000;
const HANDOFF_PROBE_TIMEOUT_MS = 5_000;

type BrowserHatchTarget = {
  config: OpenClawConfig;
  links: ControlUiHandoffTarget["links"];
  documentUrl: string;
  sshHint?: string;
  port: number;
  loopbackAliasHost?: string;
  tlsConfig?: ControlUiHandoffTarget["tlsConfig"];
  token?: string;
  password?: string;
};

function isConnectedControlUi(entry: SystemPresence): boolean {
  return (
    entry.host === GATEWAY_CLIENT_IDS.CONTROL_UI &&
    entry.mode === GATEWAY_CLIENT_MODES.WEBCHAT &&
    entry.reason !== "disconnect"
  );
}

async function probeDashboardPresence(
  target: BrowserHatchTarget,
  timeoutMs: number,
): Promise<string[] | null> {
  try {
    // Read presence over the same trusted local CLI path every `openclaw`
    // command uses. A raw shared-auth call with a (possibly SecretRef-managed)
    // token is rejected as an unpaired Control UI client with "device identity
    // required"; the CLI-mode loopback client is granted operator.read instead.
    const presence = await callGateway<SystemPresence[]>({
      config: target.config,
      method: "system-presence",
      timeoutMs,
      clientName: GATEWAY_CLIENT_NAMES.CLI,
      mode: GATEWAY_CLIENT_MODES.CLI,
      // Present the shared secret when one is configured (token-auth gateways
      // reject a token-less local connect); SecretRef/none gateways fall back to
      // trusted-loopback auth with no token.
      ...(target.token ? { token: target.token } : {}),
      ...(target.password ? { password: target.password } : {}),
      expectFinal: false,
      ignoreEnvUrlOverride: true,
    });
    return (presence ?? [])
      .filter(isConnectedControlUi)
      .map((entry) => [entry.deviceId, entry.instanceId, entry.host, entry.mode].join("\0"));
  } catch {
    return null;
  }
}

export async function resolveOnboardingDashboardTarget(
  dashboardUrl: string,
  config: OpenClawConfig,
  agentId?: string,
): Promise<{ url: URL; setupOnly: boolean }> {
  const url = new URL(dashboardUrl);
  const [{ resolveConfiguredSetupModelForAgent }, { resolveSystemAgentOnboardingTarget }] =
    await Promise.all([import("../agents/utility-model.js"), import("./onboard-agent-target.js")]);
  const setupOnly =
    resolveConfiguredSetupModelForAgent({
      cfg: config,
      agentId: agentId ?? resolveSystemAgentOnboardingTarget(config).agentId,
    })?.modelTarget === "utility";
  if (setupOnly) {
    url.pathname = `${url.pathname.replace(/\/$/, "")}/custodian`;
    url.searchParams.set("onboarding", "1");
  } else if (agentId) {
    url.searchParams.set("session", `agent:${agentId}:main`);
  }
  return { url, setupOnly };
}

/** Opens or prints the dashboard and waits for its Control UI client connection. */
export async function runBrowserHatchHandoff(params: {
  config: OpenClawConfig;
  prompter: WizardPrompter;
  suppressTokenOutput?: boolean;
  agentId?: string;
}): Promise<boolean> {
  const env = process.env;
  if (params.suppressTokenOutput === true || params.config.gateway?.controlUi?.enabled === false) {
    return false;
  }
  const browserSupport = await detectBrowserOpenSupport();
  const canOpenBrowser = browserSupport.ok;
  let target: BrowserHatchTarget;
  try {
    const config = params.config;
    const shared = await resolveControlUiHandoffTarget({ config, env });
    const credentials = await resolveGatewayCredentialsWithSecretInputs({
      config,
      env,
      modeOverride: "local",
    });
    const authMode =
      !config.gateway?.auth?.mode && credentials.password ? "password" : shared.authMode;
    const token = authMode === "token" ? credentials.token : undefined;
    const setupAuthValue = authMode === "password" ? credentials.password : undefined;
    target = {
      config,
      links: shared.links,
      documentUrl: shared.documentUrl,
      port: shared.port,
      ...(shared.loopbackAliasHost ? { loopbackAliasHost: shared.loopbackAliasHost } : {}),
      ...(shared.tlsConfig ? { tlsConfig: shared.tlsConfig } : {}),
      ...(shared.bind === "loopback" || shared.tlsConfig?.enabled !== true
        ? {
            sshHint: formatControlUiSshHint({
              port: shared.port,
              ...(shared.basePath ? { basePath: shared.basePath } : {}),
              tlsEnabled: shared.tlsConfig?.enabled === true,
            }),
          }
        : {}),
      ...(token ? { token } : {}),
    };
    if (setupAuthValue) {
      target["password"] = setupAuthValue;
    }
  } catch {
    return false;
  }

  if (!(await hasVerifiedControlUiLoopbackAlias(target))) {
    return false;
  }

  let progress: ReturnType<WizardPrompter["progress"]> | undefined;
  try {
    const document = await waitForControlUiDocument({
      url: target.documentUrl,
      tlsConfig: target.tlsConfig,
      onPending: () => {
        progress = params.prompter.progress(t("wizard.guided.controlUiPreparing"));
      },
    });
    if (!document.ready) {
      return false;
    }
  } catch {
    return false;
  } finally {
    progress?.stop();
  }

  const baseline = await probeDashboardPresence(target, HANDOFF_PROBE_TIMEOUT_MS);
  if (!baseline) {
    return false;
  }

  let browserUrl: string;
  try {
    const browserHandoff = await issueControlUiBrowserHandoff(target.links);
    const { url } = await resolveOnboardingDashboardTarget(
      browserHandoff.browserUrl,
      params.config,
      params.agentId,
    );
    browserUrl = url.toString();
  } catch {
    return false;
  }

  let opened = false;
  if (canOpenBrowser) {
    try {
      // The handoff URL carries the one-time pairing credential in its
      // fragment. Open it through a private file handoff so the credential
      // never appears in a browser-opener process argument, where another
      // OS user could read it from /proc on default procfs hosts.
      opened = await openUrlPrivately(browserUrl);
    } catch {
      opened = false;
    }
  }
  if (opened) {
    await params.prompter.note(
      t("wizard.guided.browserHandoffOpening"),
      t("wizard.guided.browserHandoffTitle"),
    );
  } else {
    const bind = target.config.gateway?.bind;
    const remoteBind = bind === "lan" || bind === "tailnet" || bind === "custom";
    const remoteSession = Boolean(
      env.SSH_CLIENT ||
      env.SSH_TTY ||
      env.SSH_CONNECTION ||
      env.REMOTE_CONTAINERS ||
      env.CODESPACES,
    );
    // Plain HTTP on a remote host cannot create the device identity required by
    // the Control UI. Keep those browsers on a tunneled localhost secure context.
    const directRemoteDisplay = remoteBind && target.tlsConfig?.enabled === true;
    const tunnelHint =
      !directRemoteDisplay && (!canOpenBrowser || remoteSession)
        ? (target.sshHint ??
          (remoteBind
            ? formatControlUiSshHint({
                port: target.port,
                ...(target.config.gateway?.controlUi?.basePath
                  ? { basePath: target.config.gateway.controlUi.basePath }
                  : {}),
                tlsEnabled: target.tlsConfig?.enabled === true,
              })
            : undefined))
        : undefined;
    const sshHint = tunnelHint ? `\n\n${tunnelHint}` : "";
    const visibleLinks = directRemoteDisplay
      ? await resolveAdvertisedControlUiLinks({
          bind,
          port: target.port,
          customBindHost: target.config.gateway?.customBindHost,
          basePath: target.config.gateway?.controlUi?.basePath,
          tlsEnabled: target.tlsConfig?.enabled === true,
        })
      : target.links;
    const issued = new URL(browserUrl);
    const visible = new URL(visibleLinks.httpUrl);
    const fragment = new URLSearchParams(issued.hash.slice(1));
    fragment.set("gatewayUrl", visibleLinks.wsUrl);
    visible.pathname = issued.pathname;
    visible.search = issued.search;
    visible.hash = fragment.toString();
    const visibleUrl = visible.toString();
    await params.prompter.note(
      `${t("wizard.guided.browserHandoffCopy", { url: visibleUrl })}${sshHint}`,
      t("wizard.guided.browserHandoffTitle"),
    );
  }

  const baselineClientKeys = new Set(baseline);
  const deadline = monotonicNow() + (opened ? GUI_HANDOFF_TIMEOUT_MS : HEADLESS_HANDOFF_TIMEOUT_MS);
  while (true) {
    const beforeProbeMs = deadline - monotonicNow();
    if (beforeProbeMs <= 0) {
      return false;
    }
    const result = await probeDashboardPresence(
      target,
      Math.min(HANDOFF_PROBE_TIMEOUT_MS, beforeProbeMs),
    );
    if (!result) {
      return false;
    }
    if (result.some((key) => !baselineClientKeys.has(key))) {
      break;
    }
    const remainingMs = deadline - monotonicNow();
    if (remainingMs <= 0) {
      return false;
    }
    await sleep(Math.min(HANDOFF_POLL_INTERVAL_MS, remainingMs));
  }
  await params.prompter.note(
    t("wizard.guided.browserHandoffContinuing"),
    t("wizard.guided.browserHandoffTitle"),
  );
  return true;
}
