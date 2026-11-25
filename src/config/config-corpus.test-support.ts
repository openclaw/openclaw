import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const corpusDir = fileURLToPath(new URL("../../test/fixtures/config-corpus/", import.meta.url));

export function listConfigCorpusFixtureNames(): string[] {
  return fs
    .readdirSync(corpusDir)
    .filter((name) => name.endsWith(".json"))
    .toSorted();
}

export function readConfigCorpusFixture(name: string): string {
  return fs.readFileSync(path.join(corpusDir, name), "utf8");
}
