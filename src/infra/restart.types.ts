export type RestartAttempt = {
  ok: boolean;
  method: "launchctl" | "systemd" | "schtasks" | "supervisor" | "sigusr1";
  detail?: string;
  tried?: string[];
};
