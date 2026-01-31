import { readConfigFileSnapshot, resolveGatewayPort } from "../config/config.js";
import { copyToClipboard } from "../infra/clipboard.js";
import type { RuntimeEnv } from "../runtime.js";
import { defaultRuntime } from "../runtime.js";
import { detectBrowserOpenSupport, openUrl } from "./onboard-helpers.js";

const COMPANION_PORT = 5174;

type CompanionOptions = {
  noOpen?: boolean;
};

export async function companionCommand(
  runtime: RuntimeEnv = defaultRuntime,
  options: CompanionOptions = {},
) {
  const snapshot = await readConfigFileSnapshot();
  const cfg = snapshot.valid ? snapshot.config : {};
  const gwPort = resolveGatewayPort(cfg);
  const token = cfg.gateway?.auth?.token ?? process.env.OPENCLAW_GATEWAY_TOKEN ?? "";

  const params = new URLSearchParams();
  if (token) params.set("token", token);
  params.set("gatewayUrl", `ws://127.0.0.1:${gwPort}`);
  const url = `http://localhost:${COMPANION_PORT}?${params.toString()}`;

  runtime.log(`Companion URL: ${url}`);

  const copied = await copyToClipboard(url).catch(() => false);
  runtime.log(copied ? "Copied to clipboard." : "Copy to clipboard unavailable.");

  if (!options.noOpen) {
    const browserSupport = await detectBrowserOpenSupport();
    if (browserSupport.ok) {
      const opened = await openUrl(url);
      if (opened) {
        runtime.log("Opened Companion in your browser.");
        return;
      }
    }
  }

  runtime.log("Open the URL above in your browser.");
}
