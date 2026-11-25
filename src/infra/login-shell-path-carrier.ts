/** Carry a PATH prefix through shell startup without interpolating it as shell code. */
export function prependShellPath(
  command: string,
  env: Record<string, string>,
  prefix: string,
): string {
  env.OPENCLAW_PREPEND_PATH = prefix;
  return `export PATH="\${OPENCLAW_PREPEND_PATH}\${PATH:+:$PATH}"; unset OPENCLAW_PREPEND_PATH; ${command}`;
}
