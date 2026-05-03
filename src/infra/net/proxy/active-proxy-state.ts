export type ActiveManagedProxyRegistration = {
  proxyUrl: string;
  stopped: boolean;
};

let activeProxyUrl: string | undefined;
let activeProxyHandleCount = 0;

export function registerActiveManagedProxyUrl(proxyUrl: string): ActiveManagedProxyRegistration {
  if (activeProxyUrl !== undefined && activeProxyUrl !== proxyUrl) {
    throw new Error(
      "proxy: cannot activate a different managed proxy while another proxy is active; " +
        "stop the current proxy before changing proxy.proxyUrl.",
    );
  }

  activeProxyUrl = proxyUrl;
  activeProxyHandleCount += 1;
  return { proxyUrl, stopped: false };
}

export function stopActiveManagedProxyRegistration(
  registration: ActiveManagedProxyRegistration,
): void {
  if (registration.stopped) {
    return;
  }
  registration.stopped = true;
  if (activeProxyHandleCount > 0) {
    activeProxyHandleCount -= 1;
  }
  if (activeProxyHandleCount === 0) {
    activeProxyUrl = undefined;
  }
}

export function getActiveManagedProxyUrl(): string | undefined {
  return activeProxyUrl;
}

export function _resetActiveManagedProxyStateForTests(): void {
  activeProxyUrl = undefined;
  activeProxyHandleCount = 0;
}
