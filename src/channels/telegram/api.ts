export async function fetchTelegramChatId(params: {
  token: string;
  chatId: string;
  apiRoot?: string;
  signal?: AbortSignal;
}): Promise<string | null> {
  const apiRoot = params.apiRoot || "https://api.telegram.org";
  const url = `${apiRoot}/bot${params.token}/getChat?chat_id=${encodeURIComponent(params.chatId)}`;
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
