import type { OpenClawConfig } from "./config-types.js";
import { loadBundledPluginPublicSurfaceModuleSync } from "./facade-loader.js";

/**
 * @deprecated Compatibility type for the `openclaw/plugin-sdk/telegram-account` facade.
 * New channel plugins should prefer injected runtime helpers and generic SDK subpaths.
 */
export type TelegramAccountConfig = NonNullable<
  NonNullable<OpenClawConfig["channels"]>["telegram"]
>;

/**
 * @deprecated Compatibility type for the `openclaw/plugin-sdk/telegram-account` facade.
 * New channel plugins should prefer injected runtime helpers and generic SDK subpaths.
 */
export type ResolvedTelegramAccount = {
  /** Canonical account id after default-account resolution. */
  accountId: string;
  /** Whether the resolved account should participate in runtime startup and sends. */
  enabled: boolean;
  /** Optional display name from account config. */
  name?: string;
  /** Bot token value after config/env/token-file resolution. */
  token: string;
  /** Source used to populate `token`; `"none"` means no usable token was found. */
  tokenSource: "env" | "tokenFile" | "config" | "none";
  /** Merged Telegram account config including inherited channel-level defaults. */
  config: TelegramAccountConfig;
};

type TelegramAccountFacadeModule = {
  resolveTelegramAccount: (params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
  }) => ResolvedTelegramAccount;
};

function loadTelegramAccountFacadeModule(): TelegramAccountFacadeModule {
  // Keep this compatibility subpath as a lazy facade so importing it does not eagerly load
  // Telegram runtime code unless a legacy caller asks for account resolution.
  return loadBundledPluginPublicSurfaceModuleSync<TelegramAccountFacadeModule>({
    dirName: "telegram",
    artifactBasename: "api.js",
  });
}

/**
 * @deprecated Compatibility facade for plugin code that needs Telegram account resolution.
 * New channel plugins should prefer injected runtime helpers and generic SDK subpaths.
 */
export function resolveTelegramAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedTelegramAccount {
  return loadTelegramAccountFacadeModule().resolveTelegramAccount(params);
}
