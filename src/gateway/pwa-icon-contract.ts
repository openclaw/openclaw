// POST (512×512 PNG) or DELETE <mount>/pwa-icon with normal Control UI auth.
// The device header selects a browser storage slot; it is never a credential.
export const PWA_ICON_MAX_BYTES = 2 * 1024 * 1024;
export const PWA_ICON_SIZE = 512;
export const PWA_ICON_FILES = {
  512: "icon.png",
  192: "icon-192.png",
  180: "apple-touch-icon.png",
} as const;
export type PwaIconSize = keyof typeof PWA_ICON_FILES;
export const PWA_ICON_SIZES = [512, 192, 180] as const;

export function parsePwaIconRoute(pathname: string, basePath: string) {
  const prefix = `${basePath}/pwa-icon`;
  if (pathname === prefix) {
    return { kind: "upload" as const };
  }
  if (!pathname.startsWith(`${prefix}/`)) {
    return undefined;
  }
  const [token, file, ...extra] = pathname.slice(prefix.length + 1).split("/");
  if (token && /^[0-9a-f]{64}$/u.test(token) && extra.length === 0) {
    const size = PWA_ICON_SIZES.find((n) => PWA_ICON_FILES[n] === file);
    if (size || file === "manifest.webmanifest" || file === "install") {
      return { kind: "asset" as const, token, file, size };
    }
  }
  return { kind: "invalid" as const };
}
