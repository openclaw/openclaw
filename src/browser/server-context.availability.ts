import {
  PROFILE_ATTACH_RETRY_TIMEOUT_MS,
  PROFILE_POST_RESTART_WS_TIMEOUT_MS,
  resolveCdpReachabilityTimeouts,
} from "./cdp-timeouts.js";
import {
  isChromeCdpReady,
  isChromeReachable,
  launchOpenClawChrome,
  stopOpenClawChrome,
} from "./chrome.js";
import type { ResolvedBrowserProfile } from "./config.js";
import { BrowserConfigurationError, BrowserProfileUnavailableError } from "./errors.js";
import {
  ensureChromeExtensionRelayServer,
  stopChromeExtensionRelayServer,
} from "./extension-relay.js";
import { getBrowserProfileCapabilities } from "./profile-capabilities.js";
import {
  CDP_READY_AFTER_LAUNCH_MAX_TIMEOUT_MS,
  CDP_READY_AFTER_LAUNCH_MIN_TIMEOUT_MS,
  CDP_READY_AFTER_LAUNCH_POLL_MS,
  CDP_READY_AFTER_LAUNCH_WINDOW_MS,
} from "./server-context.constants.js";
import type {
  BrowserServerState,
  ContextOptions,
  ProfileRuntimeState,
} from "./server-context.types.js";

type AvailabilityDeps = {
  opts: ContextOptions;
  profile: ResolvedBrowserProfile;
  state: () => BrowserServerState;
  getProfileState: () => ProfileRuntimeState;
  setProfileRunning: (running: ProfileRuntimeState["running"]) => void;
};

type AvailabilityOps = {
  isHttpReachable: (timeoutMs?: number) => Promise<boolean>;
  isReachable: (timeoutMs?: number) => Promise<boolean>;
  ensureBrowserAvailable: () => Promise<void>;
  stopRunningBrowser: () => Promise<{ stopped: boolean }>;
};

