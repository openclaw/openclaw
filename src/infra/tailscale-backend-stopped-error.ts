// A proven inactive daemon is an external startup prerequisite, not a channel crash.
export const TAILSCALE_BACKEND_STOPPED_REASON = "gateway.tailscale_backend_stopped";

export class TailscaleBackendStoppedError extends Error {
  readonly code = TAILSCALE_BACKEND_STOPPED_REASON;

  constructor() {
    super(
      "Tailscale is stopped. Restore the intended Tailscale connection before restarting the Gateway; managed ingress remains required.",
    );
    this.name = "TailscaleBackendStoppedError";
  }
}
