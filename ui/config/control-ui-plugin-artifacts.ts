import path from "node:path";

/** Runtime source; TypeScript consumes the producer's generated public declarations. */
export function controlUiPluginArtifactAliases(root: string) {
  return [
    {
      find: /^@openclaw\/([^/]+)\/(control-ui(?:-[^/]+)?)\.js$/u,
      replacement: path.join(root, "extensions", "$1", "$2.ts"),
    },
  ];
}