export function createProfileAvailability({
  opts,
  profile,
  state,
  getProfileState,
  setProfileRunning,
}: AvailabilityDeps): AvailabilityOps {
  const capabilities = getBrowserProfileCapabilities(profile);
  const resolveTimeouts = (timeoutMs: number | undefined) =>
    resolveCdpReachabilityTimeouts({
      profileIsLoopback: profile.cdpIsLoopback,
      timeoutMs,
      remoteHttpTimeoutMs: state().resolved.remoteCdpTimeoutMs,
      remoteHandshakeTimeoutMs: state().resolved.remoteCdpHandshakeTimeoutMs,
    });

  const isReachable = async (timeoutMs?: number) => {
    const { httpTimeoutMs, wsTimeoutMs } = resolveTimeouts(timeoutMs);
    return await isChromeCdpReady(profile.cdpUrl, httpTimeoutMs, wsTimeoutMs);
  };

  const isHttpReachable = async (timeoutMs?: number) => {
    const { httpTimeoutMs } = resolveTimeouts(timeoutMs);
    return await isChromeReachable(profile.cdpUrl, httpTimeoutMs);
  };

  const attachRunning = (running: NonNullable<ProfileRuntimeState["running"]>) => {
    setProfileRunning(running);
    running.proc.on("exit", () => {
      // Guard against server teardown (e.g., SIGUSR1 restart)
      if (!opts.getState()) {
        return;
      }
      const profileState = getProfileState();
      if (profileState.running?.pid === running.pid) {
        setProfileRunning(null);
      }
    });
  };

  const closePlaywrightBrowserConnectionForProfile = async (cdpUrl?: string): Promise<void> => {
    try {
      const mod = await import("./pw-ai.js");
      await mod.closePlaywrightBrowserConnection(cdpUrl ? { cdpUrl } : undefined);
    } catch {
      // ignore
    }
  };

  const reconcileProfileRuntime = async (): Promise<void> => {
    const profileState = getProfileState();
    const reconcile = profileState.reconcile;
    if (!reconcile) {
      return;
    }
    profileState.reconcile = null;
    profileState.lastTargetId = null;

    const previousProfile = reconcile.previousProfile;
    if (profileState.running) {
      await stopOpenClawChrome(profileState.running).catch(() => {});
      setProfileRunning(null);
    }
    if (previousProfile.driver === "extension") {
      await stopChromeExtensionRelayServer({ cdpUrl: previousProfile.cdpUrl }).catch(() => false);
    }
    await closePlaywrightBrowserConnectionForProfile(previousProfile.cdpUrl);
    if (previousProfile.cdpUrl !== profile.cdpUrl) {
      await closePlaywrightBrowserConnectionForProfile(profile.cdpUrl);
    }
  };

  const waitForCdpReadyAfterLaunch = async (): Promise<void> => {
    // launchOpenClawChrome() can return before Chrome is fully ready to serve /json/version + CDP WS.
    // If a follow-up call races ahead, we can hit PortInUseError trying to launch again on the same port.
    const deadlineMs = Date.now() + CDP_READY_AFTER_LAUNCH_WINDOW_MS;
    while (Date.now() < deadlineMs) {
      const remainingMs = Math.max(0, deadlineMs - Date.now());
      // Keep each attempt short; loopback profiles derive a WS timeout from this value.
      const attemptTimeoutMs = Math.max(
        CDP_READY_AFTER_LAUNCH_MIN_TIMEOUT_MS,
        Math.min(CDP_READY_AFTER_LAUNCH_MAX_TIMEOUT_MS, remainingMs),
      );
      if (await isReachable(attemptTimeoutMs)) {
        return;
      }
      await new Promise((r) => setTimeout(r, CDP_READY_AFTER_LAUNCH_POLL_MS));
    }
    throw new Error(
      `Chrome CDP websocket for profile "${profile.name}" is not reachable after start.`,
    );
  };

  const ensureBrowserAvailable = async (): Promise<void> => {
    await reconcileProfileRuntime();
    const current = state();
    const remoteCdp = capabilities.isRemote;
    const attachOnly = profile.attachOnly;
    const isExtension = capabilities.requiresRelay;
    const profileState = getProfileState();
    const httpReachable = await isHttpReachable();

    if (isExtension && remoteCdp) {
      throw new BrowserConfigurationError(
        `Profile "${profile.name}" uses driver=extension but cdpUrl is not loopback (${profile.cdpUrl}).`,
      );
    }

    if (isExtension) {
      if (!httpReachable) {
        await ensureChromeExtensionRelayServer({
          cdpUrl: profile.cdpUrl,
          bindHost: current.resolved.relayBindHost,
        });
        if (!(await isHttpReachable(PROFILE_ATTACH_RETRY_TIMEOUT_MS))) {
          throw new BrowserProfileUnavailableError(
            `Chrome extension relay for profile "${profile.name}" is not reachable at ${profile.cdpUrl}.`,
          );
        }
      }
      // Browser startup should only ensure relay availability.
      // Tab attachment is checked when a tab is actually required.
      return;
    }

    if (!httpReachable) {
      if ((attachOnly || remoteCdp) && opts.onEnsureAttachTarget) {
        await opts.onEnsureAttachTarget(profile);
        if (await isHttpReachable(PROFILE_ATTACH_RETRY_TIMEOUT_MS)) {
          return;
        }
      }
      if (attachOnly || remoteCdp) {
        throw new BrowserProfileUnavailableError(
          remoteCdp
            ? `Remote CDP for profile "${profile.name}" is not reachable at ${profile.cdpUrl}.`
            : `Browser attachOnly is enabled and profile "${profile.name}" is not running.`,
        );
      }
      const launched = await launchOpenClawChrome(current.resolved, profile);
      attachRunning(launched);
      try {
        await waitForCdpReadyAfterLaunch();
      } catch (err) {
        await stopOpenClawChrome(launched).catch(() => {});
        setProfileRunning(null);
        throw err;
      }
      return;
    }

    // Port is reachable - check if we own it.
    if (await isReachable()) {
      return;
    }

    // HTTP responds but WebSocket fails. For attachOnly/remote profiles, never perform
    // local ownership/restart handling; just run attach retries and surface attach errors.
    if (attachOnly || remoteCdp) {
      if (opts.onEnsureAttachTarget) {
        await opts.onEnsureAttachTarget(profile);
        if (await isReachable(PROFILE_ATTACH_RETRY_TIMEOUT_MS)) {
          return;
        }
      }
      throw new BrowserProfileUnavailableError(
        remoteCdp
          ? `Remote CDP websocket for profile "${profile.name}" is not reachable.`
          : `Browser attachOnly is enabled and CDP websocket for profile "${profile.name}" is not reachable.`,
      );
    }

    // HTTP responds but WebSocket fails - port in use by something else.
    if (!profileState.running) {
      throw new BrowserProfileUnavailableError(
        `Port ${profile.cdpPort} is in use for profile "${profile.name}" but not by openclaw. ` +
          `Run action=reset-profile profile=${profile.name} to kill the process.`,
      );
    }

    await stopOpenClawChrome(profileState.running);
    setProfileRunning(null);

    const relaunched = await launchOpenClawChrome(current.resolved, profile);
    attachRunning(relaunched);

    if (!(await isReachable(PROFILE_POST_RESTART_WS_TIMEOUT_MS))) {
      throw new Error(
        `Chrome CDP websocket for profile "${profile.name}" is not reachable after restart.`,
      );
    }
  };

  const stopRunningBrowser = async (): Promise<{ stopped: boolean }> => {
    await reconcileProfileRuntime();
    if (capabilities.requiresRelay) {
      const stopped = await stopChromeExtensionRelayServer({
        cdpUrl: profile.cdpUrl,
      });
      return { stopped };
    }
    const profileState = getProfileState();
    if (!profileState.running) {
      return { stopped: false };
    }
    await stopOpenClawChrome(profileState.running);
    setProfileRunning(null);
    return { stopped: true };
  };

  return {
    isHttpReachable,
    isReachable,
    ensureBrowserAvailable,
    stopRunningBrowser,
  };
}
