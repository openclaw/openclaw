export function formatTailscaleOverviewValue(params: {
  tailscaleMode: string;
  tailscaleDns: string | null;
  tailscaleHttpsUrl: string | null;
  tailscaleBackendState: string | null;
  muted: (value: string) => string;
  warn: (value: string) => string;
}): string {
  const { tailscaleMode, tailscaleDns, tailscaleHttpsUrl, tailscaleBackendState, muted, warn } =
    params;
  const backend = tailscaleBackendState ?? "unknown";

  if (tailscaleMode === "off") {
    if (backend === "Running" || tailscaleDns) {
      return ["active", "mode off", tailscaleBackendState ? backend : null, tailscaleDns]
        .filter(Boolean)
        .join(" · ");
    }
    return muted("off");
  }

  if (tailscaleDns && tailscaleHttpsUrl) {
    return [tailscaleMode, backend, tailscaleDns, tailscaleHttpsUrl].join(" · ");
  }

  return warn(`${tailscaleMode} · ${backend} · magicdns unknown`);
}
