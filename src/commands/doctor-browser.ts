import {
  parseBrowserMajorVersion,
  readBrowserVersion,
  resolveGoogleChromeExecutableForPlatform,
} from "../browser/chrome.executables.js";
import type { OpenClawConfig } from "../config/config.js";
import { note } from "../terminal/note.js";

const CHROME_MCP_MIN_MAJOR = 144;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function collectChromeMcpProfileNames(cfg: OpenClawConfig): string[] {
  const browser = asRecord(cfg.browser);
  if (!browser) {
    return [];
  }

  const names = new Set<string>();
  const defaultProfile =
    typeof browser.defaultProfile === "string" ? browser.defaultProfile.trim() : "";
  if (defaultProfile === "user") {
    names.add("user");
  }

  const profiles = asRecord(browser.profiles);
  if (!profiles) {
    return [...names];
  }

  for (const [profileName, rawProfile] of Object.entries(profiles)) {
    const profile = asRecord(rawProfile);
    const driver = typeof profile?.driver === "string" ? profile.driver.trim() : "";
    if (driver === "existing-session") {
      names.add(profileName);
    }
  }

  return [...names].toSorted((a, b) => a.localeCompare(b));
}

export async function noteChromeMcpBrowserReadiness(
  cfg: OpenClawConfig,
  deps?: {
    platform?: NodeJS.Platform;
    noteFn?: typeof note;
    resolveChromeExecutable?: (platform: NodeJS.Platform) => { path: string } | null;
    readVersion?: (executablePath: string) => string | null;
  },
) {
  const profiles = collectChromeMcpProfileNames(cfg);
  if (profiles.length === 0) {
    return;
  }

  const noteFn = deps?.noteFn ?? note;
  const platform = deps?.platform ?? process.platform;
  const resolveChromeExecutable =
    deps?.resolveChromeExecutable ?? resolveGoogleChromeExecutableForPlatform;
  const readVersion = deps?.readVersion ?? readBrowserVersion;
  const chrome = resolveChromeExecutable(platform);
  const profileLabel = profiles.join(", ");

  if (!chrome) {
    noteFn(
      [
        `- Chrome MCP existing-session is configured for profile(s): ${profileLabel}.`,
        "- Google Chrome was not found on this host. OpenClaw does not bundle Chrome.",
        `- Install Google Chrome ${CHROME_MCP_MIN_MAJOR}+ on the same host as the Gateway or node.`,
        "- In Chrome, enable remote debugging at chrome://inspect/#remote-debugging.",
        "- Keep Chrome running and accept the attach consent prompt the first time OpenClaw connects.",
        "- Docker, headless, and sandbox browser flows stay on raw CDP; this check only applies to host-local Chrome MCP attach.",
      ].join("\n"),
      "Browser",
    );
    return;
  }

  const versionRaw = readVersion(chrome.path);
  const major = parseBrowserMajorVersion(versionRaw);
  const lines = [
    `- Chrome MCP existing-session is configured for profile(s): ${profileLabel}.`,
    `- Chrome path: ${chrome.path}`,
  ];

  if (!versionRaw || major === null) {
    lines.push(
      `- Could not determine the installed Chrome version. Chrome MCP requires Google Chrome ${CHROME_MCP_MIN_MAJOR}+ on this host.`,
    );
  } else if (major < CHROME_MCP_MIN_MAJOR) {
    lines.push(
      `- Detected Chrome ${versionRaw}, which is too old for Chrome MCP existing-session attach. Upgrade to Chrome ${CHROME_MCP_MIN_MAJOR}+.`,
    );
  } else {
    lines.push(`- Detected Chrome ${versionRaw}.`);
  }

  lines.push("- In Chrome, enable remote debugging at chrome://inspect/#remote-debugging.");
  lines.push(
    "- Keep Chrome running and accept the attach consent prompt the first time OpenClaw connects.",
  );

  noteFn(lines.join("\n"), "Browser");
}
