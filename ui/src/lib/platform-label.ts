const PLATFORM_DISPLAY_NAMES = new Map<string, string>([
  ["macos", "macOS"],
  ["darwin", "macOS"],
  ["win32", "Windows"],
  ["win64", "Windows"],
  ["windows", "Windows"],
  ["linux", "Linux"],
  ["freebsd", "FreeBSD"],
  ["openbsd", "OpenBSD"],
  ["netbsd", "NetBSD"],
  ["ios", "iOS"],
  ["ipados", "iPadOS"],
  ["watchos", "watchOS"],
  ["android", "Android"],
  ["web", "Web"],
]);

const MAC_ARCHITECTURES = new Map<string, string>([
  ["macarm", "ARM"],
  ["macarm64", "ARM"],
  ["arm64-apple-darwin", "ARM"],
  ["aarch64-apple-darwin", "ARM"],
  ["x86_64-apple-darwin", "Intel"],
]);

const ARCHITECTURE_DISPLAY_NAMES = new Map<string, string>([
  ["arm", "ARM"],
  ["arm64", "ARM"],
  ["aarch64", "ARM"],
  ["armv7l", "ARM"],
  ["armv8l", "ARM"],
  ["x64", "x64"],
  ["x86_64", "x64"],
  ["amd64", "x64"],
  ["x86", "x86"],
  ["i386", "x86"],
  ["i686", "x86"],
]);

export function describePlatform(
  platform: string,
  deviceFamily?: string | null,
): { label: string; architecture?: string } {
  const [name = "", ...rest] = platform.trim().split(/\s+/u);
  const macArchitecture = MAC_ARCHITECTURES.get(name.toLowerCase());
  const suffixArchitecture = ARCHITECTURE_DISPLAY_NAMES.get(rest.at(-1)?.toLowerCase() ?? "");
  if (suffixArchitecture) {
    rest.pop();
  }
  // MacIntel is also reported by Apple silicon Macs and desktop-mode iPads; it is not a CPU hint.
  if (name.toLowerCase() === "macintel" && (deviceFamily === "Mac" || deviceFamily === "iPad")) {
    return {
      label: [deviceFamily === "Mac" ? "macOS" : "iPadOS", ...rest].join(" "),
      architecture: suffixArchitecture,
    };
  }
  // Mixed-case names ("iOS") are already branded; only capitalize all-lowercase input.
  const fallback =
    name === name.toLowerCase() ? `${name.charAt(0).toUpperCase()}${name.slice(1)}` : name;
  const displayName = macArchitecture
    ? "macOS"
    : (PLATFORM_DISPLAY_NAMES.get(name.toLowerCase()) ?? fallback);
  return {
    label: [displayName, ...rest].join(" "),
    architecture: macArchitecture ?? suffixArchitecture,
  };
}

export function prettifyPlatform(platform: string, deviceFamily?: string | null): string {
  const { label, architecture } = describePlatform(platform, deviceFamily);
  return architecture ? `${label} (${architecture})` : label;
}
