import type { GatewayBrowserClient } from "../gateway.ts";

export type TerminalState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  terminalLoading: boolean;
  terminalError: string | null;
  terminalSessions: Array<{ name: string; windows: number; attached: boolean }>;
  terminalNewSessionName: string;
  terminalActionBusy: boolean;
  terminalPollInterval: number | null;
};

function parseTmuxSessions(
  raw: string,
): Array<{ name: string; windows: number; attached: boolean }> {
  const sessions: Array<{ name: string; windows: number; attached: boolean }> = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    const parts = trimmed.split("|");
    if (parts.length >= 3) {
      sessions.push({
        name: parts[0] ?? "",
        windows: parseInt(parts[1] ?? "0", 10) || 0,
        attached: parts[2]?.trim() === "1",
      });
    }
  }
  return sessions;
}

async function execRun(
  client: GatewayBrowserClient,
  command: string,
  args: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const res = await client.request("exec.run", { command, args });
  const p = res as { stdout?: string; stderr?: string; exitCode?: number; output?: string };
  return {
    stdout: p.stdout ?? p.output ?? "",
    stderr: p.stderr ?? "",
    exitCode: p.exitCode ?? 0,
  };
}

const TMUX_LIST_CMD =
  "tmux list-sessions -F '#{session_name}|#{session_windows}|#{session_attached}' 2>/dev/null || " +
  "tmux -S /tmp/openclaw-tmux-sockets/openclaw.sock list-sessions " +
  "-F '#{session_name}|#{session_windows}|#{session_attached}' 2>/dev/null || echo ''";

export async function loadTerminalSessions(state: TerminalState) {
  if (!state.client || !state.connected) {
    return;
  }
  if (state.terminalLoading) {
    return;
  }
  state.terminalLoading = true;
  state.terminalError = null;
  try {
    const { stdout } = await execRun(state.client, "sh", ["-c", TMUX_LIST_CMD]);
    state.terminalSessions = parseTmuxSessions(stdout);
  } catch (err) {
    state.terminalError = String(err);
    state.terminalSessions = [];
  } finally {
    state.terminalLoading = false;
  }
}

export async function createTerminalSession(state: TerminalState, name: string) {
  if (!state.client || !state.connected) {
    return;
  }
  const trimmed = name.trim();
  if (!trimmed) {
    return;
  }
  state.terminalActionBusy = true;
  state.terminalError = null;
  try {
    await execRun(state.client, "tmux", ["new-session", "-d", "-s", trimmed]);
    state.terminalNewSessionName = "";
    await loadTerminalSessions(state);
  } catch (err) {
    state.terminalError = String(err);
  } finally {
    state.terminalActionBusy = false;
  }
}

export async function killTerminalSession(state: TerminalState, name: string) {
  if (!state.client || !state.connected) {
    return;
  }
  state.terminalActionBusy = true;
  state.terminalError = null;
  try {
    await execRun(state.client, "tmux", ["kill-session", "-t", name]);
    await loadTerminalSessions(state);
  } catch (err) {
    state.terminalError = String(err);
  } finally {
    state.terminalActionBusy = false;
  }
}

export function startTerminalPolling(state: TerminalState) {
  if (state.terminalPollInterval != null) {
    return;
  }
  state.terminalPollInterval = window.setInterval(() => {
    void loadTerminalSessions(state);
  }, 8_000) as unknown as number;
}

export function stopTerminalPolling(state: TerminalState) {
  if (state.terminalPollInterval == null) {
    return;
  }
  clearInterval(state.terminalPollInterval);
  state.terminalPollInterval = null;
}
