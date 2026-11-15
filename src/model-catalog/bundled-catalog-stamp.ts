import { readFileSync } from "node:fs";

const BUILD_INFO_CANDIDATES = [
  "../build-info.json",
  "../../build-info.json",
  "./build-info.json",
] as const;
const buildStamps = new Map<string, number | undefined>();

/** Keep build metadata tied to the loaded code, including source checkouts without a stamp. */
export function bundledCatalogGeneratedAt(moduleUrl = import.meta.url): number | undefined {
  if (buildStamps.has(moduleUrl)) {
    return buildStamps.get(moduleUrl);
  }
  for (const candidate of BUILD_INFO_CANDIDATES) {
    try {
      const info = JSON.parse(readFileSync(new URL(candidate, moduleUrl), "utf8")) as {
        builtAt?: unknown;
      };
      if (typeof info.builtAt !== "string") {
        continue;
      }
      const generatedAt = Date.parse(info.builtAt);
      if (Number.isFinite(generatedAt) && generatedAt > 0) {
        buildStamps.set(moduleUrl, generatedAt);
        return generatedAt;
      }
    } catch {
      // Source/dev checkouts intentionally fail closed when no packaged stamp exists.
    }
  }
  buildStamps.set(moduleUrl, undefined);
  return undefined;
}
