import { spawnSync } from "node:child_process";
import { parseCmdScriptCommandLine } from "../daemon/cmd-argv.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
const DEFAULT_TIMEOUT_MS = 5_000;
// ---------------------------------------------------------------------------
// Windows listening-PID discovery (PowerShell → netstat fallback)
// ---------------------------------------------------------------------------
function readListeningPidsViaPowerShell(port, timeoutMs) {
    const ps = spawnSync("powershell", [
        "-NoProfile",
        "-Command",
        `(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess)`,
    ], {
        encoding: "utf8",
        timeout: timeoutMs,
        windowsHide: true,
    });
    if (ps.error || ps.status !== 0) {
        return null;
    }
    return ps.stdout
        .split(/\r?\n/)
        .map((line) => Number.parseInt(line.trim(), 10))
        .filter((pid) => Number.isFinite(pid) && pid > 0);
}
function parseListeningPidsFromNetstat(stdout, port) {
    const pids = new Set();
    for (const line of stdout.split(/\r?\n/)) {
        const match = line.match(/^\s*TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i);
        if (!match) {
            continue;
        }
        const parsedPort = Number.parseInt(match[2] ?? "", 10);
        const pid = Number.parseInt(match[3] ?? "", 10);
        if (parsedPort === port && Number.isFinite(pid) && pid > 0) {
            pids.add(pid);
        }
    }
    return [...pids];
}
export function readWindowsListeningPidsOnPortSync(port, timeoutMs = DEFAULT_TIMEOUT_MS) {
    const result = readWindowsListeningPidsResultSync(port, timeoutMs);
    return result.ok ? result.pids : [];
}
export function readWindowsListeningPidsResultSync(port, timeoutMs = DEFAULT_TIMEOUT_MS) {
    const powershellPids = readListeningPidsViaPowerShell(port, timeoutMs);
    if (powershellPids != null) {
        return { ok: true, pids: powershellPids };
    }
    const netstat = spawnSync("netstat", ["-ano", "-p", "tcp"], {
        encoding: "utf8",
        timeout: timeoutMs,
        windowsHide: true,
    });
    if (netstat.error) {
        const code = netstat.error.code;
        return { ok: false, permanent: code === "ENOENT" || code === "EACCES" || code === "EPERM" };
    }
    if (netstat.status !== 0) {
        return { ok: false, permanent: false };
    }
    return { ok: true, pids: parseListeningPidsFromNetstat(netstat.stdout, port) };
}
// ---------------------------------------------------------------------------
// Windows process-args reading (PowerShell → WMIC fallback)
// ---------------------------------------------------------------------------
function extractWindowsCommandLine(raw) {
    const lines = raw
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
    for (const line of lines) {
        if (!normalizeLowercaseStringOrEmpty(line).startsWith("commandline=")) {
            continue;
        }
        const value = line.slice("commandline=".length).trim();
        return value || null;
    }
    return lines.find((line) => normalizeLowercaseStringOrEmpty(line) !== "commandline") ?? null;
}
export function readWindowsProcessArgsSync(pid, timeoutMs = DEFAULT_TIMEOUT_MS) {
    const result = readWindowsProcessArgsResultSync(pid, timeoutMs);
    return result.ok ? result.args : null;
}
export function readWindowsProcessArgsResultSync(pid, timeoutMs = DEFAULT_TIMEOUT_MS) {
    const powershell = spawnSync("powershell", [
        "-NoProfile",
        "-Command",
        `(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}" | Select-Object -ExpandProperty CommandLine)`,
    ], {
        encoding: "utf8",
        timeout: timeoutMs,
        windowsHide: true,
    });
    if (!powershell.error && powershell.status === 0) {
        const command = powershell.stdout.trim();
        return { ok: true, args: command ? parseCmdScriptCommandLine(command) : null };
    }
    const wmic = spawnSync("wmic", ["process", "where", `ProcessId=${pid}`, "get", "CommandLine", "/value"], {
        encoding: "utf8",
        timeout: timeoutMs,
        windowsHide: true,
    });
    if (!wmic.error && wmic.status === 0) {
        const command = extractWindowsCommandLine(wmic.stdout);
        return { ok: true, args: command ? parseCmdScriptCommandLine(command) : null };
    }
    const code = (wmic.error ?? powershell.error)?.code;
    return { ok: false, permanent: code === "ENOENT" || code === "EACCES" || code === "EPERM" };
}
