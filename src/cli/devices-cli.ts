import type { Command } from "commander";
import { callGateway } from "../gateway/call.js";
import { formatTimeAgo } from "../infra/format-time/format-relative.ts";
import { defaultRuntime } from "../runtime.js";
import { renderTable } from "../terminal/table.js";
import { theme } from "../terminal/theme.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { withProgress } from "./progress.js";

type DevicesRpcOpts = {
  url?: string;
  token?: string;
  password?: string;
  timeout?: string;
  json?: boolean;
  latest?: boolean;
  device?: string;
  role?: string;
  scope?: string[];
};

type DeviceTokenSummary = {
  role: string;
  scopes?: string[];
  revokedAtMs?: number;
};

type PendingDevice = {
  requestId: string;
  deviceId: string;
  displayName?: string;
  role?: string;
  remoteIp?: string;
  isRepair?: boolean;
  ts?: number;
};

type PairedDevice = {
  deviceId: string;
  displayName?: string;
  roles?: string[];
  scopes?: string[];
  remoteIp?: string;
  tokens?: DeviceTokenSummary[];
  createdAtMs?: number;
  approvedAtMs?: number;
};

type DevicePairingList = {
  pending?: PendingDevice[];
  paired?: PairedDevice[];
};

const devicesCallOpts = (cmd: Command, defaults?: { timeoutMs?: number }) =>
  cmd
    .option("--url <url>", "Gateway WebSocket URL (defaults to gateway.remote.url when configured)")
    .option("--token <token>", "Gateway token (if required)")
    .option("--password <password>", "Gateway password (password auth)")
    .option("--timeout <ms>", "Timeout in ms", String(defaults?.timeoutMs ?? 10_000))
    .option("--json", "Output JSON", false);

const callGatewayCli = async (method: string, opts: DevicesRpcOpts, params?: unknown) =>
  withProgress(
    {
      label: `Devices ${method}`,
      indeterminate: true,
      enabled: opts.json !== true,
    },
    async () =>
      await callGateway({
        url: opts.url,
        token: opts.token,
        password: opts.password,
        method,
        params,
        timeoutMs: Number(opts.timeout ?? 10_000),
        clientName: GATEWAY_CLIENT_NAMES.CLI,
        mode: GATEWAY_CLIENT_MODES.CLI,
      }),
  );

function parseDevicePairingList(value: unknown): DevicePairingList {
  const obj = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  return {
    pending: Array.isArray(obj.pending) ? (obj.pending as PendingDevice[]) : [],
    paired: Array.isArray(obj.paired) ? (obj.paired as PairedDevice[]) : [],
  };
}

function selectLatestPendingRequest(pending: PendingDevice[] | undefined) {
  if (!pending?.length) {
    return null;
  }
  return pending.reduce((latest, current) => {
    const latestTs = typeof latest.ts === "number" ? latest.ts : 0;
    const currentTs = typeof current.ts === "number" ? current.ts : 0;
    return currentTs > latestTs ? current : latest;
  });
}

function formatTokenSummary(tokens: DeviceTokenSummary[] | undefined) {
  if (!tokens || tokens.length === 0) {
    return "none";
  }
  const parts = tokens
    .map((t) => `${t.role}${t.revokedAtMs ? " (revoked)" : ""}`)
    .toSorted((a, b) => a.localeCompare(b));
  return parts.join(", ");
}

