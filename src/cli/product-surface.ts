import {
  CLAWORKS_CLI_NAME,
  isClaworksCliProduct,
  OPENCLAW_CLI_NAME,
  replaceEmbeddedCliNames,
  resolveCliProductEmoji,
  resolveCliProductTitle,
} from "./cli-name.js";

export const CLAWORKS_DEFAULT_GATEWAY_PORT = 18_800;
export const OPENCLAW_DEFAULT_GATEWAY_PORT = 18789;

export function resolveProductCliName(env: NodeJS.ProcessEnv = process.env): string {
  return isClaworksCliProduct(env) ? CLAWORKS_CLI_NAME : OPENCLAW_CLI_NAME;
}

export function resolveProductDisplayName(env: NodeJS.ProcessEnv = process.env): string {
  return resolveCliProductTitle(resolveProductCliName(env));
}

export function resolveProductEmoji(env: NodeJS.ProcessEnv = process.env): string {
  return resolveCliProductEmoji(resolveProductCliName(env));
}

export function resolveProductAsciiTitle(env: NodeJS.ProcessEnv = process.env): string {
  const emoji = resolveProductEmoji(env);
  const title = resolveProductDisplayName(env).toUpperCase();
  return `${emoji} ${title} ${emoji}`;
}

export function resolveProductPlainTitle(env: NodeJS.ProcessEnv = process.env): string {
  return resolveProductDisplayName(env).toUpperCase();
}

export function resolveProductStateDirHint(env: NodeJS.ProcessEnv = process.env): string {
  return isClaworksCliProduct(env) ? "~/.claworks" : "~/.openclaw";
}

export function resolveProductConfigPathHint(env: NodeJS.ProcessEnv = process.env): string {
  return isClaworksCliProduct(env) ? "~/.claworks/claworks.json" : "~/.openclaw/openclaw.json";
}

export function resolveProductDefaultGatewayPort(env: NodeJS.ProcessEnv = process.env): number {
  return isClaworksCliProduct(env) ? CLAWORKS_DEFAULT_GATEWAY_PORT : OPENCLAW_DEFAULT_GATEWAY_PORT;
}

const OPENCLAW_DOCS_BASE = "https://docs.openclaw.ai";
const CLAWORKS_DOCS_BASE = "https://docs.claworks.ai";

export function resolveProductDocsBase(env: NodeJS.ProcessEnv = process.env): string {
  return isClaworksCliProduct(env) ? CLAWORKS_DOCS_BASE : OPENCLAW_DOCS_BASE;
}

export function resolveProductDocUrl(path: string, env: NodeJS.ProcessEnv = process.env): string {
  return `${resolveProductDocsBase(env)}${path}`;
}

export function resolveProductSecurityDocUrl(env: NodeJS.ProcessEnv = process.env): string {
  return resolveProductDocUrl("/gateway/security", env);
}

export function resolveProductSetupIntro(env: NodeJS.ProcessEnv = process.env): string {
  return isClaworksCliProduct(env) ? "ClaWorks setup" : "OpenClaw setup";
}

export function resolveProductDoctorIntro(env: NodeJS.ProcessEnv = process.env): string {
  return isClaworksCliProduct(env) ? "ClaWorks doctor" : "OpenClaw doctor";
}

export function resolveProductConfigureIntro(
  mode: "configure" | "update",
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (!isClaworksCliProduct(env)) {
    return mode === "update" ? "OpenClaw update wizard" : "OpenClaw configure";
  }
  return mode === "update" ? "ClaWorks update wizard" : "ClaWorks configure";
}

export function resolveProductStatusHeading(
  suffix = "status",
  env: NodeJS.ProcessEnv = process.env,
): string {
  return `${resolveProductDisplayName(env)} ${suffix}`;
}

export type ProductGatewayStatusIdentity = {
  id: "claworks" | "openclaw";
  name: "ClaWorks" | "OpenClaw";
  cliName: string;
  emoji: string;
  defaultPort: number;
  configPathHint: string;
  stateDirHint: string;
  launchAgentLabel: string;
};

