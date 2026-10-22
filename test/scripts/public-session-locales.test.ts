import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "tsdown";
import { describe, expect, it } from "vitest";
import type { TranslationMemoryEntry } from "../../scripts/lib/control-ui-i18n-sync-plan.ts";
import {
  createPublicSessionLocalesPlugin,
  loadPublicSessionLocales,
} from "../../scripts/lib/public-session-locales.mts";
import { createRunNodePathClassifier } from "../../scripts/run-node-watch-paths.mts";
import { createScriptTestHarness } from "./test-helpers.js";

const { createTempDir } = createScriptTestHarness();

function memoryEntry(
  key: string,
  text: string,
  translated: string,
  aliases?: string[],
): TranslationMemoryEntry {
  return {
    cache_key: key,
    segment_id: key,
    segment_ids: aliases,
    source_path: "fixture.ts",
    src_lang: "en",
    tgt_lang: "fr",
    text,
    text_hash: createHash("sha256").update(text).digest("hex"),
    translated,
    updated_at: "2026-01-01T00:00:00Z",
  };
}

describe("public reader locale build", () => {
  it("rebuilds runtime dictionaries when canonical memory changes, not locale reports", () => {
    const classifier = createRunNodePathClassifier();
    expect(classifier.isBuildRelevantRunNodePath("ui/src/i18n/.i18n/fr.tm.jsonl")).toBe(true);
    expect(classifier.isRestartRelevantRunNodePath("ui/src/i18n/.i18n/fr.tm.jsonl")).toBe(true);
    expect(classifier.isBuildRelevantRunNodePath("ui/src/i18n/.i18n/fr.meta.json")).toBe(false);
  });

  it("ships only current reader translations, including grouped aliases, without runtime files", async () => {
    const root = createTempDir("public-reader-locales-");
    const entry = path.join(root, "src/gateway/control-ui-public-session-locales.ts");
    fs.mkdirSync(path.dirname(entry), { recursive: true });
    fs.copyFileSync("src/gateway/control-ui-public-session-locales.ts", entry);
    const memoryPath = path.join(root, "ui/src/i18n/.i18n/fr.tm.jsonl");
    fs.mkdirSync(path.dirname(memoryPath), { recursive: true });
    fs.writeFileSync(
      memoryPath,
      [
        memoryEntry("common.copy", "Copy", "Copier", ["publicReader.copy"]),
        memoryEntry("publicReader.logIn", "Log in", "Connexion"),
        memoryEntry("publicReader.top", "Outdated source", "Obsolète"),
        memoryEntry("common.unrelated", "Other UI", "Autre"),
      ]
        .map((record) => JSON.stringify(record))
        .join("\n") + "\n",
    );
    const inputs = new Set<string>();
    const outDir = path.join(root, "dist");
    await build({
      config: false,
      entry: { locales: entry },
      outDir,
      format: "esm",
      platform: "node",
      dts: false,
      logLevel: "silent",
      outExtensions: () => ({ js: ".mjs" }),
      plugins: [createPublicSessionLocalesPlugin(root, (file) => inputs.add(file))],
    });
    fs.rmSync(path.join(root, "ui"), { recursive: true });
    const { PUBLIC_SESSION_LOCALES: locales } = await import(
      pathToFileURL(path.join(outDir, "locales.mjs")).href
    );
    expect(locales.fr).toEqual({ copy: "Copier", logIn: "Connexion" });
    expect(locales.de).toEqual({});
    expect(inputs.has(memoryPath)).toBe(true);
  });

  it.each(["", "not-json"])("does not hide existing corrupt memory (%j)", (contents) => {
    const root = createTempDir("public-reader-invalid-locales-");
    const directory = path.join(root, "ui/src/i18n/.i18n");
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, "fr.tm.jsonl"), contents);
    expect(() => loadPublicSessionLocales(root)).toThrow();
  });
});
