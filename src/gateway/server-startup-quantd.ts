import { isTruthyEnvValue } from "../infra/env.js";
import { startQuantdServer } from "../quantd/server.js";

const DEFAULT_GATEWAY_QUANTD_HOST = "127.0.0.1";
const DEFAULT_GATEWAY_QUANTD_PORT = 19_891;

function parseQuantdPort(params: {
  raw: string | undefined;
  fallback: number;
  warn: (message: string) => void;
}) {
  const value = params.raw?.trim();
  if (!value) {
    return params.fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 65_535) {
    params.warn(`invalid OPENCLAW_QUANTD_PORT "${value}"; using ${params.fallback}`);
    return params.fallback;
  }
  return parsed;
}

export async function startGatewayQuantdSidecar(params: {
  log: {
    info: (message: string) => void;
    warn: (message: string) => void;
  };
}) {
  if (!isTruthyEnvValue(process.env.OPENCLAW_QUANTD_ENABLED)) {
    return null;
  }

  const host = process.env.OPENCLAW_QUANTD_HOST?.trim() || DEFAULT_GATEWAY_QUANTD_HOST;
  const port = parseQuantdPort({
    raw: process.env.OPENCLAW_QUANTD_PORT,
    fallback: DEFAULT_GATEWAY_QUANTD_PORT,
    warn: params.log.warn,
  });
  const socketPath = process.env.OPENCLAW_QUANTD_SOCKET_PATH?.trim() || undefined;
  const walPath = process.env.OPENCLAW_QUANTD_WAL_PATH?.trim() || undefined;

  const handle = await startQuantdServer({
    host,
    port,
    socketPath,
    walPath,
  });
  const listenTarget = handle.baseUrl ?? handle.socketPath ?? `http://${host}:${port}`;
  params.log.info(`quantd sidecar started at ${listenTarget} (wal=${handle.walPath})`);
  return handle;
}
