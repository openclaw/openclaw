export function createScopedCliClient(
  scopes?: string[],
  client: Partial<{
    id: string;
    mode: string;
    displayName: string;
    version: string;
  }> = {},
  caps?: string[],
) {
  const id = client.id ?? "openclaw-cli";
  return {
    connect: {
      scopes,
      caps,
      client: {
        id,
        mode: client.mode ?? "cli",
        displayName: client.displayName ?? id,
        version: client.version ?? "1.0.0",
      },
    },
  };
}
