import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const JITI_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".mtsx",
  ".ctsx",
  ".js",
  ".mjs",
  ".cjs",
  ".json",
] as const;

const PLUGIN_SDK_SPECIFIER_PREFIX = "openclaw/plugin-sdk/";

function collectPluginSdkDistAliases(params: {
  modulePath: string;
  root: string;
}): Record<string, string> {
  const sourceText = readFileSync(params.modulePath, "utf8");
  const specifiers = new Set<string>();

  for (const match of sourceText.matchAll(/["'](openclaw\/plugin-sdk(?:\/[^"']+)?)["']/g)) {
    const specifier = match[1];
    if (!specifier?.startsWith(PLUGIN_SDK_SPECIFIER_PREFIX)) {
      continue;
    }
    specifiers.add(specifier);
  }

  return Object.fromEntries(
    Array.from(specifiers, (specifier) => {
      const subpath = specifier.slice(PLUGIN_SDK_SPECIFIER_PREFIX.length);
      return [specifier, path.join(params.root, "dist", "plugin-sdk", `${subpath}.js`)];
    }),
  );
}

export function loadRuntimeApiExportTypesViaJiti(params: {
  modulePath: string;
  exportNames: readonly string[];
  additionalAliases?: Record<string, string>;
}): Record<string, string> {
  const root = process.cwd();
  const alias = {
    ...collectPluginSdkDistAliases({ modulePath: params.modulePath, root }),
    ...params.additionalAliases,
  };

  const script = `
import path from "node:path";
import { createJiti } from "jiti";

const modulePath = ${JSON.stringify(params.modulePath)};
const exportNames = ${JSON.stringify(params.exportNames)};
const alias = ${JSON.stringify(alias)};
const jiti = createJiti(path.join(${JSON.stringify(root)}, "openclaw.mjs"), {
  interopDefault: true,
  tryNative: false,
  fsCache: false,
  moduleCache: false,
  extensions: ${JSON.stringify(JITI_EXTENSIONS)},
  alias,
});
const mod = jiti(modulePath);
console.log(
  JSON.stringify(
    Object.fromEntries(exportNames.map((name) => [name, typeof mod[name]])),
  ),
);
`;

  const raw = execFileSync(process.execPath, ["--input-type=module", "--eval", script], {
    cwd: root,
    encoding: "utf-8",
  });

  return JSON.parse(raw) as Record<string, string>;
}
