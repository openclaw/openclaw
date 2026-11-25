import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { readCliStartupMetadata } from "./startup-metadata.js";

export function resolveCliChannelOptions(): string[] {
  const parsed = readCliStartupMetadata(import.meta.url);
  if (parsed && Array.isArray(parsed.channelOptions)) {
    return uniqueStrings(
      parsed.channelOptions.filter(
        (value): value is string => typeof value === "string" && Boolean(value),
      ),
    );
  }
  return [];
}

export function formatCliChannelOptions(extra: string[] = []): string {
  const options = [...extra, ...resolveCliChannelOptions()];
  return options.length > 0 ? options.join("|") : "channel";
}
