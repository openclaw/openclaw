export type TailscaleStatusCommandResult = {
  code: number | null;
  stdout: string;
};

export type TailscaleStatusCommandRunner = (
  argv: string[],
  opts: { timeoutMs: number },
) => Promise<TailscaleStatusCommandResult>;

const TAILSCALE_STATUS_COMMAND_CANDIDATES = [
  "tailscale",
  "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
];

function parsePossiblyNoisyJsonObject(raw: string): Record<string, unknown> {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) {
    return {};
  }
  try {
    return JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function extractTailnetHostFromStatusJson(raw: string): string | null {
  const parsed = parsePossiblyNoisyJsonObject(raw);
  const self =
    typeof parsed.Self === "object" && parsed.Self !== null
      ? (parsed.Self as Record<string, unknown>)
      : undefined;
  const dns = typeof self?.DNSName === "string" ? self.DNSName : undefined;
  if (dns && dns.length > 0) {
    return dns.replace(/\.$/, "");
  }
  const ips = Array.isArray(self?.TailscaleIPs) ? (self.TailscaleIPs as string[]) : [];
  return ips.length > 0 ? (ips[0] ?? null) : null;
}

export async function resolveTailnetHostWithRunner(
  runCommandWithTimeout?: TailscaleStatusCommandRunner,
): Promise<string | null> {
  if (!runCommandWithTimeout) {
    return null;
  }
  for (const candidate of TAILSCALE_STATUS_COMMAND_CANDIDATES) {
    try {
      const result = await runCommandWithTimeout([candidate, "status", "--json"], {
        timeoutMs: 5000,
      });
      if (result.code !== 0) {
        continue;
      }
      const raw = result.stdout.trim();
      if (!raw) {
        continue;
      }
      const host = extractTailnetHostFromStatusJson(raw);
      if (host) {
        return host;
      }
    } catch {
      continue;
    }
  }
  return null;
}
