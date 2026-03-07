export async function fetchTelegramChatId(params: {
  token: string;
  chatId: string;
  signal?: AbortSignal;
}): Promise<string | null> {
  const url = `https://api.telegram.org/bot${params.token}/getChat?chat_id=${encodeURIComponent(params.chatId)}`;
  try {
    const res = await fetch(url, params.signal ? { signal: params.signal } : undefined);
    if (!res.ok) {
      return null;
    }
    const data = (await res.json().catch(() => null)) as {
      ok?: boolean;
      result?: { id?: number | string };
    } | null;
    const id = data?.ok ? data?.result?.id : undefined;
    if (typeof id === "number" || typeof id === "string") {
      return String(id);
    }
    return null;
  } catch {
    return null;
  }
}

export type TelegramPinnedMessage = {
  messageId: number;
  date: number;
  text?: string;
  caption?: string;
  chat?: { id: number; title?: string; username?: string };
  from?: { id: number; username?: string; first_name?: string };
};

export async function fetchTelegramPinnedMessage(params: {
  token: string;
  chatId: string;
  signal?: AbortSignal;
}): Promise<TelegramPinnedMessage | null> {
  const url = `https://api.telegram.org/bot${params.token}/getChat?chat_id=${encodeURIComponent(params.chatId)}`;
  try {
    const res = await fetch(url, params.signal ? { signal: params.signal } : undefined);
    if (!res.ok) {
      return null;
    }
    const data = (await res.json().catch(() => null)) as {
      ok?: boolean;
      result?: { pinned_message?: TelegramPinnedMessage };
    } | null;
    return data?.ok ? (data?.result?.pinned_message ?? null) : null;
  } catch {
    return null;
  }
}
