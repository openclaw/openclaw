import type { EnvironmentSummary } from "@openclaw/gateway-protocol";
import { t } from "../../i18n/index.ts";
import { registerSystemsEnglish } from "../../i18n/locales/en-systems.ts";
import type { RuntimeConfigCapability } from "../../lib/config/runtime-config-capability.ts";
import { formatUiError } from "../../lib/format-error.ts";

registerSystemsEnglish();

/** Config authority needed to turn Host Desktop on; hosts without it only point to an administrator. */
export type HostDesktopRuntimeConfig = Pick<
  RuntimeConfigCapability,
  "canPatch" | "ensureLoaded" | "patch"
> & { state: Pick<RuntimeConfigCapability["state"], "lastError"> };

export function isAutomaticSource(source: string): boolean {
  return source === "pending" || source === "resolved";
}

export function isAutoPicker(
  source: string,
  embedded: boolean,
  sessionKey: string | null,
): boolean {
  return isAutomaticSource(source) && embedded && sessionKey !== null;
}

/** Title and hint i18n keys for the Gateway host's Desktop setup state. */
export function hostDesktopSetupCopy(
  state: string | undefined,
  mac: boolean,
  enabled: boolean,
): { title: string; hint: string } {
  const ready = state === "ready" || state === "managed";
  return {
    title: enabled
      ? "systems.desktopSetupEnabled"
      : ([
          ["managed", "systems.managedDesktopConfigured"],
          ["ready", mac ? "systems.screenSharingDetected" : "systems.desktopDetected"],
          ["needs-server", mac ? "systems.screenSharingNeeded" : "systems.desktopServerNeeded"],
        ].find(([kind]) => kind === state)?.[1] ?? "systems.desktopSetupAttention"),
    hint: enabled
      ? "systems.desktopSetupConnecting"
      : ready
        ? "systems.desktopSetupEnableHint"
        : mac && state === "needs-server"
          ? "systems.screenSharingSetupHint"
          : "systems.desktopServerSetupHint",
  };
}

/** Resolves null when applied, an error message when not, and undefined when superseded. */
export async function enableHostDesktop(
  runtimeConfig: HostDesktopRuntimeConfig,
  note: string,
  canDispatch: () => boolean,
): Promise<string | null | undefined> {
  try {
    await runtimeConfig.ensureLoaded();
    if (!canDispatch()) {
      return undefined;
    }
    const patched = await runtimeConfig.patch({
      raw: { desktop: { host: { enabled: true } } },
      note,
      canDispatch,
    });
    return patched ? null : (runtimeConfig.state.lastError ?? t("systems.desktopSetupFailed"));
  } catch (error) {
    return formatUiError(error);
  }
}

export type DesktopHostSetup = {
  environment: EnvironmentSummary;
  canEnable: boolean;
  busy: boolean;
  error: string | null;
  onEnable: () => void;
  onCheckAgain: () => void;
};

/** Owns the Gateway host's Host Desktop setup offer for one automatic panel. */
export function createDesktopHostSetupOwner(host: {
  readonly runtimeConfig: HostDesktopRuntimeConfig | null;
  requestUpdate: () => void;
  refreshHostDesktop: () => void;
}) {
  let environment: EnvironmentSummary | null = null;
  let busy = false;
  let error: string | null = null;
  // Leaving the target or connecting supersedes an enable; inventory refreshes do not.
  let generation = 0;

  async function enable(): Promise<void> {
    const runtimeConfig = host.runtimeConfig;
    if (!runtimeConfig || runtimeConfig.canPatch !== true || busy) {
      return;
    }
    const current = generation;
    const isCurrent = () => current === generation && host.runtimeConfig === runtimeConfig;
    busy = true;
    error = null;
    host.requestUpdate();
    const failure = await enableHostDesktop(
      runtimeConfig,
      "desktop: enable host desktop",
      isCurrent,
    );
    if (!isCurrent()) {
      return;
    }
    busy = false;
    error = typeof failure === "string" ? failure : null;
    host.requestUpdate();
    if (failure === null) {
      // Retest so the Gateway desktop connects now that the host reports it.
      host.refreshHostDesktop();
    }
  }

  return {
    set(next: EnvironmentSummary | null): void {
      environment = next;
    },
    clear(): void {
      generation += 1;
      environment = null;
      busy = false;
      error = null;
    },
    view(): DesktopHostSetup | null {
      return environment
        ? {
            environment,
            canEnable: host.runtimeConfig?.canPatch === true,
            busy,
            error,
            onEnable: () => void enable(),
            onCheckAgain: host.refreshHostDesktop,
          }
        : null;
    },
  };
}
