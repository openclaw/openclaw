export type RestartAttempt = {
  ok: boolean;
  method: "launchctl" | "systemd" | "schtasks" | "supervisor";
  detail?: string;
  tried?: string[];
};

export type GatewayRestartIntent = {
  reason?: string;
  force?: boolean;
  waitMs?: number;
};
