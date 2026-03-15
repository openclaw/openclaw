export const VOICE_CONNECT_DEFAULT_BASE_PATH = "/voice-connect";

export function normalizeVoiceConnectBasePath(basePath?: string): string {
  const raw = String(basePath ?? VOICE_CONNECT_DEFAULT_BASE_PATH).trim();
  if (!raw) {
    return VOICE_CONNECT_DEFAULT_BASE_PATH;
  }
  let p = raw.startsWith("/") ? raw : `/${raw}`;
  // no trailing slash (routes will add it as needed)
  if (p.length > 1 && p.endsWith("/")) {
    p = p.slice(0, -1);
  }
  return p;
}
