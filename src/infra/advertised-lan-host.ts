import { isRfc1918Ipv4Address } from "@openclaw/net-policy/ip";
import { safeParseJson } from "@openclaw/normalization-core/json-coercion";
import { normalizeLowercaseStringOrEmpty as normalizeInterfaceName } from "@openclaw/normalization-core/string-coerce";
import { runCommandWithTimeout as defaultRunCommandWithTimeout } from "../process/exec.js";
import {
  listExternalInterfaceAddresses,
  safeNetworkInterfaces,
  type NetworkInterfacesSnapshot,
} from "./network-interfaces.js";

const DEFAULT_ROUTE_HINT_TIMEOUT_MS = 3_000;
const DEFAULT_ROUTE_HINT_OUTPUT_BYTES = 16 * 1024;
const WINDOWS_DEFAULT_ROUTE_COMMAND =
  "[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); Get-NetRoute -AddressFamily IPv4 -DestinationPrefix '0.0.0.0/0' | " +
  "Select-Object -Property InterfaceAlias,RouteMetric,InterfaceMetric | ConvertTo-Json -Compress";

type WindowsRouteRow = {
  InterfaceAlias?: unknown;
  InterfaceMetric?: unknown;
  RouteMetric?: unknown;
};

function normalizeMetric(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function parseWindowsDefaultRouteHints(stdout: string): string[] {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return [];
  }

  const parsed = safeParseJson(trimmed);
  const rankedRows: {
    interfaceName: string;
    effectiveMetric: number;
    routeMetric: number;
    interfaceMetric: number;
    order: number;
  }[] = [];
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  for (const [order, row] of rows.entries()) {
    if (!row || typeof row !== "object") {
      continue;
    }
    const route = row as WindowsRouteRow;
    const interfaceName = normalizeInterfaceName(route.InterfaceAlias);
    if (interfaceName) {
      const routeMetric = normalizeMetric(route.RouteMetric);
      const interfaceMetric = normalizeMetric(route.InterfaceMetric);
      rankedRows.push({
        interfaceName,
        effectiveMetric: routeMetric + interfaceMetric,
        routeMetric,
        interfaceMetric,
        order,
      });
    }
  }
  rankedRows.sort(
    (a, b) =>
      a.effectiveMetric - b.effectiveMetric ||
      a.routeMetric - b.routeMetric ||
      a.interfaceMetric - b.interfaceMetric ||
      a.order - b.order,
  );
  return rankedRows.map((row) => row.interfaceName);
}

function parseMacOsDefaultRouteHints(stdout: string): string[] {
  const match = /^\s*interface:\s*(\S+)/m.exec(stdout);
  return match?.[1] ? [match[1]] : [];
}

function parseLinuxDefaultRouteHints(stdout: string): string[] {
  const hints: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.startsWith("default ")) {
      continue;
    }
    const match = /\bdev\s+(\S+)/.exec(line);
    if (match?.[1]) {
      hints.push(match[1]);
    }
  }
  return hints;
}

export async function resolveAdvertisedLanHostCore(
  options: {
    networkInterfaces?: () => NetworkInterfacesSnapshot;
    runCommandWithTimeout?: (
      argv: string[],
      opts: { timeoutMs: number; maxOutputBytes?: number },
    ) => Promise<{ code: number | null; stdout: string }>;
  } = {},
): Promise<string | null> {
  const candidates = listExternalInterfaceAddresses(
    safeNetworkInterfaces(options.networkInterfaces),
    "IPv4",
  ).filter((entry) => isRfc1918Ipv4Address(entry.address));
  if (candidates.length <= 1) {
    return candidates[0]?.address ?? null;
  }

  const runCommandWithTimeout = options.runCommandWithTimeout ?? defaultRunCommandWithTimeout;
  let argv: string[];
  let parse: typeof parseWindowsDefaultRouteHints;
  if (process.platform === "win32") {
    argv = [
      "powershell.exe",
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      WINDOWS_DEFAULT_ROUTE_COMMAND,
    ];
    parse = parseWindowsDefaultRouteHints;
  } else if (process.platform === "darwin") {
    argv = ["route", "-n", "get", "default"];
    parse = parseMacOsDefaultRouteHints;
  } else if (process.platform === "linux") {
    argv = ["ip", "-4", "route", "show", "default"];
    parse = parseLinuxDefaultRouteHints;
  } else {
    return candidates[0]?.address ?? null;
  }

  let stdout: string;
  try {
    const result = await runCommandWithTimeout(argv, {
      timeoutMs: DEFAULT_ROUTE_HINT_TIMEOUT_MS,
      maxOutputBytes: DEFAULT_ROUTE_HINT_OUTPUT_BYTES,
    });
    if (result.code !== 0) {
      return candidates[0]?.address ?? null;
    }
    stdout = result.stdout;
  } catch {
    return candidates[0]?.address ?? null;
  }
  const routeHints = stdout ? parse(stdout) : [];
  for (const hint of routeHints) {
    const hintedName = normalizeInterfaceName(hint);
    if (!hintedName) {
      continue;
    }
    const routed = candidates.find(
      (candidate) => normalizeInterfaceName(candidate.name) === hintedName,
    );
    if (routed) {
      return routed.address;
    }
  }

  return candidates[0]?.address ?? null;
}
