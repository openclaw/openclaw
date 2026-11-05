let reloadLifecycle = new AbortController();

export function beginGatewayReloadLifecycle(): AbortSignal {
  reloadLifecycle.abort();
  reloadLifecycle = new AbortController();
  return reloadLifecycle.signal;
}

/** Signal any in-progress deferred channel reload to abort immediately. */
export function abortPendingChannelReloads(): void {
  reloadLifecycle.abort();
}
