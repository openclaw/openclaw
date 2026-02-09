/**
 * Region detection utilities for provider endpoint selection.
 *
 * Some providers (e.g., MiniMax) have region-specific endpoints. This module
 * provides timezone-based region detection to automatically select the
 * appropriate endpoint for users in different regions.
 */

/**
 * Timezone identifiers for China and Greater China regions.
 * These timezones indicate the user is likely in mainland China, Hong Kong,
 * Macau, or Taiwan and may benefit from using domestic API endpoints.
 */
const CHINA_TIMEZONES = new Set([
  "Asia/Shanghai",
  "Asia/Chongqing",
  "Asia/Harbin",
  "Asia/Urumqi",
  "PRC",
  "Asia/Hong_Kong",
  "Hongkong",
  "Asia/Macau",
  "Asia/Taipei",
  "ROC",
]);

/**
 * Detects if the current environment is likely in China or Greater China
 * based on the system timezone.
 *
 * @returns `true` if the timezone indicates China/Greater China region
 *
 * @example
 * ```ts
 * if (isChinaRegion()) {
 *   // Use domestic API endpoint
 *   baseUrl = "https://api.minimaxi.com/anthropic";
 * } else {
 *   // Use overseas API endpoint
 *   baseUrl = "https://api.minimax.io/anthropic";
 * }
 * ```
 */
export function isChinaRegion(): boolean {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return CHINA_TIMEZONES.has(tz);
  } catch {
    // If timezone detection fails, default to overseas
    return false;
  }
}
