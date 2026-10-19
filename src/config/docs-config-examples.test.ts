import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../state/openclaw-state-db-contract.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import {
  restoreStateDirEnv,
  setStateDirEnv,
  snapshotStateDirEnv,
} from "../test-helpers/state-dir-env.js";
import { auditDocsConfigExamples } from "./docs-config-examples.js";
import { resolveRepoBundledPluginEnv } from "./repo-bundled-plugin-env.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const pluginFence = (key: string, value: string) =>
  `\`\`\`json5\n{ plugins: { entries: { openai: { config: { ${key}: "${value}" } } } } }\n\`\`\``;
type SkipStat = "skippedFragment" | "skippedNonObject" | "skippedOptOut" | "skippedParseFailure";

function auditMarkdown(markdown: string): ReturnType<typeof auditDocsConfigExamples> {
  const repoRoot = tempDirs.make("openclaw-docs-config-");
  const docsRoot = path.join(repoRoot, "docs");
  fs.mkdirSync(docsRoot);
  fs.writeFileSync(path.join(docsRoot, "fixture.md"), markdown);
  return auditDocsConfigExamples({ repoRoot });
}

describe("docs config examples", () => {
  it.each<[string, string, SkipStat?, string?]>([
    [
      "reports a retired nested key in a whole config",
      "```json5\n{ agents: { defaults: { promptOverlays: {} } } }\n```",
      undefined,
      "agents.defaults",
    ],
    [
      "validates a canonical roster in an indented MDX component fence",
      '<Accordion title="Agent roster">\n    ```json5\n    { agents: { entries: { main: {} } } }\n    ````\n</Accordion>',
    ],
    [
      "skips a fragment without a recognized-key majority",
      "```json5\n{ agents: {}, payloads: [] }\n```",
      "skippedFragment",
    ],
    [
      "skips an explicit opt-out",
      '```json5 title="legacy config" validate=false\n{ agents: { defaults: { promptOverlays: {} } } }\n```',
      "skippedOptOut",
    ],
    ["skips invalid JSON5", "```json5\n{ agents: {\n```", "skippedParseFailure"],
    ["validates JSON fences", '```json\n{ "gateway": { "port": 18789 } }\n```'],
    [
      "validates JSONC tilde fences",
      '~~~JSONC\n{ // comment\n  "gateway": { "port": 18789 }\n}\n~~~',
    ],
    ["skips arrays", "```json5\n[{ gateway: {} }]\n```", "skippedNonObject"],
    [
      "reports a retired root key beside a recognized key",
      "```json5\n{ agents: {}, gateway: {}, promptOverlays: {} }\n```",
      undefined,
      "",
    ],
    [
      "reports a retired bundled channel key",
      '```json5\n{ channels: { slack: { identity: "bot" } } }\n```',
      undefined,
      "channels.slack",
    ],
    ["accepts a supported OpenAI plugin config value", pluginFence("personality", "off")],
    [
      "drops nested include directives before validation",
      '```json5\n{ agents: { $include: "./agents.json5" }, gateway: { port: 18789 } }\n```',
    ],
  ])("%s", (_name, markdown, skipped, issuePath) => {
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

  it("validates plugin-owned keys without opening the operator state database", () => {
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
    const envSnapshot = snapshotStateDirEnv();
    setStateDirEnv(poisonedRoot);
    try {
      const audit = auditMarkdown(pluginFence("personalityy", "friendly"));
      expect(audit.findings).toHaveLength(1);
      expect(audit.findings[0]?.issuePath).toBe("plugins.entries.openai.config");
      expect(fs.existsSync(resolveRepoBundledPluginEnv("unused").OPENCLAW_STATE_DIR!)).toBe(false);
    } finally {
      restoreStateDirEnv(envSnapshot);
    }
  });

  it("uses source schemas instead of another working directory's plugin tree", () => {
    const directory = tempDirs.make("openclaw-docs-config-cwd-");
    const pluginDir = path.join(directory, "extensions", "openai");
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(path.join(pluginDir, "index.js"), "export default {};\n");
    fs.writeFileSync(
      path.join(pluginDir, "openclaw.plugin.json"),
      JSON.stringify({
        id: "openai",
        configSchema: { type: "object", properties: {}, additionalProperties: false },
      }),
    );
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(directory);
    try {
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
    } finally {
      cwd.mockRestore();
    }
  });

  it("keeps real docs aligned with the config schema", () => {
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

    // This test is selected when src/config changes, so retiring a key checks docs even
    // without a docs edit. The check:docs script covers docs-only PRs; together the two
    // CI lanes leave no change-classification gap.
    expect(auditDocsConfigExamples({ repoRoot }).findings).toEqual([]);
  });
});
