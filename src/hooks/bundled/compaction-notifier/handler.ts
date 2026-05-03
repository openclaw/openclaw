const handler = async (event: any) => {
  try {
    if (!event || !Array.isArray(event.messages)) return;
    const context = event.context ?? {};

    if (event.type === "session" && event.action === "compact:before") {
      const messageCount = typeof context.messageCount === "number" && context.messageCount >= 0
        ? ` (${context.messageCount} messages)`
        : "";
      event.messages.push(`🧹 Compacting context${messageCount} so I can continue without losing history…`);
      return;
    }

    if (event.type === "session" && event.action === "compact:after") {
      const before = typeof context.tokensBefore === "number" ? context.tokensBefore : undefined;
      const after = typeof context.tokensAfter === "number" ? context.tokensAfter : undefined;
      const tokenDelta = before !== undefined && after !== undefined
        ? ` (${before.toLocaleString()} → ${after.toLocaleString()} tokens)`
        : "";
      event.messages.push(`✅ Context compacted${tokenDelta}. Continuing from where I left off.`);
    }
  } catch (error) {
    console.warn(`[compaction-notifier] failed: ${error instanceof Error ? error.message : String(error)}`);
  }
};

export default handler;
