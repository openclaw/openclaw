// Shared CLI catalog contracts are independent of catalog entries and policy values.
export type CliCommandPluginLoadPolicy =
  | "never"
  | "always"
  | "text-only"
  | ((ctx: { argv: string[]; commandPath: string[]; jsonOutputMode: boolean }) => boolean);
type CliConfigGuardMode = "run" | "skip" | "validate" | "when-suppressed";
type CliConfigGuardPolicy =
  | CliConfigGuardMode
  | ((ctx: { argv: string[]; commandPath: string[] }) => CliConfigGuardMode);
export type CliPluginRegistryScope =
  | "all"
  | "channels"
  | "configured-channels"
  | "memory"
  | "sandbox-backends"
  | "sandbox-management";
export type CliNetworkProxyPolicy = "default" | "bypass";
type CliNetworkProxyPolicyResolver =
  | CliNetworkProxyPolicy
  | ((ctx: { argv: string[]; commandPath: string[] }) => CliNetworkProxyPolicy);
type CliRoutedCommandId =
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
  | "tasks-list"
  | "tasks-audit"
  | "channels-list"
  | "channels-status"
  | "plugins-list";

export type CliCommandPathPolicy = {
  configGuard: CliConfigGuardPolicy;
  stateStoreGuard: "run" | "skip";
  loadPlugins: CliCommandPluginLoadPolicy;
  pluginRegistry: {
    scope: CliPluginRegistryScope;
  };
  ownsProtocolStdout: boolean;
  hideBanner: boolean;
  ensureCliPath: boolean;
  networkProxy: CliNetworkProxyPolicyResolver;
};

export type CliCommandCatalogEntry = {
  commandPath: readonly string[];
  exact?: boolean;
  policy?: Partial<CliCommandPathPolicy>;
  route?: {
    id: CliRoutedCommandId;
  };
};
