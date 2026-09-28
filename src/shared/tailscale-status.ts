// Tailscale status helpers parse and validate status payloads from Tailscale.
import { redactSensitiveUrlLikeString } from "@openclaw/net-policy/redact-sensitive-url";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { z } from "zod";
import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import { safeParseJsonWithSchema } from "../utils/zod-parse.js";

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

const TailscaleStatusSchema = z.object({
  Self: z
    .object({
      DNSName: z.string().optional(),
      TailscaleIPs: z.array(z.string()).optional(),
    })
    .optional(),
});

const TailscaleServeTcpHandlerSchema = z.object({
  HTTPS: z.boolean().optional(),
});

const TailscaleServeWebServerSchema = z.object({
  Handlers: z.record(
    z.string(),
    z.object({
      Proxy: z.string().optional(),
    }),
  ),
});

const TailscaleServeConfigSchema = z.object({
  TCP: z.record(z.string(), TailscaleServeTcpHandlerSchema).optional(),
  Web: z.record(z.string(), TailscaleServeWebServerSchema).optional(),
  AllowFunnel: z.record(z.string(), z.boolean()).optional(),
});

const TailscaleServeObservationConfigSchema = TailscaleServeConfigSchema.extend({
  Services: z.record(z.string(), TailscaleServeConfigSchema).optional(),
});

const TailscaleServeStatusSchema = TailscaleServeObservationConfigSchema.extend({
  Foreground: z.record(z.string(), TailscaleServeObservationConfigSchema).optional(),
});

export type TailscaleServeRouteObservation = {
  management: "background" | "foreground";
  session?: string;
  host: string;
  port: number;
  path: string;
  target: string | null;
  funnel: boolean;
};

type TailscaleServeRouteInspection =
  | { status: "ok"; routes: TailscaleServeRouteObservation[] }
  | { status: "unavailable" }
  | { status: "invalid" };

function sanitizeTailscaleRouteText(value: string): string {
  return truncateUtf16Safe(sanitizeTerminalText(value), 512);
}

function sanitizeTailscaleRouteTarget(value: string | undefined): string | null {
  const sanitized = value ? sanitizeTailscaleRouteText(value) : "";
  return sanitized ? redactSensitiveUrlLikeString(sanitized) : null;
}

function parsePossiblyNoisyStatus<T>(raw: string, schema: z.ZodType<T>): T | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) {
    return null;
  }
  return safeParseJsonWithSchema(schema, raw.slice(start, end + 1));
}

/** Parses all observable HTTPS Serve routes without making an ownership decision. */
function extractTailscaleServeRouteObservations(
  raw: string,
): TailscaleServeRouteObservation[] | null {
  const status = parsePossiblyNoisyStatus(raw, TailscaleServeStatusSchema);
  if (!status) {
    return null;
  }

  const configs: Array<{
    management: TailscaleServeRouteObservation["management"];
    session?: string;
    config: z.infer<typeof TailscaleServeObservationConfigSchema>;
  }> = [{ management: "background", config: status }];
  for (const [session, config] of Object.entries(status.Foreground ?? {})) {
    configs.push({
      management: "foreground",
      session: sanitizeTailscaleRouteText(session),
      config,
    });
  }

  for (const { config, management, session } of configs.slice()) {
    for (const service of Object.values(config.Services ?? {})) {
      configs.push({ management, session, config: service });
    }
  }
  const routes: TailscaleServeRouteObservation[] = [];
  for (const entry of configs) {
    for (const [hostPort, server] of Object.entries(entry.config.Web ?? {})) {
      let endpoint: URL;
      try {
        endpoint = new URL(`https://${hostPort}`);
      } catch {
        continue;
      }
      const port = Number.parseInt(endpoint.port || "443", 10);
      if (entry.config.TCP?.[String(port)]?.HTTPS !== true) {
        continue;
      }
      for (const [path, handler] of Object.entries(server.Handlers)) {
        routes.push({
          management: entry.management,
          ...(entry.session ? { session: entry.session } : {}),
          host: endpoint.hostname.toLowerCase(),
          port,
          path: sanitizeTailscaleRouteText(path),
          target: sanitizeTailscaleRouteTarget(handler.Proxy),
          funnel: entry.config.AllowFunnel?.[hostPort] === true,
        });
      }
    }
  }
  return routes.toSorted(
    (a, b) =>
      a.management.localeCompare(b.management) ||
      (a.session ?? "").localeCompare(b.session ?? "") ||
      a.host.localeCompare(b.host) ||
      a.port - b.port ||
      a.path.localeCompare(b.path),
  );
}

