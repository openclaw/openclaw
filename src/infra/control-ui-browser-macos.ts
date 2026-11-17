import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { runExec } from "../process/exec.js";
import type {
  ControlUiBrowserDiscovery,
  ControlUiBrowserInstallation,
} from "./control-ui-browser.js";

const BROWSERS = [
  { id: "com.google.Chrome", app: "Google Chrome.app", family: "chrome", name: "Chrome" },
  { id: "org.mozilla.firefox", app: "Firefox.app", family: "firefox", name: "Firefox" },
  { id: "com.microsoft.edgemac", app: "Microsoft Edge.app", family: "edge", name: "Edge" },
  { id: "com.apple.Safari", app: "Safari.app", family: "safari", name: "Safari" },
] as const;

/** AppKit reads registrations and bundle metadata without sending events to a browser. */
export async function discoverMacControlUiBrowsers(): Promise<ControlUiBrowserDiscovery> {
  const script = [
    'ObjC.import("AppKit"); ObjC.import("Foundation");',
    "var workspace = $.NSWorkspace.sharedWorkspace;",
    "var result = [];",
    "function describe(url, isDefault) {",
    "  try {",
    "    var appPath = ObjC.unwrap(url.path);",
    "    if (!appPath) return;",
    "    var bundle = $.NSBundle.bundleWithURL(url);",
    "    result.push({id: ObjC.unwrap(bundle.bundleIdentifier), path: appPath,",
    '      version: ObjC.unwrap(bundle.objectForInfoDictionaryKey("CFBundleShortVersionString")) || "",',
    "      isDefault: isDefault});",
    "  } catch (_) {}",
    "}",
    'describe(workspace.URLForApplicationToOpenURL($.NSURL.URLWithString("https://localhost/")), true);',
    "var specs = " + JSON.stringify(BROWSERS) + ";",
    "specs.forEach(function(spec) {",
    "  try {",
    "    var urls = workspace.URLsForApplicationsWithBundleIdentifier(spec.id);",
    "    for (var i = 0; i < Math.min(Number(urls.count), 8); i++) describe(urls.objectAtIndex(i), false);",
    "  } catch (_) {}",
    '  ["/Applications/", ObjC.unwrap($.NSHomeDirectory()) + "/Applications/"].forEach(function(root) {',
    "    describe($.NSURL.fileURLWithPath(root + spec.app), false);",
    "  });",
    "});",
    "JSON.stringify(result);",
  ].join("\n");
  const { stdout } = await runExec("/usr/bin/osascript", ["-l", "JavaScript", "-e", script], {
    timeoutMs: 3_000,
    maxBuffer: 64 * 1024,
    logOutput: false,
  });
  const inventory: unknown = JSON.parse(stdout);
  if (!Array.isArray(inventory) || inventory.length > 41) {
    return { alternatives: [] };
  }
  let defaultBrowser: ControlUiBrowserInstallation | undefined;
  const alternatives: ControlUiBrowserInstallation[] = [];
  for (const item of inventory) {
    if (
      !isRecord(item) ||
      typeof item.path !== "string" ||
      typeof item.version !== "string" ||
      !path.posix.isAbsolute(item.path) ||
      !item.path.endsWith(".app") ||
      /[\r\n]/.test(item.path) ||
      item.path.includes("\0")
    ) {
      continue;
    }
    const spec = BROWSERS.find((browser) => browser.id === item.id);
    if (!spec) {
      continue;
    }
    const browser: ControlUiBrowserInstallation = {
      family: spec.family,
      name: spec.name,
      version: item.version,
      command: ["/usr/bin/open", "-a", item.path],
    };
    if (item.isDefault === true) {
      defaultBrowser = browser;
    }
    if (!alternatives.some((existing) => existing.command[2] === item.path)) {
      alternatives.push(browser);
    }
  }
  alternatives.sort((a, b) => {
    const family =
      BROWSERS.findIndex((spec) => spec.family === a.family) -
      BROWSERS.findIndex((spec) => spec.family === b.family);
    return family || (a.command[2]! < b.command[2]! ? -1 : a.command[2] === b.command[2] ? 0 : 1);
  });
  return { defaultBrowser, alternatives };
}
