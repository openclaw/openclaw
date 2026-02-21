import { isTruthyEnvValue } from "../infra/env.js";

export type BrowserControlServer = {
  stop: () => Promise<void>;
};

export async function startBrowserControlServerIfEnabled(): Promise<BrowserControlServer | null> {
  if (isTruthyEnvValue(process.env.OPENCLAW_SKIP_BROWSER_CONTROL_SERVER)) {
    return null;
  }
  // Lazy import: keeps startup fast, but still bundles for the embedded
  // gateway (bun --compile) via the static specifier path.
  const override = process.env.OPENCLAW_BROWSER_CONTROL_MODULE?.trim();
  let mod;
  if (override) {
    // Security: reject non-file specifiers to prevent code injection via .env
    if (/^(data|http|https|node):/.test(override)) {
      throw new Error(
        `Refusing to load browser control module from unsafe specifier: ${override}`
      );
    }
    mod = await import(override);
  } else {
    mod = await import("../browser/control-service.js");
  }
  const start =
    typeof (mod as { startBrowserControlServiceFromConfig?: unknown })
      .startBrowserControlServiceFromConfig === "function"
      ? (mod as { startBrowserControlServiceFromConfig: () => Promise<unknown> })
          .startBrowserControlServiceFromConfig
      : (mod as { startBrowserControlServerFromConfig?: () => Promise<unknown> })
          .startBrowserControlServerFromConfig;
  const stop =
    typeof (mod as { stopBrowserControlService?: unknown }).stopBrowserControlService === "function"
      ? (mod as { stopBrowserControlService: () => Promise<void> }).stopBrowserControlService
      : (mod as { stopBrowserControlServer?: () => Promise<void> }).stopBrowserControlServer;
  if (!start) {
    return null;
  }
  await start();
  return { stop: stop ?? (async () => {}) };
}
