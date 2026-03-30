import path from "node:path";
import { z } from "zod";
import { safeParseJsonWithSchema } from "../utils/zod-parse.js";

export type TailscaleStatusCommandResult = {
  code: number | null;
  stdout: string;
};

export type TailscaleStatusCommandRunner = (
  argv: string[],
  opts: { timeoutMs: number },
) => Promise<TailscaleStatusCommandResult>;

function getTailscaleStatusCommandCandidates(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
) {
  const candidates = new Set<string>(["tailscale"]);
  if (platform === "win32") {
    const programFiles = env.ProgramFiles?.trim();
    const programFilesX86 = env["ProgramFiles(x86)"]?.trim();
    const localAppData = env.LOCALAPPDATA?.trim();
    for (const base of [programFiles, programFilesX86, localAppData]) {
      if (!base) {
        continue;
      }
      candidates.add(path.join(base, "Tailscale", "tailscale.exe"));
    }
  } else {
    candidates.add("/Applications/Tailscale.app/Contents/MacOS/Tailscale");
  }
  return [...candidates];
}

const TailscaleStatusSchema = z.object({
  Self: z
    .object({
      DNSName: z.string().optional(),
      TailscaleIPs: z.array(z.string()).optional(),
    })
    .optional(),
});

function parsePossiblyNoisyStatus(raw: string): z.infer<typeof TailscaleStatusSchema> | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) {
    return null;
  }
  return safeParseJsonWithSchema(TailscaleStatusSchema, raw.slice(start, end + 1));
}

function extractTailnetHostFromStatusJson(raw: string): string | null {
  const parsed = parsePossiblyNoisyStatus(raw);
  const dns = parsed?.Self?.DNSName;
  if (dns && dns.length > 0) {
    return dns.replace(/\.$/, "");
  }
  const ips = parsed?.Self?.TailscaleIPs ?? [];
  return ips.length > 0 ? (ips[0] ?? null) : null;
}

export async function resolveTailnetHostWithRunner(
  runCommandWithTimeout?: TailscaleStatusCommandRunner,
): Promise<string | null> {
  if (!runCommandWithTimeout) {
    return null;
  }
  for (const candidate of getTailscaleStatusCommandCandidates()) {
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
