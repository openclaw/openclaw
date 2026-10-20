import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  materializeCodexDynamicToolSnapshot,
  materializeCodexPromptSnapshot,
  materializeCodexPromptSnapshotDelta,
} from "../../scripts/generate-prompt-snapshots.js";
import { deleteStalePromptSnapshotFiles } from "../../scripts/prompt-snapshot-files.js";
import {
  CODEX_MODEL_PROMPT_FIXTURE_DIR as SYNC_CODEX_MODEL_PROMPT_FIXTURE_DIR,
  defaultCatalogPathCandidates,
  findDefaultCatalogPath,
  runCodexModelPromptFixtureSync,
} from "../../scripts/sync-codex-model-prompt-fixture.js";
import { getPluginModuleLoaderStats } from "../../src/plugins/plugin-module-loader-cache.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../../src/state/openclaw-state-db-contract.js";
import { resolveOpenClawStateSqlitePath } from "../../src/state/openclaw-state-db.paths.js";
import {
  restoreStateDirEnv,
  setStateDirEnv,
  snapshotStateDirEnv,
} from "../../src/test-helpers/state-dir-env.js";
import { createHappyPathPromptSnapshotFiles } from "../helpers/agents/happy-path-prompt-snapshots.js";
import {
  CODEX_MODEL_PROMPT_FIXTURE_DIR,
  CODEX_PROMPT_SNAPSHOT_BASE_SCENARIO,
  CODEX_PROMPT_SNAPSHOT_FILES,
  CODEX_RUNTIME_HAPPY_PATH_PROMPT_SNAPSHOT_DIR,
  LOCAL_OLLAMA_PROMPT_SNAPSHOT_DIR,
} from "../helpers/agents/prompt-snapshot-paths.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const personaFiles = ["SOUL.md", "IDENTITY.md", "USER.md"];
const baseFile = CODEX_PROMPT_SNAPSHOT_FILES[CODEX_PROMPT_SNAPSHOT_BASE_SCENARIO];
type Tool = {
  name: string;
  deferLoading?: boolean;
  inputSchema?: unknown;
  tools?: Tool[];
};
const readText = (...parts: string[]) => fs.readFileSync(path.join(...parts), "utf8");
function writeFixture(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
}

function readCommittedSnapshot(fileName: string): string {
  return readText(CODEX_RUNTIME_HAPPY_PATH_PROMPT_SNAPSHOT_DIR, fileName);
}

function renderedPromptSection(content: string, heading: string, nextHeading: string): string {
  const start = content.indexOf(heading);
  const end = content.indexOf(nextHeading, start + heading.length);
  if (start === -1 || end === -1) {
    throw new Error(`Missing rendered prompt section ${heading}`);
  }
  return content.slice(start, end);
}

function renderedJson<T>(
  content: string,
  heading = "## Turn Start Params",
  nextHeading = "## Reconstructed Model-Bound Prompt Layers",
): T {
  return JSON.parse(
    renderedPromptSection(content, heading, nextHeading).match(/```json\n([\s\S]*?)\n```/u)![1]!,
  );
}

let generated: Awaited<ReturnType<typeof createHappyPathPromptSnapshotFiles>>;
let pluginLoaderCallsBefore: number;
let pluginLoaderCallsAfter: number;
let poisonedStateRoot: string | undefined;
const stateDirEnv = snapshotStateDirEnv();
function generatedContent(fileName: string) {
  const file = generated.find((entry) => path.basename(entry.path) === fileName);
  expect(file, `missing generated snapshot: ${fileName}`).toBeDefined();
  return file!.content;
}

