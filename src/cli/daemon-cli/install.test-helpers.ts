export function nodeProbeOutput(nodeVersion: string, sqliteVersion = "3.53.4") {
  return {
    stdout: JSON.stringify({
      nodeVersion,
      sqliteVersion,
      sqliteProbe: { available: true, version: sqliteVersion, text: true, blob: true, json: true },
    }),
    stderr: "",
  };
}
