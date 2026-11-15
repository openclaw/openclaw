import fs from "node:fs";
import path from "node:path";

export function writeRegistryPackagePlugin(
  rootDir: string,
  options: {
    configPaths?: readonly string[];
    pluginId?: string;
    requiresPlugins?: readonly string[];
  } = {},
) {
  const pluginId = options.pluginId ?? "demo";
  fs.mkdirSync(rootDir, { recursive: true });
  fs.writeFileSync(path.join(rootDir, "index.ts"), "export default { register() {} };\n", "utf8");
  fs.writeFileSync(
    path.join(rootDir, "openclaw.plugin.json"),
    JSON.stringify({
      id: pluginId,
      name: pluginId,
      description: "one",
      configSchema: { type: "object" },
      ...(options.configPaths ? { activation: { onConfigPaths: options.configPaths } } : {}),
      ...(options.requiresPlugins ? { requiresPlugins: options.requiresPlugins } : {}),
    }),
    "utf8",
  );
  fs.writeFileSync(
    path.join(rootDir, "package.json"),
    JSON.stringify({ name: pluginId, version: "1.0.0" }),
    "utf8",
  );
}
