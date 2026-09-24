// Fixture adapter for native plutil output on non-macOS test hosts. Only the
// generated XML fixture subset is supported; native validation is tested separately.
export function decodeLaunchAgentPlistFixture(
  input: string | Uint8Array,
  format: string | undefined,
) {
  const xml = typeof input === "string" ? input : Buffer.from(input).toString("utf8");
  if (format === "xml1") {
    return { stdout: xml, stderr: "" };
  }
  if (format !== "json") {
    throw new Error(`Unsupported plist fixture format: ${format}`);
  }
  const decode = (value: string) =>
    value
      .replaceAll("&apos;", "'")
      .replaceAll("&quot;", '"')
      .replaceAll("&gt;", ">")
      .replaceAll("&lt;", "<")
      .replaceAll("&amp;", "&");
  const args = xml.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/)?.[1];
  const environment = xml.match(/<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/)?.[1];
  const scalarFields = Object.fromEntries(
    Array.from(
      xml
        .replace(/<key>EnvironmentVariables<\/key>\s*<dict>[\s\S]*?<\/dict>/, "")
        .matchAll(
          /<key>([^<]*)<\/key>\s*(?:<(string|integer)>([\s\S]*?)<\/\2>|<(true|false)\s*\/>)/g,
        ),
      (match) => [
        decode(match[1] ?? ""),
        match[4]
          ? match[4] === "true"
          : match[2] === "integer"
            ? Number(match[3])
            : decode(match[3] ?? ""),
      ],
    ),
  );
  const arrayFields = Object.fromEntries(
    Array.from(xml.matchAll(/<key>([^<]*)<\/key>\s*<array>([\s\S]*?)<\/array>/g), (match) => [
      decode(match[1] ?? ""),
      Array.from((match[2] ?? "").matchAll(/<string>([\s\S]*?)<\/string>/g), (item) =>
        decode(item[1] ?? ""),
      ),
    ]),
  );
  return {
    stdout: JSON.stringify({
      ...scalarFields,
      ...arrayFields,
      ProgramArguments:
        args === undefined
          ? undefined
          : Array.from(args.matchAll(/<string>([\s\S]*?)<\/string>/g), (match) =>
              decode(match[1] ?? ""),
            ),
      WorkingDirectory: xml.match(
        /<key>WorkingDirectory<\/key>\s*<string>([\s\S]*?)<\/string>/,
      )?.[1],
      EnvironmentVariables:
        environment === undefined
          ? undefined
          : Object.fromEntries(
              Array.from(
                environment.matchAll(/<key>([\s\S]*?)<\/key>\s*<string>([\s\S]*?)<\/string>/g),
                (match) => [decode(match[1] ?? ""), decode(match[2] ?? "")],
              ),
            ),
    }),
    stderr: "",
  };
}
