import type { DaemonLifecycleOptions } from "./types.js";
import { loadConfig } from "../../config/io.js";
import { resolveGatewayPort, resolveIsNixMode } from "../../config/paths.js";
import { resolveGatewayService } from "../../daemon/service.js";
import { renderSystemdUnavailableHints } from "../../daemon/systemd-hints.js";
import { isSystemdUserServiceAvailable } from "../../daemon/systemd.js";
import { inspectPortUsage } from "../../infra/ports.js";
import { isWSL } from "../../infra/wsl.js";
import { defaultRuntime } from "../../runtime.js";
import { buildDaemonServiceSnapshot, createNullWriter, emitDaemonActionJson } from "./response.js";
import { renderGatewayServiceStartHints } from "./shared.js";

export async function runDaemonUninstall(opts: DaemonLifecycleOptions = {}) {
  const json = Boolean(opts.json);
  const stdout = json ? createNullWriter() : process.stdout;
  const emit = (payload: {
    ok: boolean;
    result?: string;
    message?: string;
    error?: string;
    service?: {
      label: string;
      loaded: boolean;
      loadedText: string;
      notLoadedText: string;
    };
  }) => {
    if (!json) {
      return;
    }
    emitDaemonActionJson({ action: "uninstall", ...payload });
  };
  const fail = (message: string) => {
    if (json) {
      emit({ ok: false, error: message });
    } else {
      defaultRuntime.error(message);
    }
    defaultRuntime.exit(1);
  };

  if (resolveIsNixMode(process.env)) {
    fail("Nix mode detected; service uninstall is disabled.");
    return;
  }

  const service = resolveGatewayService();
  let loaded = false;
  try {
    loaded = await service.isLoaded({ env: process.env });
  } catch {
    loaded = false;
  }
  if (loaded) {
    try {
      await service.stop({ env: process.env, stdout });
    } catch {
      // Best-effort stop; final loaded check gates success.
    }
  }
  try {
    await service.uninstall({ env: process.env, stdout });
  } catch (err) {
    fail(`Gateway uninstall failed: ${String(err)}`);
    return;
  }

  loaded = false;
  try {
    loaded = await service.isLoaded({ env: process.env });
  } catch {
    loaded = false;
  }
  if (loaded) {
    fail("Gateway service still loaded after uninstall.");
    return;
  }
  emit({
    ok: true,
    result: "uninstalled",
    service: buildDaemonServiceSnapshot(service, loaded),
  });
}

export async function runDaemonStart(opts: DaemonLifecycleOptions = {}) {
  const json = Boolean(opts.json);
  const stdout = json ? createNullWriter() : process.stdout;
  const emit = (payload: {
    ok: boolean;
    result?: string;
    message?: string;
    error?: string;
    hints?: string[];
    service?: {
      label: string;
      loaded: boolean;
      loadedText: string;
      notLoadedText: string;
    };
  }) => {
    if (!json) {
      return;
    }
    emitDaemonActionJson({ action: "start", ...payload });
  };
  const fail = (message: string, hints?: string[]) => {
    if (json) {
      emit({ ok: false, error: message, hints });
    } else {
      defaultRuntime.error(message);
    }
    defaultRuntime.exit(1);
  };

  const service = resolveGatewayService();
  let loaded = false;
  try {
    loaded = await service.isLoaded({ env: process.env });
  } catch (err) {
    fail(`Gateway service check failed: ${String(err)}`);
    return;
  }
  if (!loaded) {
    let hints = renderGatewayServiceStartHints();
    if (process.platform === "linux") {
      const systemdAvailable = await isSystemdUserServiceAvailable().catch(() => false);
      if (!systemdAvailable) {
        hints = [...hints, ...renderSystemdUnavailableHints({ wsl: await isWSL() })];
      }
    }
    emit({
      ok: true,
      result: "not-loaded",
      message: `Gateway service ${service.notLoadedText}.`,
      hints,
      service: buildDaemonServiceSnapshot(service, loaded),
    });
    if (!json) {
      defaultRuntime.log(`Gateway service ${service.notLoadedText}.`);
      for (const hint of hints) {
        defaultRuntime.log(`Start with: ${hint}`);
      }
    }
    return;
  }
  try {
    await service.restart({ env: process.env, stdout });
  } catch (err) {
    const hints = renderGatewayServiceStartHints();
    fail(`Gateway start failed: ${String(err)}`, hints);
    return;
  }

  let started = true;
  try {
    started = await service.isLoaded({ env: process.env });
  } catch {
    started = true;
  }
  emit({
    ok: true,
    result: "started",
    service: buildDaemonServiceSnapshot(service, started),
  });
}

/**
 * Try to stop a gateway process by finding it on the configured port.
 * Used as a fallback when no daemon service (systemd/launchd) is loaded,
 * or to clean up orphan processes after a daemon stop.
 */
