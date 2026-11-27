/** Settings.Enabled handling for Scheduled Task XML as Task Scheduler exports it. */
export function parseScheduledTaskXmlEnabled(output: string): boolean | null {
  const normalized = output.replace(/^\uFEFF/u, "").replaceAll(String.fromCharCode(0), "");
  const settings = /<Settings(?:\s[^>]*)?>([\s\S]*?)<\/Settings>/iu.exec(normalized)?.[1];
  if (settings === undefined) {
    return null;
  }
  const enabled = /<Enabled>\s*(true|false)\s*<\/Enabled>/iu.exec(settings)?.[1];
  // Task Scheduler's schema defaults a missing Settings.Enabled value to true.
  return enabled === undefined ? true : enabled.toLowerCase() === "true";
}

export function setScheduledTaskXmlEnabled(xml: string, enabled: boolean): string {
  if (parseScheduledTaskXmlEnabled(xml) === null) {
    throw new Error("Scheduled Task enabled state could not be inspected.");
  }
  return xml.replace(
    /(<Settings(?:\s[^>]*)?>)([\s\S]*?)(<\/Settings>)/iu,
    (_match, open: string, body: string, close: string) => {
      const value = `<Enabled>${enabled}</Enabled>`;
      const field = /<Enabled>\s*(true|false)\s*<\/Enabled>/iu;
      return `${open}${field.test(body) ? body.replace(field, value) : `${value}${body}`}${close}`;
    },
  );
}

/**
 * Registration bytes without Settings.Enabled. Task Scheduler exports omit Enabled=true and place
 * false in schema order, so enable-only differences must not depend on where it is serialized.
 */
export function scheduledTaskXmlPolicy(xml: string): string {
  if (parseScheduledTaskXmlEnabled(xml) === null) {
    throw new Error("Scheduled Task enabled state could not be inspected.");
  }
  return xml.replace(
    /(<Settings(?:\s[^>]*)?>)([\s\S]*?)(<\/Settings>)/iu,
    (_match, open: string, body: string, close: string) =>
      `${open}${body.replace(/(?:\r{0,2}\n[\t ]*)?<Enabled>\s*(?:true|false)\s*<\/Enabled>/iu, "")}${close}`,
  );
}

export function sameScheduledTaskRegistration(left: string, right: string): boolean {
  const enabled = parseScheduledTaskXmlEnabled(left);
  return (
    left === right ||
    (enabled !== null &&
      enabled === parseScheduledTaskXmlEnabled(right) &&
      scheduledTaskXmlPolicy(left) === scheduledTaskXmlPolicy(right))
  );
}