export function registerDevicesCli(program: Command) {
  const devices = program.command("devices").description("Device pairing and auth tokens");

  devicesCallOpts(
    devices
      .command("list")
      .description("List pending and paired devices")
      .action(async (opts: DevicesRpcOpts) => {
        const result = await callGatewayCli("device.pair.list", opts, {});
        const list = parseDevicePairingList(result);
        if (opts.json) {
          defaultRuntime.log(JSON.stringify(list, null, 2));
          return;
        }
        if (list.pending?.length) {
          const tableWidth = Math.max(60, (process.stdout.columns ?? 120) - 1);
          defaultRuntime.log(
            `${theme.heading("Pending")} ${theme.muted(`(${list.pending.length})`)}`,
          );
          defaultRuntime.log(
            renderTable({
              width: tableWidth,
              columns: [
                { key: "Request", header: "Request", minWidth: 10 },
                { key: "Device", header: "Device", minWidth: 16, flex: true },
                { key: "Role", header: "Role", minWidth: 8 },
                { key: "IP", header: "IP", minWidth: 12 },
                { key: "Age", header: "Age", minWidth: 8 },
                { key: "Flags", header: "Flags", minWidth: 8 },
              ],
              rows: list.pending.map((req) => ({
                Request: req.requestId,
                Device: req.displayName || req.deviceId,
                Role: req.role ?? "",
                IP: req.remoteIp ?? "",
                Age: typeof req.ts === "number" ? formatTimeAgo(Date.now() - req.ts) : "",
                Flags: req.isRepair ? "repair" : "",
              })),
            }).trimEnd(),
          );
        }
        if (list.paired?.length) {
          const tableWidth = Math.max(60, (process.stdout.columns ?? 120) - 1);
          defaultRuntime.log(
            `${theme.heading("Paired")} ${theme.muted(`(${list.paired.length})`)}`,
          );
          defaultRuntime.log(
            renderTable({
              width: tableWidth,
              columns: [
                { key: "Device", header: "Device", minWidth: 16, flex: true },
                { key: "Roles", header: "Roles", minWidth: 12, flex: true },
                { key: "Scopes", header: "Scopes", minWidth: 12, flex: true },
                { key: "Tokens", header: "Tokens", minWidth: 12, flex: true },
                { key: "IP", header: "IP", minWidth: 12 },
              ],
              rows: list.paired.map((device) => ({
                Device: device.displayName || device.deviceId,
                Roles: device.roles?.length ? device.roles.join(", ") : "",
                Scopes: device.scopes?.length ? device.scopes.join(", ") : "",
                Tokens: formatTokenSummary(device.tokens),
                IP: device.remoteIp ?? "",
              })),
            }).trimEnd(),
          );
        }
        if (!list.pending?.length && !list.paired?.length) {
          defaultRuntime.log(theme.muted("No device pairing entries."));
        }
      }),
  );

  devicesCallOpts(
    devices
      .command("approve")
      .description("Approve a pending device pairing request")
      .argument("[requestId]", "Pending request id")
      .option("--latest", "Approve the most recent pending request", false)
      .action(async (requestId: string | undefined, opts: DevicesRpcOpts) => {
        let resolvedRequestId = requestId?.trim();
        if (!resolvedRequestId || opts.latest) {
          const listResult = await callGatewayCli("device.pair.list", opts, {});
          const latest = selectLatestPendingRequest(parseDevicePairingList(listResult).pending);
          resolvedRequestId = latest?.requestId?.trim();
        }
        if (!resolvedRequestId) {
          defaultRuntime.error("No pending device pairing requests to approve");
          defaultRuntime.exit(1);
          return;
        }
        const result = await callGatewayCli("device.pair.approve", opts, {
          requestId: resolvedRequestId,
        });
        if (opts.json) {
          defaultRuntime.log(JSON.stringify(result, null, 2));
          return;
        }
        const deviceId = (result as { device?: { deviceId?: string } })?.device?.deviceId;
        defaultRuntime.log(
          `${theme.success("Approved")} ${theme.command(deviceId ?? "ok")} ${theme.muted(`(${resolvedRequestId})`)}`,
        );
      }),
  );

  devicesCallOpts(
    devices
      .command("reject")
      .description("Reject a pending device pairing request")
      .argument("<requestId>", "Pending request id")
      .action(async (requestId: string, opts: DevicesRpcOpts) => {
        const result = await callGatewayCli("device.pair.reject", opts, { requestId });
        if (opts.json) {
          defaultRuntime.log(JSON.stringify(result, null, 2));
          return;
        }
        const deviceId = (result as { deviceId?: string })?.deviceId;
        defaultRuntime.log(`${theme.warn("Rejected")} ${theme.command(deviceId ?? "ok")}`);
      }),
  );

  devicesCallOpts(
    devices
      .command("rotate")
      .description("Rotate a device token for a role")
      .requiredOption("--device <id>", "Device id")
      .requiredOption("--role <role>", "Role name")
      .option("--scope <scope...>", "Scopes to attach to the token (repeatable)")
      .action(async (opts: DevicesRpcOpts) => {
        const deviceId = String(opts.device ?? "").trim();
        const role = String(opts.role ?? "").trim();
        if (!deviceId || !role) {
          defaultRuntime.error("--device and --role required");
          defaultRuntime.exit(1);
          return;
        }
        const result = await callGatewayCli("device.token.rotate", opts, {
          deviceId,
          role,
          scopes: Array.isArray(opts.scope) ? opts.scope : undefined,
        });
        defaultRuntime.log(JSON.stringify(result, null, 2));
      }),
  );

  devicesCallOpts(
    devices
      .command("revoke")
      .description("Revoke a device token for a role")
      .requiredOption("--device <id>", "Device id")
      .requiredOption("--role <role>", "Role name")
      .action(async (opts: DevicesRpcOpts) => {
        const deviceId = String(opts.device ?? "").trim();
        const role = String(opts.role ?? "").trim();
        if (!deviceId || !role) {
          defaultRuntime.error("--device and --role required");
          defaultRuntime.exit(1);
          return;
        }
        const result = await callGatewayCli("device.token.revoke", opts, {
          deviceId,
          role,
        });
        defaultRuntime.log(JSON.stringify(result, null, 2));
      }),
  );
}
