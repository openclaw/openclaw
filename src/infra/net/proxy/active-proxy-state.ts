export type ActiveManagedProxyUrl = Readonly<URL>;

export type ActiveManagedProxyRegistration = {
  proxyUrl: ActiveManagedProxyUrl;
  stopped: boolean;
};

let activeProxyUrl: ActiveManagedProxyUrl | undefined;

export function registerActiveManagedProxyUrl(proxyUrl: URL): ActiveManagedProxyRegistration {
  if (activeProxyUrl !== undefined) {
    throw new Error(
      "proxy: cannot activate a managed proxy while another proxy is active; " +
        "stop the current proxy before changing proxy.proxyUrl.",
    );
  }

  activeProxyUrl = new URL(proxyUrl.href);
  return { proxyUrl: activeProxyUrl, stopped: false };
}

export function stopActiveManagedProxyRegistration(
  registration: ActiveManagedProxyRegistration,
): void {
  if (registration.stopped) {
    return;
  }
  registration.stopped = true;
  if (activeProxyUrl?.href === registration.proxyUrl.href) {
    activeProxyUrl = undefined;
  }
}

export function getActiveManagedProxyUrl(): ActiveManagedProxyUrl | undefined {
  return activeProxyUrl;
}

export function _resetActiveManagedProxyStateForTests(): void {
  activeProxyUrl = undefined;
}
