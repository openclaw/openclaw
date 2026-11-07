// A successful list RPC may still report discovery in progress. Only that explicit
// state is retryable: settled empty/error results retain the caller's assertions.
export async function waitForSettledCodexCatalog<
  T extends {
    catalogs: Array<{ error?: { code: string } }>;
  },
>(read: (timeoutMs: number) => Promise<T>, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error("canonical-native-catalog remained catalog_pending within request budget");
    }
    const result = await read(remaining);
    if (!result.catalogs.some((catalog) => catalog.error?.code === "catalog_pending")) {
      return result;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, Math.min(250, Math.max(0, deadline - Date.now())));
    });
  }
}
