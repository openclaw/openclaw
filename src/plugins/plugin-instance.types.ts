/** Disposal and admission shared by instance resources and registry handles. */
export type PluginInstanceLifecycle = {
  readonly signal: AbortSignal;
  onDispose: (dispose: () => void | Promise<void>) => () => void;
};

/** Execution and host cleanup retain the same instance admission. */
export type PluginInstanceExecution = {
  run<T>(run: () => T): T;
  runCleanup<T>(run: () => T): T;
};

export type PluginInstanceAdmission = {
  readonly lifecycle: PluginInstanceLifecycle;
  run<T>(run: () => T): T;
};

/** Known disposal faults are reported outcomes, never new-call admission failures. */
export type PluginInstanceDisposalResult = { errors: readonly unknown[] };

/** A host-owned logical consumer retains only its exact instance's admitted operations. */
export type PluginInstanceConsumer = {
  wrap<T>(value: T): T;
  run<T>(run: () => T): T;
  close(cleanup: () => void | Promise<void>): Promise<void>;
  release(): void;
};

/** Exact call token and release operation owned by its PluginInstance. */
export type PluginInstanceCallLease = {
  token: object;
  release: () => void | Promise<unknown>;
};

/** An iterator keeps the admission that owns its pending protocol operations. */
export type PluginIteratorAdmission = {
  readonly done: boolean;
  readonly active: boolean;
  invoke: <T>(run: () => T) => T;
  close: () => void;
  call: (key: PropertyKey, method: Function | undefined, args: unknown[]) => Promise<unknown>;
};

/** Inventory custody owns retirement without depending on registry contributions. */
export interface PluginInstanceResource {
  readonly pluginId: string;
  quiesce(): boolean;
  dispose(beforeCleanup?: () => void | Promise<void>): Promise<PluginInstanceDisposalResult>;
}

/** Runtime and setup loaders use the same instance-owned captured source. */
export interface PluginModuleLoaderOwner extends PluginInstanceResource, PluginInstanceAdmission {
  controlPlaneInitialized: boolean;
  bindModuleLoader(
    load: (source: string) => unknown,
    hasSource?: (source: string) => boolean,
  ): void;
  loadModule(source: string): unknown;
  hasModuleSource(source: string): boolean | undefined;
}

/** Current-call helpers retain the instance itself, not a registry or plugin-id lookup. */
export interface PluginInvocationInstance extends PluginModuleLoaderOwner {
  readonly slots: Map<string | symbol, { runtime: unknown }>;
  wrap<T>(value: T): T;
}
