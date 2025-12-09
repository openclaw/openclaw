import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

import { createDefaultDeps } from "../cli/deps.js";
import { agentCommand } from "../commands/agent.js";
import { getHealthSnapshot, type HealthSummary } from "../commands/health.js";
import { getStatusSummary, type StatusSummary } from "../commands/status.js";
import { onAgentEvent } from "../infra/agent-events.js";
import {
  getLastHeartbeatEvent,
  onHeartbeatEvent,
} from "../infra/heartbeat-events.js";
import {
  enqueueSystemEvent,
  listSystemPresence,
  updateSystemPresence,
} from "../infra/system-presence.js";
import { setHeartbeatsEnabled } from "../provider-web.js";

export type RpcLoopHandles = { close: () => void };

/**
 * Run the stdin/stdout RPC loop used by `clawdis rpc`.
 * Exposed for testing and reuse.
 */
export async function runRpcLoop(io: {
  input: Readable;
  output: Writable;
}): Promise<RpcLoopHandles> {
  const rl = createInterface({ input: io.input, crlfDelay: Infinity });

  const respond = (obj: unknown) => {
    try {
      io.output.write(`${JSON.stringify(obj)}\n`);
    } catch (err) {
      io.output.write(
        `${JSON.stringify({ type: "error", error: String(err) })}\n`,
      );
    }
  };

  const forwardHeartbeat = (payload: unknown) => {
    respond({ type: "event", event: "heartbeat", payload });
  };
  const forwardAgent = (payload: unknown) => {
    respond({ type: "event", event: "agent", payload });
  };

  const latest = getLastHeartbeatEvent();
  if (latest) forwardHeartbeat(latest);
  const stopHeartbeat = onHeartbeatEvent(forwardHeartbeat);
  const stopAgent = onAgentEvent(forwardAgent);

  rl.on("line", async (line: string) => {
    if (!line.trim()) return;
    try {
      const cmd = JSON.parse(line);
      if (cmd.type === "status") {
        respond({ type: "result", ok: true });
        return;
      }
      if (cmd.type === "set-heartbeats") {
        setHeartbeatsEnabled(Boolean(cmd.enabled));
        respond({ type: "result", ok: true });
        return;
      }
      if (cmd.type === "control-request" && cmd.id && cmd.method) {
        const id = String(cmd.id);
        const method = String(cmd.method);
        const params = (cmd.params ?? {}) as Record<string, unknown>;
        const controlRespond = (
          ok: boolean,
          payload?: unknown,
          error?: string,
        ) => respond({ type: "control-response", id, ok, payload, error });
        try {
          if (method === "health") {
            const timeoutMs =
              typeof params.timeoutMs === "number"
                ? params.timeoutMs
                : undefined;
            const payload = await getHealthSnapshot(timeoutMs);
            controlRespond(true, payload satisfies HealthSummary);
            return;
          }
          if (method === "status") {
            const payload = await getStatusSummary();
            controlRespond(true, payload satisfies StatusSummary);
            return;
          }
          if (method === "last-heartbeat") {
            controlRespond(true, getLastHeartbeatEvent());
            return;
          }
          if (method === "set-heartbeats") {
            setHeartbeatsEnabled(Boolean(params.enabled));
            controlRespond(true, { ok: true });
            return;
          }
          if (method === "system-event") {
            const text = String(params.text ?? "").trim();
            if (text) {
              enqueueSystemEvent(text);
              updateSystemPresence(text);
            }
            controlRespond(true, { ok: true });
            return;
          }
          if (method === "system-presence") {
            controlRespond(true, listSystemPresence());
            return;
          }
          controlRespond(false, undefined, `unknown control method: ${method}`);
        } catch (err) {
          controlRespond(false, undefined, String(err));
        }
        return;
      }
      if (cmd.type !== "send" || !cmd.text) {
        respond({ type: "error", error: "unsupported command" });
        return;
      }

      const logs: string[] = [];
      const runtime: RuntimeEnv = {
        log: (msg: string) => logs.push(String(msg)),
        error: (msg: string) => logs.push(String(msg)),
        exit: (_code: number): never => {
          throw new Error("agentCommand requested exit");
        },
      };

      const opts: {
        message: string;
        to?: string;
        sessionId?: string;
        thinking?: string;
        deliver?: boolean;
        json: boolean;
      } = {
        message: String(cmd.text),
        to: cmd.to ? String(cmd.to) : undefined,
        sessionId: cmd.session ? String(cmd.session) : undefined,
        thinking: cmd.thinking ? String(cmd.thinking) : undefined,
        deliver: Boolean(cmd.deliver),
        json: true,
      };

      try {
        await agentCommand(opts, runtime, createDefaultDeps());
        const payload = extractPayload(logs);
        respond({ type: "result", ok: true, payload });
      } catch (err) {
        respond({ type: "error", error: String(err) });
      }
    } catch (err) {
      respond({ type: "error", error: `parse error: ${String(err)}` });
    }
  });

  const extractPayload = (logs: string[]) => {
    for (const entry of logs.slice().reverse()) {
      try {
        const parsed = JSON.parse(entry);
        if (parsed && typeof parsed === "object" && "payloads" in parsed) {
          return parsed;
        }
      } catch {
        // non-JSON log, ignore
      }
    }
    return null;
  };

  const close = () => {
    stopHeartbeat();
    stopAgent();
    rl.close();
  };

  return { close };
}
