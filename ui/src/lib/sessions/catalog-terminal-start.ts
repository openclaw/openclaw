import type { SessionsCatalogStartTerminalParams } from "@openclaw/gateway-protocol";
import { BoundedBuffer } from "../../../../src/shared/bounded-buffer.ts";
import {
  TerminalConnection,
  type TerminalGatewayClient,
  type TerminalOpenResult,
} from "../../components/terminal/terminal-connection.ts";
import { t } from "../../i18n/index.ts";

type TerminalSink = Parameters<TerminalConnection["open"]>[1];
type PreparedTerminal = {
  client: TerminalGatewayClient;
  connection: TerminalConnection;
  result: TerminalOpenResult;
  bind: (sink: TerminalSink) => void;
  expiry: ReturnType<typeof setTimeout>;
};

// Starts can emit output or exit before navigation mounts the terminal. Keep the
// existing stream alive until its page takes ownership, without persisting input.
const prepared = new Set<PreparedTerminal>();

// An unclaimed start has no UI owner, so close the PTY instead of leaving the
// native CLI running headless on the Gateway.
function discard(terminal: PreparedTerminal): void {
  prepared.delete(terminal);
  clearTimeout(terminal.expiry);
  void terminal.connection.close(terminal.result.sessionId);
  terminal.connection.dispose();
}

export async function prepareCatalogTerminal(
  client: TerminalGatewayClient,
  params: SessionsCatalogStartTerminalParams,
  isCurrent: () => boolean,
): Promise<TerminalOpenResult> {
  if (!isCurrent()) {
    throw new Error(t("terminal.startCancelled"));
  }
  const connection = new TerminalConnection(client);
  const output = new BoundedBuffer<string>(
    256 * 1024,
    { mode: "drop-oldest", fit: (data, capacity) => data.slice(-capacity) },
    (data) => data.length,
  );
  let sink: TerminalSink | null = null;
  let exit: Parameters<TerminalSink["onExit"]>[0] | null = null;
  try {
    const result = await connection.start(params, {
      onData: (data) => (sink ? sink.onData(data) : void output.push(data)),
      onReplay: (replay) => {
        if (sink) {
          return sink.onReplay(replay);
        }
        output.drain();
        output.push(replay.data);
      },
      onExit: (info) => {
        exit = info;
        sink?.onExit(info);
      },
    });
    if (!isCurrent()) {
      void connection.close(result.sessionId);
      throw new Error(t("terminal.startCancelled"));
    }
    // Bound abandoned starts even if navigation fails or its owner disappears.
    if (prepared.size >= 8) {
      const oldest = prepared.values().next().value;
      if (oldest) {
        discard(oldest);
      }
    }
    const terminal: PreparedTerminal = {
      client,
      connection,
      result,
      expiry: setTimeout(() => discard(terminal), 60_000),
      bind: (target) => {
        sink = target;
        for (const data of output.drain()) {
          target.onData(data);
        }
        if (exit) {
          target.onExit(exit);
        }
      },
    };
    prepared.add(terminal);
    return result;
  } catch (error) {
    connection.dispose();
    throw error;
  }
}

export function takePreparedCatalogTerminal(sessionId: string, client: TerminalGatewayClient) {
  const terminal = [...prepared].find(
    (entry) => entry.result.sessionId === sessionId && entry.client === client,
  );
  if (!terminal) {
    return null;
  }
  prepared.delete(terminal);
  clearTimeout(terminal.expiry);
  return terminal;
}