describe("happy path prompt snapshots", () => {
  beforeAll(async () => {
    poisonedStateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-prompt-snapshot-poison-"));
    const databasePath = resolveOpenClawStateSqlitePath({
      ...process.env,
      OPENCLAW_STATE_DIR: poisonedStateRoot,
    });
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    const database = new DatabaseSync(databasePath);
    try {
      database.exec(`PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION + 1}`);
    } finally {
      database.close();
    }
    setStateDirEnv(poisonedStateRoot);

    // Optional media credentials must not widen or cold-load the pinned tool catalog.
    vi.stubEnv("OPENAI_API_KEY", "test-prompt-snapshot-openai");
    vi.stubEnv("ZAI_API_KEY", "test-prompt-snapshot-zai");
    pluginLoaderCallsBefore = getPluginModuleLoaderStats().calls;
    generated = await createHappyPathPromptSnapshotFiles();
    pluginLoaderCallsAfter = getPluginModuleLoaderStats().calls;
  }, 300_000);

  afterAll(() => {
    vi.unstubAllEnvs();
    restoreStateDirEnv(stateDirEnv);
    if (poisonedStateRoot) {
      fs.rmSync(poisonedStateRoot, { recursive: true, force: true });
    }
  });

  it("reconstructs complete Codex tool catalogs from readable full-tool overrides", async () => {
    const scenarios = [
      { name: "telegram-direct", replacements: [] },
      { name: "discord-group", replacements: ["sessions_spawn"] },
      // Heartbeat turns offer the session's catalog, so the provider prompt cache holds.
      { name: "heartbeat-turn", replacements: [] },
    ];

    for (const { name, replacements } of scenarios) {
      const fileName = `codex-dynamic-tools.${name}.json`;
      const expected = generatedContent(fileName);

      const committed = JSON.parse(readCommittedSnapshot(fileName)) as
        | Tool[]
        | { base: string; replace: Record<string, Tool> };
      if (Array.isArray(committed)) {
        expect(replacements).toEqual([]);
      } else {
        expect(committed.base).toBe("codex-dynamic-tools.telegram-direct.json");
        expect(Object.keys(committed.replace)).toEqual(replacements);
        for (const [toolName, tool] of Object.entries(committed.replace)) {
          expect(tool.name).toBe(toolName);
          expect(tool.inputSchema !== undefined || Array.isArray(tool.tools)).toBe(true);
        }
      }

      const materialized = await materializeCodexDynamicToolSnapshot(name);
      expect(JSON.parse(materialized)).toEqual(JSON.parse(expected));

      if (name === "telegram-direct") {
        const specs = JSON.parse(expected) as Array<Tool & { type: "function" | "namespace" }>;
        const directFunctions = specs.filter((spec) => spec.type === "function");
        const searchableNamespace = specs.find(
          (spec) => spec.type === "namespace" && spec.name === "openclaw",
        );
        const spawn = directFunctions.find((spec) => spec.name === "sessions_spawn");
        expect(spawn).toMatchObject({ name: "sessions_spawn" });
        expect(spawn).not.toHaveProperty("deferLoading");
        for (const toolName of ["session_status", "web_fetch", "web_search"]) {
          expect(searchableNamespace?.tools).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ name: toolName, deferLoading: true }),
            ]),
          );
          expect(directFunctions.find((spec) => spec.name === toolName)).toBeUndefined();
        }
      }
    }
  });

  it("rejects invalid Codex dynamic-tool materialization scenarios", async () => {
    await expect(materializeCodexDynamicToolSnapshot("../outside")).rejects.toThrow(
      "Invalid Codex dynamic-tool snapshot scenario",
    );
  });

  it("rejects unknown and noncanonical Codex prompt deltas", async () => {
    await expect(materializeCodexPromptSnapshot("../outside")).rejects.toThrow(
      "Unknown Codex prompt snapshot scenario",
    );
    const scenario = "discord-group";
    const fileName = CODEX_PROMPT_SNAPSHOT_FILES[scenario];
    const base = readCommittedSnapshot(baseFile);
    const delta = readCommittedSnapshot(`${fileName}.diff`);
    const corruptions = [
      `${delta}\ntrailing text\n`,
      delta.replace("\n", "\r\n"),
      `${delta}\n${delta}`,
      delta.replace(fileName, "wrong.md"),
      delta.replace(/sha256=[a-f0-9]{64}/u, `sha256=${"0".repeat(64)}`),
    ];
    for (const corrupt of corruptions) {
      expect(() => materializeCodexPromptSnapshotDelta({ scenario, base, delta: corrupt })).toThrow(
        /Codex prompt snapshot/u,
      );
    }
  });

  it("generates snapshots without jiti plugin-loader fallbacks", async () => {
    // A jiti fallback re-evaluates the core graph and stalls this lane by minutes.
    expect(generated.length).toBeGreaterThan(0);
    const stats = getPluginModuleLoaderStats();
    expect(
      pluginLoaderCallsAfter - pluginLoaderCallsBefore,
      `prompt snapshot generation hit the jiti plugin loader; targets: ${stats.topSourceTransformTargets
        .map((entry) => entry.target)
        .join(", ")}`,
    ).toBe(0);
  });

  it("deletes stale generated snapshot artifacts", async () => {
    const root = tempDirs.make("openclaw-prompt-snapshot-stale-");
    const stalePaths = ["stale-snapshot.md", "stale-snapshot.md.patch"].map((fileName) =>
      path.join(CODEX_RUNTIME_HAPPY_PATH_PROMPT_SNAPSHOT_DIR, fileName),
    );
    stalePaths.push(path.join(LOCAL_OLLAMA_PROMPT_SNAPSHOT_DIR, "stale-snapshot.json"));
    const currentPath = path.join(
      CODEX_RUNTIME_HAPPY_PATH_PROMPT_SNAPSHOT_DIR,
      "current-snapshot.md.diff",
    );
    for (const stalePath of stalePaths) {
      writeFixture(path.join(root, stalePath), "stale\n");
    }
    writeFixture(path.join(root, currentPath), "current\n");

    const deleted = await deleteStalePromptSnapshotFiles(root, [{ path: currentPath }]);

    expect(deleted.toSorted()).toEqual(stalePaths.toSorted());
    for (const stalePath of stalePaths) {
      expect(fs.existsSync(path.join(root, stalePath))).toBe(false);
    }
    expect(fs.readFileSync(path.join(root, currentPath), "utf8")).toBe("current\n");
  });

  it("renders every additional-context value with its native role before the current input", () => {
    const telegram = generatedContent(baseFile);
    const turn = renderedJson<{
      additionalContext: Record<string, { kind: "application" | "untrusted"; value: string }>;
    }>(telegram);
    expect(Object.keys(turn.additionalContext)).toEqual(
      expect.arrayContaining(["openclaw_current_sender", "openclaw_temporal_context"]),
    );
    let previous = telegram.indexOf("### Developer: Codex Collaboration Mode Instructions");
    const userInput = telegram.indexOf("### User: Turn Input Text");
    const contextTexts: string[] = [];
    // Canonical ASCII keys in Codex's BTreeMap order, independent of the renderer's sorter.
    const keyOrder = [
      "openclaw_active_computer",
      "openclaw_current_sender",
      "openclaw_source_delivery",
      "openclaw_temporal_context",
    ].filter((key) => Object.hasOwn(turn.additionalContext, key));
    expect(keyOrder).toHaveLength(Object.keys(turn.additionalContext).length);
    for (const key of keyOrder) {
      const entry = turn.additionalContext[key]!;
      const role = entry.kind === "application" ? "Developer" : "User";
      const tag = entry.kind === "application" ? key : `external_${key}`;
      const index = telegram.indexOf(`### ${role}: OpenClaw Additional Context (${key})`);
      expect(index).toBeGreaterThan(previous);
      expect(index).toBeLessThan(userInput);
      const text = `<${tag}>${entry.value}</${tag}>`;
      expect(telegram.slice(index, userInput)).toContain(text);
      contextTexts.push(text);
      previous = index;
    }
    const stats = renderedJson<{ additionalContext: { chars: number } }>(
      telegram,
      "### Rough Text Token Estimates",
      "### System: Codex Model Instructions",
    );
    expect(stats.additionalContext.chars).toBe(contextTexts.join("\n\n").length);
  });

  it("keeps managed persona outside native collaboration and user-input history", async () => {
    for (const scenario of ["telegram-direct", "discord-group", "heartbeat-turn"]) {
      const snapshot = await materializeCodexPromptSnapshot(scenario);
      const turn = renderedJson<{
        collaborationMode: { settings: { developer_instructions: string | null } };
      }>(snapshot);
      expect(turn.collaborationMode.settings.developer_instructions).toBeNull();
      const parentLocal = renderedPromptSection(
        snapshot,
        "### Request Instructions: OpenClaw Parent-Local Context",
        "### Developer: Codex Permission Instructions",
      );
      expect(parentLocal).toContain("## OpenClaw Agent Soul");
      for (const name of personaFiles) {
        expect(parentLocal).toContain("<" + name + " contents will be here>");
      }
      const boundaries = [
        "### Developer: OpenClaw Runtime Instructions",
        "### Developer: Codex Collaboration Mode Instructions",
        "### User: Turn Input Text",
        "### Tools: Dynamic Tool Catalog",
      ];
      const history = boundaries
        .slice(0, -1)
        .map((heading, index) => renderedPromptSection(snapshot, heading, boundaries[index + 1]!));
      for (const nativeHistory of history) {
        expect(nativeHistory).not.toMatch(/<(?:SOUL|IDENTITY|USER)\.md contents will be here>/);
      }
      expect(history[1]).not.toContain("HEARTBEAT.md");
      expect(snapshot).not.toContain("Heartbeat = useful proactive progress");
      expect(snapshot).not.toContain("This is an OpenClaw heartbeat turn.");
      expect(snapshot).not.toContain("simulatedHeartbeatWorkspaceFile");
    }
  });
  it("keeps the Codex model prompt fixture next to its source metadata", () => {
    expect(SYNC_CODEX_MODEL_PROMPT_FIXTURE_DIR).toBe(CODEX_MODEL_PROMPT_FIXTURE_DIR);
    for (const suffix of ["instructions.md", "source.json"]) {
      expect(
        fs.existsSync(path.join(CODEX_MODEL_PROMPT_FIXTURE_DIR, `gpt-5.5.pragmatic.${suffix}`)),
      ).toBe(true);
    }
  });

  it("prefers the Codex runtime model cache before local checkout fallbacks", () => {
    const candidates = defaultCatalogPathCandidates({
      env: { CODEX_HOME: "/tmp/codex-home" },
      homeDir: "/tmp/home",
    });

    expect(candidates).toEqual([
      path.join("/tmp/codex-home", "models_cache.json"),
      path.join("/tmp/home", ".codex", "models_cache.json"),
      path.join("/tmp/home", "code", "codex", "codex-rs", "models-manager", "models.json"),
    ]);
  });

  it("finds the first available default Codex model catalog source", async () => {
    const root = tempDirs.make("openclaw-codex-catalog-");
    const cachePath = path.join(root, ".codex", "models_cache.json");
    writeFixture(cachePath, { models: [] });

    await expect(findDefaultCatalogPath({ env: {}, homeDir: root })).resolves.toEqual({
      catalogPath: cachePath,
      candidates: [
        cachePath,
        path.join(root, "code", "codex", "codex-rs", "models-manager", "models.json"),
      ],
    });
  });

  it("skips Codex model prompt fixture sync when no default catalog exists", async () => {
    const root = tempDirs.make("openclaw-codex-catalog-missing-");
    const chunks: string[] = [];
    const result = await runCodexModelPromptFixtureSync([], {
      env: {},
      homeDir: root,
      stdout: {
        write(chunk) {
          chunks.push(chunk);
        },
      },
    });

    expect(result.status).toBe("skipped");
    expect(chunks.join("")).toContain("No Codex model catalog/cache found");
  });

  it("writes Codex model prompt fixtures from an explicit catalog", async () => {
    const root = tempDirs.make("openclaw-codex-catalog-write-");
    const catalogPath = path.join(root, "models_cache.json");
    const outputDir = path.join(root, "out");
    writeFixture(catalogPath, {
      models: [
        {
          slug: "gpt-6-astra",
          base_instructions: "fallback",
          model_messages: {
            instructions_template: "System\n{{ personality }}\nEnd",
            instructions_variables: {
              personality_pragmatic: "Use terse engineering judgement.",
            },
          },
        },
      ],
    });

    const result = await runCodexModelPromptFixtureSync([
      "--catalog",
      catalogPath,
      "--source-label",
      "<test-catalog>",
      "--catalog-git-head",
      "abc123",
      "--out-dir",
      outputDir,
    ]);

    expect(result.status).toBe("written");
    expect(readText(outputDir, "gpt-6-astra.pragmatic.instructions.md")).toBe(
      "System\nUse terse engineering judgement.\nEnd\n",
    );
    expect(JSON.parse(readText(outputDir, "gpt-6-astra.pragmatic.source.json"))).toEqual({
      model: "gpt-6-astra",
      personality: "pragmatic",
      source: {
        catalogPath: "<test-catalog>",
        catalogKind: "models_cache",
        catalogGitHead: "abc123",
        field:
          "model_messages.instructions_template + model_messages.instructions_variables.personality_pragmatic",
      },
    });
  });
});