function extractTailnetHostFromStatusJson(raw: string): string | null {
  const parsed = parsePossiblyNoisyStatus(raw, TailscaleStatusSchema);
  const dns = parsed?.Self?.DNSName;
  if (dns && dns.length > 0) {
    return dns.replace(/\.$/, "");
  }
  const ips = parsed?.Self?.TailscaleIPs ?? [];
  return ips.length > 0 ? (ips[0] ?? null) : null;
}

function parseLoopbackProxyPort(proxy: string, forAdoption: boolean): number | null {
  // SDK discovery accepts the shipped proxy forms; ownership requires the exact
  // HTTP loopback root written by previous managed releases.
  if (forAdoption) {
    const match = /^http:\/\/(?:127\.0\.0\.1|localhost):(\d+)\/?$/.exec(proxy);
    return match ? Number(match[1]) : null;
  }
  const trimmed = proxy.trim();
  if (/^\d+$/.test(trimmed)) {
    return Number.parseInt(trimmed, 10);
  }
  const normalized = trimmed.includes("://") ? trimmed : `http://${trimmed}`;
  try {
    const parsed = new URL(normalized);
    const host = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (!(host === "localhost" || host === "::1" || /^127(?:\.\d{1,3}){3}$/.test(host))) {
      return null;
    }
    const port = Number.parseInt(parsed.port, 10);
    return Number.isInteger(port) && port >= 1 && port <= 65_535 ? port : null;
  } catch {
    return null;
  }
}

export function extractTailscaleServeGatewayUrls(
  raw: string,
  gatewayPort: number,
  forAdoption = false,
): string[] | null {
  const config = parsePossiblyNoisyStatus(raw, TailscaleServeConfigSchema);
  if (!config) {
    return null;
  }
  // Services are not device routes; Funnel is excluded only from discovery.
  // Renames can leave other hostnames on a port, but the CLI clears the current
  // hostname. Adoption therefore requires the port's sole root handler.
  const web = Object.entries(config.Web ?? {});
  const urls = new Set<string>();
  for (const [hostPort, webServer] of web) {
    const handler = webServer.Handlers["/"];
    if (
      (!forAdoption && config.AllowFunnel?.[hostPort]) ||
      (forAdoption && Object.keys(webServer.Handlers).length !== 1) ||
      !handler?.Proxy ||
      parseLoopbackProxyPort(handler.Proxy, forAdoption) !== gatewayPort
    ) {
      continue;
    }
    try {
      const endpoint = new URL(`https://${hostPort}`);
      const exclusive =
        !forAdoption ||
        web.filter(([other]) => URL.parse(`https://${other}`)?.port === endpoint.port).length === 1;
      if (config.TCP?.[endpoint.port || "443"]?.HTTPS === true && exclusive) {
        urls.add(`wss://${endpoint.host}`);
      }
    } catch {
      continue;
    }
  }
  return [...urls].toSorted();
}

type TailscaleServeGatewayInspection =
  | { status: "ok"; urls: string[] }
  | { status: "unavailable" }
  | { status: "invalid" };

