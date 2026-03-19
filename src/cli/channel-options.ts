import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CHAT_CHANNEL_ORDER } from "../channels/registry.js";

/**
 * Abstraction for filesystem operations to allow mocking in tests.
 */
export interface FileReader {
  readFileSync(path: string, encoding: string): string;
}

/**
 * Default production implementation using Node.js fs module.
 */
const DEFAULT_FILE_READER: FileReader = {
  readFileSync: (path: string, encoding: string) => fs.readFileSync(path, encoding as string),
};

function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  const resolved: string[] = [];
  for (const value of values) {
    if (!value || seen.has(value)) {
      continue;
    }
    seen.add(value);
    resolved.push(value);
  }
  return resolved;
}

/**
 * Resolver class encapsulating the logic and cache state.
 * This prevents global state pollution between tests.
 */
class ChannelResolver {
  private _cachedOptions: string[] | null | undefined;

  constructor(private readonly _fileReader: FileReader) {}

  private loadPrecomputedOptions(): string[] | null {
    // Return cached result if available
    if (this._cachedOptions !== undefined) {
      return this._cachedOptions;
    }

    try {
      const metadataPath = path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        "..",
        "cli-startup-metadata.json",
      );

      // Use injected reader
      const raw = this._fileReader.readFileSync(metadataPath, "utf8");
      const parsed = JSON.parse(raw) as { channelOptions?: unknown };

      if (Array.isArray(parsed.channelOptions)) {
        this._cachedOptions = dedupe(
          parsed.channelOptions.filter((value): value is string => typeof value === "string"),
        );
        return this._cachedOptions;
      }
    } catch {
      // Fall back to dynamic catalog resolution.
    }

    this._cachedOptions = null;
    return null;
  }

  public getChannelOptions(): string[] {
    const precomputed = this.loadPrecomputedOptions();
    return precomputed ?? [...CHAT_CHANNEL_ORDER];
  }

  public formatOptions(extra: string[] = []): string {
    return [...extra, ...this.getChannelOptions()].join("|");
  }
}

/**
 * Factory function to create a resolver.
 * Allows Dependency Injection of a mock FileReader for testing.
 */
export function createChannelResolver(reader: FileReader = DEFAULT_FILE_READER) {
  return new ChannelResolver(reader);
}

/**
 * Type alias for the resolver instance.
 */
export type ChannelResolverInstance = ReturnType<typeof createChannelResolver>;

// Cached production resolver instance for performance.
// This preserves the startup optimization (read metadata once per process).
const productionResolver: ChannelResolverInstance = createChannelResolver();

// Backwards-compatible exports for existing production code.
// These delegate to the cached production instance.
export function resolveCliChannelOptions(): string[] {
  return productionResolver.getChannelOptions();
}

export function formatCliChannelOptions(extra: string[] = []): string {
  return productionResolver.formatOptions(extra);
}
