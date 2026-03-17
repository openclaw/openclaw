export type PluginsCommand =
  | { action: "list" }
  | { action: "show"; name?: string }
  | { action: "enable"; name: string }
  | { action: "disable"; name: string }
  | { action: "error"; message: string };

export function parsePluginsCommand(raw: string): PluginsCommand | null {
  const match = raw.match(/^\/plugins?(?:\s+(.*))?$/i);
  if (!match) {
    return null;
  }

  const tail = match[1]?.trim() ?? "";
  if (!tail) {
    return { action: "list" };
  }

  const [rawAction, ...rest] = tail.split(/\s+/);
  const action = rawAction?.trim().toLowerCase();
  const name = rest.join(" ").trim();

  if (action === "list") {
    return name
      ? { action: "error", message: "Usage: /plugins list|show|get|enable|disable [plugin]" }
      : { action: "list" };
  }

  if (action === "show" || action === "get") {
    return { action: "show", name: name || undefined };
  }

  if (action === "enable" || action === "disable") {
    if (!name) {
      return {
        action: "error",
        message: `Usage: /plugins ${action} <plugin-id-or-name>`,
      };
    }
    return { action, name };
  }

  return {
    action: "error",
    message: "Usage: /plugins list|show|get|enable|disable [plugin]",
  };
}