async function inspectTailscaleServeStatusWithRunner<T>(
  runCommandWithTimeout: TailscaleStatusCommandRunner | undefined,
  parse: (raw: string) => T | null,
  isPreferred: (value: T) => boolean,
): Promise<{ status: "ok"; value: T } | { status: "unavailable" } | { status: "invalid" }> {
  if (!runCommandWithTimeout) {
    return { status: "unavailable" };
  }
  let sawInvalidStatus = false;
  let fallback: { value: T } | undefined;
  for (const candidate of TAILSCALE_STATUS_COMMAND_CANDIDATES) {
    try {
      const result = await runCommandWithTimeout([candidate, "serve", "status", "--json"], {
        timeoutMs: 5000,
      });
      if (result.code !== 0 || !result.stdout.trim()) {
        continue;
      }
      const value = parse(result.stdout);
      if (value !== null) {
        if (isPreferred(value)) {
          return { status: "ok", value };
        }
        fallback ??= { value };
        continue;
      }
      sawInvalidStatus = true;
    } catch {
      continue;
    }
  }
  if (fallback) {
    return { status: "ok", value: fallback.value };
  }
  return { status: sawInvalidStatus ? "invalid" : "unavailable" };
}

/** Inspects persistent and foreground Serve routes without adopting or mutating them. */
export async function inspectTailscaleServeRoutesWithRunner(
  runCommandWithTimeout?: TailscaleStatusCommandRunner,
): Promise<TailscaleServeRouteInspection> {
  const inspection = await inspectTailscaleServeStatusWithRunner(
    runCommandWithTimeout,
    extractTailscaleServeRouteObservations,
    (routes) => routes.length > 0,
  );
  return inspection.status === "ok" ? { status: "ok", routes: inspection.value } : inspection;
}

/** Inspects persistent Serve routes without collapsing malformed output into route absence. */
export async function inspectTailscaleServeGatewayUrlsWithRunner(
  gatewayPort: number,
  runCommandWithTimeout?: TailscaleStatusCommandRunner,
  forAdoption = false,
): Promise<TailscaleServeGatewayInspection> {
  const inspection = await inspectTailscaleServeStatusWithRunner(
    runCommandWithTimeout,
    (raw) => extractTailscaleServeGatewayUrls(raw, gatewayPort, forAdoption),
    (urls) => urls.length > 0,
  );
  return inspection.status === "ok" ? { status: "ok", urls: inspection.value } : inspection;
}

/** Resolves the host published to clients for tailnet or Tailscale Serve gateway modes. */
export function resolveTailscalePublishedHost(params: {
  tailscaleMode: string;
  tailnetHost: string | null;
  /** @deprecated Managed Gateway ingress no longer supports named Services. */
  serviceName?: string | null;
}): string | null {
  const tailnetHost = params.tailnetHost?.trim();
  if (!tailnetHost) {
    return null;
  }
  const serviceName =
    params.tailscaleMode === "serve" ? params.serviceName?.trim() || undefined : undefined;
  if (!serviceName) {
    return tailnetHost;
  }
  // Preserve the shipped plugin SDK formatter while managed Gateway routes reject Services.
  if (/^[\d.:]+$/.test(tailnetHost)) {
    return null;
  }
  const bareServiceName = serviceName.replace(/^svc:/, "");
  const tailnetSuffix = tailnetHost.split(".").slice(1).join(".");
  return tailnetSuffix ? `${bareServiceName}.${tailnetSuffix}` : null;
}

/** Runs known Tailscale status commands and returns the first DNS name or tailnet IP found. */
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

/** Finds persistent HTTPS Serve routes whose root proxy targets this gateway port. */
export async function resolveTailscaleServeGatewayUrlsWithRunner(
  gatewayPort: number,
  runCommandWithTimeout?: TailscaleStatusCommandRunner,
): Promise<string[]> {
  const inspection = await inspectTailscaleServeGatewayUrlsWithRunner(
    gatewayPort,
    runCommandWithTimeout,
  );
  return inspection.status === "ok" ? inspection.urls : [];
}
