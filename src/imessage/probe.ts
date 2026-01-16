import { detectBinary } from "../commands/onboard-helpers.js";
import { loadConfig } from "../config/config.js";
import type { RuntimeEnv } from "../runtime.js";
import { createIMessageRpcClient } from "./client.js";

export type IMessageProbe = {
  ok: boolean;
  error?: string | null;
};

export type IMessageProbeOptions = {
  cliPath?: string;
  dbPath?: string;
  runtime?: RuntimeEnv;
};

export async function probeIMessage(
  timeoutMs = 2000,
  opts: IMessageProbeOptions = {},
): Promise<IMessageProbe> {
  const cfg = opts.cliPath || opts.dbPath ? undefined : loadConfig();
  const cliPath = opts.cliPath?.trim() || cfg?.channels?.imessage?.cliPath?.trim() || "imsg";
  const dbPath = opts.dbPath?.trim() || cfg?.channels?.imessage?.dbPath?.trim();
  const detected = await detectBinary(cliPath);
  if (!detected) {
    return { ok: false, error: `imsg not found (${cliPath})` };
  }

  const client = await createIMessageRpcClient({
    cliPath,
    dbPath,
    runtime: opts.runtime,
  });
  try {
    await client.request("chats.list", { limit: 1 }, { timeoutMs });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  } finally {
    await client.stop();
  }
}
