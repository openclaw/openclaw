/**
 * The claw's name from its address "<name>-<account tag>.<domain>", or the
 * whole first label when it carries no tag.
 */
export function clawNameFromHostname(hostname: string): string {
  const label = hostname.split(".")[0] ?? hostname;
  const dash = label.lastIndexOf("-");
  return dash > 0 ? label.slice(0, dash) : label;
}
