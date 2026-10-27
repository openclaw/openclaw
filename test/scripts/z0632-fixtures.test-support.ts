import { fixtureFiles } from "./script-fixture-files.test-support.js";

export function writeFixtureFiles(root: string, contents: Record<string, string | object>) {
  const files = fixtureFiles(root);
  for (const [name, value] of Object.entries(contents)) {
    if (typeof value === "string") {
      files.write(name, value);
    } else {
      files.json(name, value);
    }
  }
}

export function emptyModules(names: readonly string[]) {
  return Object.fromEntries(names.map((name) => [name, "export default {};\n"]));
}

export function readFixtureJson(root: string, name: string) {
  return JSON.parse(fixtureFiles(root).read(name));
}
