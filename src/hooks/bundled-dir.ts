// Bundled hook directory helpers locate packaged hook definitions.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function resolveBundledHooksDir(): string | undefined {
  const override = process.env.OPENCLAW_BUNDLED_HOOKS_DIR?.trim();
  if (override) {
    return override;
  }

  // Search compiled executables, npm packages, then source checkouts in that order.
  for (const resolveCandidate of [
    () => path.join(path.dirname(process.execPath), "hooks", "bundled"),
    () => path.join(path.dirname(fileURLToPath(import.meta.url)), "bundled"),
    () => path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src/hooks/bundled"),
  ]) {
    try {
      const candidate = resolveCandidate();
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    } catch {
      // A failed candidate does not prevent later installation layouts from resolving.
    }
  }
  return undefined;
}
