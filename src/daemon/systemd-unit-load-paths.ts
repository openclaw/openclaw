/** Paths systemd can load user and system units from. */
import path from "node:path";

export const DEFAULT_SYSTEMD_SYSTEM_UNIT_DIRS = [
  "/etc/systemd/system",
  "/usr/lib/systemd/system",
  "/lib/systemd/system",
] as const;

export function resolveSystemdUnitLoadPaths(
  env: Record<string, string | undefined>,
  home: string,
  uid?: number,
): { runtimeRoots: string[]; userRoots: string[]; systemRoots: string[] } {
  const runtimeRoots = [
    ...new Set(
      [uid === undefined ? undefined : `/run/user/${uid}`, env.XDG_RUNTIME_DIR].filter(
        (value): value is string => Boolean(value),
      ),
    ),
  ];
  const configHome = env.XDG_CONFIG_HOME || path.posix.join(home, ".config");
  const dataHome = env.XDG_DATA_HOME || path.posix.join(home, ".local/share");
  const userRoots = [
    path.posix.join(home, ".config"),
    configHome,
    dataHome,
    ...(env.XDG_CONFIG_DIRS || "/etc/xdg").split(":"),
    ...(env.XDG_DATA_DIRS || "/usr/local/share:/usr/share").split(":"),
    "/etc",
    "/run",
    "/usr/local/lib",
    "/usr/lib",
    "/lib",
  ];
  return {
    runtimeRoots,
    userRoots: [...new Set(userRoots)],
    systemRoots: ["/etc", "/run", "/usr/local/lib", "/usr/lib", "/lib"],
  };
}

export function resolveSystemdUnitLoadDirectories(
  env: Record<string, string | undefined>,
  home: string,
  uid?: number,
): { userDirs: string[]; systemDirs: string[]; complete: boolean } {
  const { runtimeRoots, userRoots, systemRoots } = resolveSystemdUnitLoadPaths(env, home, uid);
  const roots = [...runtimeRoots, ...userRoots, ...systemRoots];
  const unitDirs = (sources: string[], kinds: string[]) =>
    sources
      .filter((root) => path.posix.isAbsolute(root))
      .flatMap((root) => kinds.map((kind) => path.posix.join(root, "systemd", kind)));
  const generatedDirs = (sources: string[]) =>
    unitDirs(sources, ["transient", "generator.early", "generator", "generator.late"]);
  return {
    userDirs: [
      ...unitDirs(
        [...new Set([...runtimeRoots, ...userRoots])],
        ["user", "user.control", "user.attached"],
      ),
      ...generatedDirs(runtimeRoots),
    ],
    systemDirs: [
      ...unitDirs(systemRoots, ["system", "system.control", "system.attached"]),
      ...generatedDirs(["/run"]),
    ],
    complete: uid !== undefined && !env.SYSTEMD_UNIT_PATH && roots.every(path.posix.isAbsolute),
  };
}