export function resolveProductGatewayStatusIdentity(
  env: NodeJS.ProcessEnv = process.env,
): ProductGatewayStatusIdentity {
  const claworks = isClaworksCliProduct(env);
  return {
    id: claworks ? "claworks" : "openclaw",
    name: claworks ? "ClaWorks" : "OpenClaw",
    cliName: resolveProductCliName(env),
    emoji: resolveProductEmoji(env),
    defaultPort: resolveProductDefaultGatewayPort(env),
    configPathHint: resolveProductConfigPathHint(env),
    stateDirHint: resolveProductStateDirHint(env),
    launchAgentLabel: claworks ? "ai.claworks.gateway" : "ai.openclaw.gateway",
  };
}

export function resolveProductTuiTitle(env: NodeJS.ProcessEnv = process.env): string {
  return `${resolveProductCliName(env)} tui`;
}

export function resolveProductLocalGatewayWsUrl(env: NodeJS.ProcessEnv = process.env): string {
  return `ws://127.0.0.1:${resolveProductDefaultGatewayPort(env)}`;
}

export function resolveProductLocalGatewayHttpUrl(env: NodeJS.ProcessEnv = process.env): string {
  return `http://127.0.0.1:${resolveProductDefaultGatewayPort(env)}`;
}

/** User-visible wizard/configure copy with ClaWorks port/path/cli substitutions. */
export function productizeUserCopy(value: string, env: NodeJS.ProcessEnv = process.env): string {
  return applyProductSurfaceCopy(value, env);
}

/** Rewrite user-visible strings for ClaWorks product mode. */
export function applyProductSurfaceCopy(
  value: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (!isClaworksCliProduct(env)) {
    return value;
  }
  const product = resolveProductDisplayName(env);
  const port = String(resolveProductDefaultGatewayPort(env));
  const configPath = resolveProductConfigPathHint(env);
  const stateDir = resolveProductStateDirHint(env);

  const cliName = resolveProductCliName(env);

  const result = value
    .replaceAll("OpenClaw setup", resolveProductSetupIntro(env))
    .replaceAll("OpenClaw configure", "ClaWorks configure")
    .replaceAll("OpenClaw update wizard", "ClaWorks update wizard")
    .replaceAll("OpenClaw doctor", resolveProductDoctorIntro(env))
    .replaceAll("OpenClaw status --all", "ClaWorks status --all")
    .replaceAll("OpenClaw status", resolveProductStatusHeading("status", env))
    .replaceAll("openclaw tui", resolveProductTuiTitle(env))
    .replaceAll("OpenClaw 设置", "ClaWorks 设置")
    .replaceAll("OpenClaw 設定", "ClaWorks 設定")
    .replaceAll("~/.openclaw/openclaw.json", configPath)
    .replaceAll(
      "$OPENCLAW_CONFIG_PATH（默认 ~/.openclaw/openclaw.json）",
      `$OPENCLAW_CONFIG_PATH（默认 ${configPath}）`,
    )
    .replaceAll(
      "$OPENCLAW_CONFIG_PATH (default: ~/.openclaw/openclaw.json)",
      `$OPENCLAW_CONFIG_PATH (default: ${configPath})`,
    )
    .replaceAll("ws://127.0.0.1:18789", `ws://127.0.0.1:${port}`)
    .replaceAll("http://127.0.0.1:18789", `http://127.0.0.1:${port}`)
    .replaceAll("http://localhost:18789", `http://localhost:${port}`)
    .replaceAll("for OpenClaw state", "for ClaWorks state")
    .replaceAll("Manage OpenClaw MCP", "Manage ClaWorks MCP")
    .replaceAll("openclaw.json", "claworks.json")
    .replaceAll("~/.openclaw", stateDir)
    .replaceAll("https://docs.openclaw.ai", resolveProductDocsBase(env))
    .replace(/\bOpenClaw\b/g, product);
  return replaceEmbeddedCliNames(result, cliName);
}
