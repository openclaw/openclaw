export function extractFunctionBody(source: string, name: string): string {
  const lines = source.split(/\r?\n/u);
  const start = lines.indexOf(`function ${name} {`);
  if (start < 0) {
    throw new Error(`Missing PowerShell function body ${name}`);
  }
  const body: string[] = [];
  let hereStringEnd: string | undefined;
  for (const line of lines.slice(start + 1)) {
    if (hereStringEnd) {
      if (line.startsWith(hereStringEnd)) {
        hereStringEnd = undefined;
      }
    } else if (line === "}") {
      return `${body.join("\n")}\n`;
    } else {
      const hereStringStart = /(?:^|[\s=])@(['"])\s*$/u.exec(line);
      if (hereStringStart) {
        hereStringEnd = `${hereStringStart[1]}@`;
      }
    }
    body.push(line);
  }
  throw new Error(`Missing PowerShell function body ${name}`);
}
