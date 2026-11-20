import fs from "node:fs/promises";
import path from "node:path";
import { readTemplateManifestFile } from "../../templates/reader.js";

export const coordinate = { packageName: "@fixture/travel-copilot", version: "0.2.8" };
export const trust = {
  riskAcknowledgementRequired: false,
  trustRecord: {
    clawhubTrustDisposition: "clean" as const,
    clawhubTrustCheckedAt: "2026-11-12T00:00:00.000Z",
  },
};
export const skillIntegrity = `sha256-${Buffer.from("a".repeat(64), "hex").toString("base64")}`;
export const expedia = { ref: "@expediagroup/expedia-openclaw", version: "1.0.4" };

/** Dependency-only control: referenced plugins await user consent, not a scheduler row. */
export const travelCopilot = {
  schemaVersion: 1,
  agent: {
    id: "travel-copilot",
    name: "Travel Copilot",
    tools: { profile: "minimal", alsoAllow: ["web_fetch"] },
  },
  workspace: {
    bootstrapFiles: { "SOUL.md": { source: "workspace/SOUL.md" } },
    files: [{ path: "reference/airports.md", source: "workspace/reference/airports.md" }],
  },
  skills: [{ ref: "@steipete/goplaces", version: "1.0.0" }, { path: "skills/itinerary" }],
  plugins: [expedia, { path: "plugins/trip-notes" }],
  mcpServers: { docs: { url: "https://mcp.example.com/docs", transport: "streamable-http" } },
};

export async function writeTemplate(
  root: string,
  manifest: Record<string, unknown> = travelCopilot,
) {
  const files: Record<string, string> = {
    "package.json": JSON.stringify({
      ...coordinate,
      name: coordinate.packageName,
      openclaw: { template: "CLAW.md" },
    }),
    "CLAW.md": `---\n${JSON.stringify(manifest)}\n---\n`,
    "BOOTSTRAP.md": "Ask where the traveller wants to go first.\n",
    "workspace/SOUL.md": "Plan practical trips.\n",
    "workspace/reference/airports.md": "LIS: Lisbon.\n",
    "workspace/CLAW.md": "The Template's own notes.\n",
    "skills/itinerary/SKILL.md":
      "---\nname: itinerary\ndescription: Build a day-by-day itinerary.\n---\nList each day.\n",
    "plugins/trip-notes/package.json": JSON.stringify({
      name: "trip-notes",
      version: "1.0.0",
      type: "module",
      openclaw: { extensions: ["./index.js"] },
    }),
    "plugins/trip-notes/openclaw.plugin.json": JSON.stringify({
      id: "trip-notes",
      configSchema: { type: "object", properties: {} },
    }),
    "plugins/trip-notes/index.js": "export default { id: 'trip-notes', register() {} };\n",
  };
  for (const [name, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await fs.writeFile(path.join(root, name), content);
  }
  const source = await readTemplateManifestFile(root);
  if (!source.ok) {
    throw new Error(JSON.stringify(source.diagnostics));
  }
  source.source = {
    ...source.source,
    kind: "package",
    name: coordinate.packageName,
    version: coordinate.version,
    integrityKind: "artifact",
  };
  return source;
}

export const exists = (file: string) =>
  fs.stat(file).then(
    () => true,
    () => false,
  );
