import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createQaGatewayChild, writeJson } from "../../../../extensions/qa-lab/api.js";

type TelegramConfig = NonNullable<NonNullable<OpenClawConfig["channels"]>["telegram"]>;
type TelegramAccount = NonNullable<TelegramConfig["accounts"]>[string];

export function telegramProofChannel(
  apiRoot: string,
  botToken: string,
  account: Partial<TelegramAccount>,
  root: Partial<TelegramConfig> = {},
): TelegramConfig {
  return {
    enabled: true,
    defaultAccount: "proof",
    ...root,
    accounts: { proof: { enabled: true, botToken, apiRoot, ...account } },
  };
}

export function bindTelegramProof(cfg: OpenClawConfig) {
  cfg.bindings = [
    ...(cfg.bindings ?? []),
    { agentId: "qa", match: { channel: "telegram", accountId: "proof" } },
  ];
  return cfg;
}

export function telegramRequestHandler(
  handle: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
) {
  return (req: IncomingMessage, res: ServerResponse) => {
    void handle(req, res).catch((error: unknown) => {
      writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    });
  };
}

export async function forwardTelegramProvider(
  req: IncomingMessage,
  baseUrl: string,
  pathname: string,
  raw: string,
) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  for (const key of ["session_id", "x-session-affinity"]) {
    const value = req.headers[key];
    if (typeof value === "string") {
      headers[key] = value;
    }
  }
  return fetch(`${baseUrl}${pathname}`, {
    method: req.method,
    ...(raw ? { body: raw } : {}),
    headers,
  });
}

type GatewayOptions = Parameters<ReturnType<typeof createQaGatewayChild>["start"]>[0];
export function telegramGatewayOptions({
  workspace,
  apiRoot,
  telegram,
  messages,
  mutateConfig,
  runtimeEnvPatch,
  ...options
}: Omit<GatewayOptions, "repoRoot" | "transport" | "transportBaseUrl" | "controlUiEnabled"> & {
  workspace?: string;
  apiRoot: string;
  telegram: NonNullable<OpenClawConfig["channels"]>["telegram"];
  messages?: OpenClawConfig["messages"];
}): GatewayOptions {
  return {
    ...options,
    repoRoot: path.resolve(import.meta.dirname, "../../../.."),
    transportBaseUrl: apiRoot,
    transport: {
      requiredPluginIds: ["telegram"],
      createGatewayConfig: () => ({ channels: { telegram }, ...(messages ? { messages } : {}) }),
    },
    controlUiEnabled: false,
    runtimeEnvPatch: {
      OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
      TELEGRAM_BOT_TOKEN: undefined,
      ...runtimeEnvPatch,
    },
    mutateConfig: (cfg) => {
      if (workspace !== undefined) {
        cfg.agents!.defaults!.workspace = workspace;
      }
      return mutateConfig ? mutateConfig(cfg) : cfg;
    },
  };
}

export async function readTelegramRequest(req: IncomingMessage) {
  let text = "";
  for await (const chunk of req) {
    text += chunk;
  }
  return text;
}

export function succeedTelegram(res: ServerResponse, result: unknown = true) {
  writeJson(res, 200, { ok: true, result });
}

function createTelegramUpdateQueue() {
  const pendingUpdates: unknown[] = [];
  const pendingPolls = new Set<ServerResponse>();
  return {
    pendingUpdates,
    pendingPolls,
    enqueue(update: unknown) {
      const poll = pendingPolls.values().next().value;
      if (poll) {
        pendingPolls.delete(poll);
        succeedTelegram(poll, [update]);
      } else {
        pendingUpdates.push(update);
      }
    },
    poll(res: ServerResponse) {
      const update = pendingUpdates.shift();
      if (update) {
        succeedTelegram(res, [update]);
      } else {
        pendingPolls.add(res);
        res.on("close", () => pendingPolls.delete(res));
      }
    },
  };
}

export function createTelegramApi(options: {
  token: string;
  bot: Record<string, unknown>;
  chat: Record<string, unknown>;
  chatDetails?: Record<string, unknown>;
  messageId?: (callCount: number) => number;
  now?: () => number;
}) {
  const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
  const updates = createTelegramUpdateQueue();
  return {
    calls,
    updates,
    async handle(req: IncomingMessage, res: ServerResponse) {
      const [, token = "", method = ""] =
        new URL(req.url ?? "/", "http://127.0.0.1").pathname.match(/^\/bot([^/]+)\/([^/]+)$/) ?? [];
      const raw = await readTelegramRequest(req);
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      calls.push({ method, body });
      if (token !== options.token) {
        writeJson(res, 401, { ok: false, error_code: 401, description: "Unexpected bot token" });
      } else if (method === "getMe") {
        succeedTelegram(res, options.bot);
      } else if (method === "getUpdates") {
        updates.poll(res);
      } else if (method === "getChat") {
        succeedTelegram(res, { ...options.chat, ...options.chatDetails });
      } else if (method === "sendMessage") {
        succeedTelegram(res, {
          message_id: options.messageId?.(calls.length) ?? 9001,
          date: options.now?.() ?? 1_754_000_000,
          chat: options.chat,
          text: body.text,
        });
      } else {
        succeedTelegram(res);
      }
    },
  };
}

export async function settleTelegramCleanup(...cleanups: Array<() => Promise<void>>) {
  const failures: unknown[] = [];
  for (const cleanup of cleanups) {
    await cleanup().catch((error: unknown) => failures.push(error));
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "Telegram Gateway cleanup failed");
  }
}
