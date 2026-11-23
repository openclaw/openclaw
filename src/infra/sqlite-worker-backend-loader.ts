import { isRecord } from "@openclaw/normalization-core/record-coerce";

// A module loader registration is isolate-wide, including in the shared worker host.
let sourceLoaderRegistered = false;

export async function loadSqliteWorkerBackendModule(
  moduleUrl: string,
  sourceLoaderUrl?: string,
): Promise<unknown> {
  if (!sourceLoaderRegistered && sourceLoaderUrl) {
    const loader: unknown = await import(sourceLoaderUrl);
    if (!isRecord(loader) || typeof loader.register !== "function") {
      throw new Error("SQLite source worker loader is unavailable");
    }
    loader.register();
    sourceLoaderRegistered = true;
  }
  return import(moduleUrl);
}
