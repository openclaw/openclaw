// Shared CLI catalog contracts are independent of catalog entries and policy values.
type CliConfigGuardMode = "run" | "skip" | "validate" | "defer";
export type CliPluginRegistryScope =
  | "all"
  | "channels"
  | "configured-channels"
  | "memory"
  | "sandbox-backends"
  | "sandbox-management";
export type CliNetworkProxyPolicy = "default" | "bypass";

export type CliCommandPathPolicy = {
  configGuard:
    | CliConfigGuardMode
    | ((ctx: {
        argv: string[];
        commandPath: string[];
        options?: Readonly<Record<string, unknown>>;
      }) => CliConfigGuardMode);
  stateStoreGuard: "run" | "skip";
  loadPlugins:
    | "never"
    | "always"
    | ((ctx: { argv: string[]; commandPath: string[]; jsonOutputMode: boolean }) => boolean);
  pluginRegistry: {
    scope: CliPluginRegistryScope;
  };
  ownsProtocolStdout: boolean;
  hideBanner: boolean;
  ensureCliPath: boolean;
  networkProxy:
    | CliNetworkProxyPolicy
    | ((ctx: { argv: string[]; commandPath: string[] }) => CliNetworkProxyPolicy);
};

export type CliCommandCatalogEntry = {
  commandPath: readonly string[];
  exact?: boolean;
  policy?: Partial<CliCommandPathPolicy>;
  route?: {
    id:
      | "health"
      | "status"
      | "gateway-health"
      | "gateway-status"
      | "sessions"
      | "agents-list"
      | "config-get"
      | "config-unset"
      | "models-list"
      | "models-status"
      | "channels-list"
      | "channels-status"
      | "plugins-list";
  };
};
