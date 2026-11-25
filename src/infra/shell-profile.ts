import path from "node:path";

/** Shells resolve symlinks before `..`; do not normalize configured startup paths. */
export function appendShellProfilePath(
  directory: string,
  pathApi: typeof path.posix,
  ...segments: string[]
): string {
  const native = pathApi.sep === "\\" ? directory.replaceAll("/", pathApi.sep) : directory;
  return native + (native.endsWith(pathApi.sep) ? "" : pathApi.sep) + segments.join(pathApi.sep);
}

export function resolveShellConfigRoot(
  shell: "zsh" | "fish",
  env: NodeJS.ProcessEnv,
  home: string,
  pathApi = path.posix,
): string {
  if (shell === "zsh") {
    return env.ZDOTDIR === undefined ? home : env.ZDOTDIR || pathApi.sep;
  }
  return env.XDG_CONFIG_HOME && pathApi.isAbsolute(env.XDG_CONFIG_HOME)
    ? env.XDG_CONFIG_HOME
    : appendShellProfilePath(home, pathApi, ".config");
}
