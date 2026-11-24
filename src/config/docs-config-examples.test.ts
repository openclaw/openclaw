import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../state/openclaw-state-db-contract.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { auditDocsConfigExamples } from "./docs-config-examples.js";
import { resolveRepoBundledPluginEnv } from "./repo-bundled-plugin-env.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
const fence = (body: string, info = "json5") => `\`\`\`${info}\n${body}\n\`\`\``;
const pluginFence = (key: string, value: string) =>
  fence(`{ plugins: { entries: { openai: { config: { ${key}: "${value}" } } } } }`);
type SkipStat = "skippedFragment" | "skippedNonObject" | "skippedOptOut" | "skippedParseFailure";

function auditMarkdown(markdown: string): ReturnType<typeof auditDocsConfigExamples> {
  const repoRoot = tempDirs.make("openclaw-docs-config-");
  const docsRoot = path.join(repoRoot, "docs");
  fs.mkdirSync(docsRoot);
  fs.writeFileSync(path.join(docsRoot, "fixture.md"), markdown);
  return auditDocsConfigExamples({ repoRoot });
}

describe("docs config examples", () => {
  it.each<[string, SkipStat?, string?]>([
    [fence("{ agents: { defaults: { promptOverlays: {} } } }"), undefined, "agents.defaults"],
    [
      '<Accordion title="Agent roster">\n    ```json5\n    { agents: { entries: { main: {} } } }\n    ````\n</Accordion>',
    ],
    [fence("{ agents: {}, payloads: [] }"), "skippedFragment"],
    [
      '```json5 title="legacy config" validate=false\n{ agents: { defaults: { promptOverlays: {} } } }\n```',
      "skippedOptOut",
    ],
    [fence("{ agents: {"), "skippedParseFailure"],
    [fence('{ "gateway": { "port": 18789 } }', "json")],
    ['~~~JSONC\n{ // comment\n  "gateway": { "port": 18789 }\n}\n~~~'],
    [fence("[{ gateway: {} }]"), "skippedNonObject"],
    [fence("{ agents: {}, gateway: {}, promptOverlays: {} }"), undefined, ""],
    [fence('{ channels: { slack: { identity: "bot" } } }'), undefined, "channels.slack"],
    [fence('{ agents: { $include: "./agents.json5" }, gateway: { port: 18789 } }')],
  ])("audits %s", (markdown, skipped, issuePath) => {
    const audit = auditMarkdown(markdown);
    expect(audit.findings).toHaveLength(issuePath !== undefined ? 1 : 0);
    expect(audit.stats.candidatesValidated).toBe(skipped ? 0 : 1);
    if (skipped) {
      expect(audit.stats[skipped]).toBe(1);
    }
    if (issuePath !== undefined) {
      expect(audit.findings[0]?.issuePath).toBe(issuePath);
    }
  });

  it("uses source plugin schemas without reading operator state or the cwd plugin tree", () => {
    const poisonedRoot = tempDirs.make("openclaw-docs-config-poison-");
    const databasePath = resolveOpenClawStateSqlitePath({
      ...process.env,
      OPENCLAW_STATE_DIR: poisonedRoot,
    });
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    const database = new DatabaseSync(databasePath);
    try {
      database.exec(`PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION + 1}`);
    } finally {
      database.close();
    }
    vi.stubEnv("OPENCLAW_STATE_DIR", poisonedRoot);
    const pluginDir = path.join(poisonedRoot, "extensions", "openai");
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(path.join(pluginDir, "index.js"), "export default {};\n");
    fs.writeFileSync(
      path.join(pluginDir, "openclaw.plugin.json"),
      JSON.stringify({
        id: "openai",
        configSchema: { type: "object", properties: {}, additionalProperties: false },
      }),
    );
    vi.spyOn(process, "cwd").mockReturnValue(poisonedRoot);
    const audit = auditMarkdown(
      [pluginFence("personality", "off"), pluginFence("personalityy", "friendly")].join("\n"),
    );
    expect(audit.stats.candidatesValidated).toBe(2);
    expect(audit.findings).toEqual([
      expect.objectContaining({
        issuePath: "plugins.entries.openai.config",
        message: expect.stringContaining('"personalityy"'),
      }),
    ]);
    expect(fs.existsSync(resolveRepoBundledPluginEnv("unused").OPENCLAW_STATE_DIR!)).toBe(false);
  });

  it("keeps real docs aligned with the config schema", () => {
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
    expect(auditDocsConfigExamples({ repoRoot }).findings).toEqual([]);
  });
});
