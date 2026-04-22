import type { ExtensionFactory } from "@mariozechner/pi-coding-agent";

export const PI_EMBEDDED_EXTENSION_RUNTIME_ID = "pi";

export type RegisteredEmbeddedExtensionFactory = {
  factory: ExtensionFactory;
  ownerPluginId?: string;
};

const EMBEDDED_EXTENSION_FACTORY_REGISTRY_STATE = Symbol.for(
  "openclaw.embeddedExtensionFactoryRegistryState",
);

type EmbeddedExtensionFactoryRegistryState = {
  factories: RegisteredEmbeddedExtensionFactory[];
};

function getEmbeddedExtensionFactoryRegistryState(): EmbeddedExtensionFactoryRegistryState {
  const globalState = globalThis as typeof globalThis & {
    [EMBEDDED_EXTENSION_FACTORY_REGISTRY_STATE]?: EmbeddedExtensionFactoryRegistryState;
  };
  if (!globalState[EMBEDDED_EXTENSION_FACTORY_REGISTRY_STATE]) {
    globalState[EMBEDDED_EXTENSION_FACTORY_REGISTRY_STATE] = {
      factories: [],
    };
  }
  return globalState[EMBEDDED_EXTENSION_FACTORY_REGISTRY_STATE];
}

export function registerEmbeddedExtensionFactory(
  factory: ExtensionFactory,
  options?: { ownerPluginId?: string },
): void {
  getEmbeddedExtensionFactoryRegistryState().factories.push({
    factory,
    ownerPluginId: options?.ownerPluginId,
  });
}

export function listEmbeddedExtensionFactories(): ExtensionFactory[] {
  return getEmbeddedExtensionFactoryRegistryState().factories.map((entry) => entry.factory);
}

export function listRegisteredEmbeddedExtensionFactories(): RegisteredEmbeddedExtensionFactory[] {
  return getEmbeddedExtensionFactoryRegistryState().factories.slice();
}

export function clearEmbeddedExtensionFactories(): void {
  getEmbeddedExtensionFactoryRegistryState().factories = [];
}

export function restoreRegisteredEmbeddedExtensionFactories(
  entries: RegisteredEmbeddedExtensionFactory[],
): void {
  getEmbeddedExtensionFactoryRegistryState().factories = entries.slice();
}
