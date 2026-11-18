export const TAILSCALE_ROUTE_OWNER_ARG = "--openclaw-tailscale-route-owner";

export type TailscaleRouteOwnerMessage =
  | { type: "spawned"; pid: number }
  | { type: "ready" }
  | { type: "stop-failed"; message: string }
  | {
      type: "failed";
      code: number | null;
      signal: NodeJS.Signals | null;
      stdout: string;
      stderr: string;
    };
