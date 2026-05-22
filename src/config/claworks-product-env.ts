/** ClaWorks product env heuristics (no imports from paths.ts — safe for early bootstrap). */

function normalizePathForMatch(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/, "");
}

export function looksLikeClaworksStateEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const state = env.OPENCLAW_STATE_DIR?.trim();
  if (state) {
    const normalized = normalizePathForMatch(state);
    if (normalized.endsWith("/.claworks") || normalized.endsWith(".claworks")) {
      return true;
    }
  }
  const config = env.OPENCLAW_CONFIG_PATH?.trim();
  if (config) {
    const normalized = normalizePathForMatch(config);
    if (/(^|\/)claworks\.json$/i.test(normalized)) {
      return true;
    }
  }
  return false;
}

export function isOpenClawCliEntry(env: NodeJS.ProcessEnv = process.env): boolean {
  const argv1 = env._CLAWORKS_ARGV1 ?? process.argv[1] ?? "";
  const base = argv1.split(/[/\\]/).pop() ?? "";
  return base === "openclaw" || base === "openclaw.mjs" || base === "openclaw.js";
}
