import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const corpusDir = fileURLToPath(new URL("../../test/fixtures/config-corpus/", import.meta.url));

export function listConfigCorpusFixtureNames(): string[] {
  return [
    ...fs.readdirSync(corpusDir).filter((name) => name.endsWith(".json")),
    "hamverbot.json",
  ].toSorted();
}

export function readConfigCorpusFixture(name: string): string {
  // This variant's source-preservation assertions use the same operator shape.
  const fixture = name === "hamverbot.json" ? "operator-container.json" : name;
  return fs.readFileSync(path.join(corpusDir, fixture), "utf8");
}
