import type { IncomingMessage, ServerResponse } from "node:http";

export type TelegramHttpRequestHandler = (
  req: IncomingMessage,
  res: ServerResponse,
) => Promise<void> | void;

type RegisterTelegramHttpHandlerArgs = {
  path?: string | null;
  handler: TelegramHttpRequestHandler;
  log?: (message: string) => void;
  accountId?: string;
};

const telegramHttpRoutes = new Map<string, TelegramHttpRequestHandler>();

export function normalizeTelegramWebhookPath(path?: string | null): string {
  const trimmed = path?.trim();
  if (!trimmed) {
    return "/telegram-webhook";
  }
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

export function registerTelegramHttpHandler(params: RegisterTelegramHttpHandlerArgs): () => void {
  const normalizedPath = normalizeTelegramWebhookPath(params.path);
  if (telegramHttpRoutes.has(normalizedPath)) {
    const suffix = params.accountId ? ` for account "${params.accountId}"` : "";
    throw new Error(`telegram: webhook path ${normalizedPath} already registered${suffix}`);
  }
  telegramHttpRoutes.set(normalizedPath, params.handler);
  return () => {
    telegramHttpRoutes.delete(normalizedPath);
  };
}

export async function handleTelegramHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const handler = telegramHttpRoutes.get(url.pathname);
  if (!handler) {
    return false;
  }
  await handler(req, res);
  return true;
}
