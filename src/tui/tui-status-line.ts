import { Container, Loader, Text, type TUI } from "@earendil-works/pi-tui";
import { isTuiBusyActivityStatus } from "./tui-activity-status.js";
import { buildWaitingStatusMessage, defaultWaitingPhrases } from "./tui-waiting.js";

type StatusTheme = {
  dim: (s: string) => string;
  bold: (s: string) => string;
  accent: (s: string) => string;
  accentSoft: (s: string) => string;
};

export function formatElapsed(startMs: number) {
  const totalSeconds = Math.max(0, Math.floor((Date.now() - startMs) / 1000));
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  return `${Math.floor(totalSeconds / 60)}m ${totalSeconds % 60}s`;
}

/** Owns the status row: animated loader while busy, plain text otherwise. */
export function createTuiStatusLine(deps: {
  tui: TUI;
  container: Container;
  theme: StatusTheme;
  getActivity: () => string;
  getConnection: () => string;
}) {
  const { tui, container, theme } = deps;
  let text: Text | null = null;
  let loader: Loader | null = null;
  let timer: NodeJS.Timeout | null = null;
  let intervalMs = 0;
  let startedAt: number | null = null;
  let lastActivity = "idle";
  let tick = 0;
  let phrase: string | null = null;

  const updateBusyMessage = () => {
    if (!loader || !startedAt) {
      return;
    }
    const elapsed = formatElapsed(startedAt);
    if (deps.getActivity() === "waiting") {
      tick++;
      loader.setMessage(
        buildWaitingStatusMessage({
          theme,
          tick,
          elapsed,
          connectionStatus: deps.getConnection(),
          phrases: phrase ? [phrase] : undefined,
        }),
      );
      return;
    }
    loader.setMessage(`${deps.getActivity()} • ${elapsed} | ${deps.getConnection()}`);
  };

  const stopTimer = () => {
    clearInterval(timer ?? undefined);
    timer = null;
    intervalMs = 0;
    phrase = null;
  };

  const startTimer = (waiting: boolean) => {
    const next = waiting ? 120 : 1000;
    if (intervalMs === next) {
      return;
    }
    stopTimer();
    if (waiting) {
      const idx = Math.floor(Math.random() * defaultWaitingPhrases.length);
      phrase = defaultWaitingPhrases[idx] ?? defaultWaitingPhrases[0] ?? "waiting";
      tick = 0;
    }
    intervalMs = next;
    timer = setInterval(() => {
      const activity = deps.getActivity();
      if (waiting ? activity === "waiting" : isTuiBusyActivityStatus(activity)) {
        updateBusyMessage();
      }
    }, next);
  };

  const stopLoader = () => {
    loader?.stop();
    loader = null;
  };

  return {
    showBusy() {
      const activity = deps.getActivity();
      if (!startedAt || lastActivity !== activity) {
        startedAt = Date.now();
      }
      lastActivity = activity;
      if (!loader) {
        container.clear();
        text = null;
        loader = new Loader(
          tui,
          (spinner) => theme.accent(spinner),
          (t) => theme.bold(theme.accentSoft(t)),
          "",
        );
        container.addChild(loader);
      }
      startTimer(activity === "waiting");
      updateBusyMessage();
    },
    showStatic() {
      startedAt = null;
      lastActivity = deps.getActivity();
      stopTimer();
      stopLoader();
      if (!text) {
        container.clear();
        text = new Text("", 1, 0);
        container.addChild(text);
      }
      const activity = deps.getActivity();
      const connection = deps.getConnection();
      text.setText(theme.dim(activity ? `${connection} | ${activity}` : connection));
    },
    dispose() {
      stopTimer();
      stopLoader();
    },
  };
}