async function tryStopGatewayByPort(): Promise<{ message: string } | null> {
  try {
    let cfg;
    try {
      cfg = loadConfig();
    } catch {
      cfg = undefined;
    }
    const port = resolveGatewayPort(cfg);
    const usage = await inspectPortUsage(port);
    if (usage.status !== "busy") {
      return null;
    }
    const gatewayListeners = usage.listeners.filter((l) => {
      const raw = `${l.commandLine ?? ""} ${l.command ?? ""}`.toLowerCase();
      return raw.includes("openclaw");
    });
    if (gatewayListeners.length === 0) {
      return null;
    }

    for (const listener of gatewayListeners) {
      if (!listener.pid) continue;
      try {
        process.kill(listener.pid, "SIGTERM");
      } catch {
        // Process may have already exited (ESRCH)
      }
    }

    const pids = gatewayListeners.map((l) => l.pid).filter(Boolean);
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const check = await inspectPortUsage(port);
      const still = check.listeners.filter((l) => l.pid && pids.includes(l.pid));
      if (still.length === 0) {
        break;
      }
      await new Promise((r) => setTimeout(r, 200));
    }

    const pidStr = pids.join(", ");
    return {
      message: `Stopped gateway process${pids.length > 1 ? "es" : ""} (pid ${pidStr}) on port ${port}.`,
    };
  } catch {
    return null;
  }
}

export async function runDaemonStop(opts: DaemonLifecycleOptions = {}) {
  const json = Boolean(opts.json);
  const stdout = json ? createNullWriter() : process.stdout;
  const emit = (payload: {
    ok: boolean;
    result?: string;
    message?: string;
    error?: string;
    service?: {
      label: string;
      loaded: boolean;
      loadedText: string;
      notLoadedText: string;
    };
  }) => {
    if (!json) {
      return;
    }
    emitDaemonActionJson({ action: "stop", ...payload });
  };
  const fail = (message: string) => {
    if (json) {
      emit({ ok: false, error: message });
    } else {
      defaultRuntime.error(message);
    }
    defaultRuntime.exit(1);
  };

  const service = resolveGatewayService();
  let loaded = false;
  try {
    loaded = await service.isLoaded({ env: process.env });
  } catch (err) {
    fail(`Gateway service check failed: ${String(err)}`);
    return;
  }
  if (!loaded) {
    // Fallback: try to stop gateway by port when no daemon service is active
    const portStop = await tryStopGatewayByPort();
    if (portStop) {
      emit({
        ok: true,
        result: "stopped",
        message: portStop.message,
      });
      if (!json) {
        defaultRuntime.log(portStop.message);
      }
      return;
    }
    emit({
      ok: true,
      result: "not-loaded",
      message: `Gateway service ${service.notLoadedText}.`,
      service: buildDaemonServiceSnapshot(service, loaded),
    });
    if (!json) {
      defaultRuntime.log(`Gateway service ${service.notLoadedText}.`);
    }
    return;
  }
  try {
    await service.stop({ env: process.env, stdout });
  } catch (err) {
    fail(`Gateway stop failed: ${String(err)}`);
    return;
  }

  // Also stop any orphan gateway process not managed by the daemon
  await tryStopGatewayByPort();

  let stopped = false;
  try {
    stopped = await service.isLoaded({ env: process.env });
  } catch {
    stopped = false;
  }
  emit({
    ok: true,
    result: "stopped",
    service: buildDaemonServiceSnapshot(service, stopped),
  });
}

/**
 * Restart the gateway service service.
 * @returns `true` if restart succeeded, `false` if the service was not loaded.
 * Throws/exits on check or restart failures.
 */
export async function runDaemonRestart(opts: DaemonLifecycleOptions = {}): Promise<boolean> {
  const json = Boolean(opts.json);
  const stdout = json ? createNullWriter() : process.stdout;
  const emit = (payload: {
    ok: boolean;
    result?: string;
    message?: string;
    error?: string;
    hints?: string[];
    service?: {
      label: string;
      loaded: boolean;
      loadedText: string;
      notLoadedText: string;
    };
  }) => {
    if (!json) {
      return;
    }
    emitDaemonActionJson({ action: "restart", ...payload });
  };
  const fail = (message: string, hints?: string[]) => {
    if (json) {
      emit({ ok: false, error: message, hints });
    } else {
      defaultRuntime.error(message);
    }
    defaultRuntime.exit(1);
  };

  const service = resolveGatewayService();
  let loaded = false;
  try {
    loaded = await service.isLoaded({ env: process.env });
  } catch (err) {
    fail(`Gateway service check failed: ${String(err)}`);
    return false;
  }
  if (!loaded) {
    let hints = renderGatewayServiceStartHints();
    if (process.platform === "linux") {
      const systemdAvailable = await isSystemdUserServiceAvailable().catch(() => false);
      if (!systemdAvailable) {
        hints = [...hints, ...renderSystemdUnavailableHints({ wsl: await isWSL() })];
      }
    }
    emit({
      ok: true,
      result: "not-loaded",
      message: `Gateway service ${service.notLoadedText}.`,
      hints,
      service: buildDaemonServiceSnapshot(service, loaded),
    });
    if (!json) {
      defaultRuntime.log(`Gateway service ${service.notLoadedText}.`);
      for (const hint of hints) {
        defaultRuntime.log(`Start with: ${hint}`);
      }
    }
    return false;
  }
  try {
    await service.restart({ env: process.env, stdout });
    let restarted = true;
    try {
      restarted = await service.isLoaded({ env: process.env });
    } catch {
      restarted = true;
    }
    emit({
      ok: true,
      result: "restarted",
      service: buildDaemonServiceSnapshot(service, restarted),
    });
    return true;
  } catch (err) {
    const hints = renderGatewayServiceStartHints();
    fail(`Gateway restart failed: ${String(err)}`, hints);
    return false;
  }
}
