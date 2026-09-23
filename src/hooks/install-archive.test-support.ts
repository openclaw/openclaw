import JSZip from "jszip";

export async function createZipBuffer(entries: Array<{ path: string; contents: string }>) {
  const zip = new JSZip();
  for (const entry of entries) {
    zip.file(entry.path, entry.contents);
  }
  return Buffer.from(await zip.generateAsync({ type: "nodebuffer", compression: "STORE" }));
}

export async function createZipHookPackBuffer(params: {
  packageName: string;
  hookName: string;
  hookDescription: string;
  heading: string;
}) {
  const packageJson = JSON.stringify({
    name: params.packageName,
    version: "0.0.1",
    openclaw: { hooks: [`./hooks/${params.hookName}`] },
  });
  return createZipBuffer([
    { path: "package/package.json", contents: packageJson },
    {
      path: `package/hooks/${params.hookName}/HOOK.md`,
      contents: [
        "---",
        `name: ${params.hookName}`,
        `description: ${params.hookDescription}`,
        'metadata: {"openclaw":{"events":["command:new"]}}',
        "---",
        "",
        `# ${params.heading}`,
      ].join("\n"),
    },
    {
      path: `package/hooks/${params.hookName}/handler.ts`,
      contents: "export default async () => {};\n",
    },
  ]);
}
