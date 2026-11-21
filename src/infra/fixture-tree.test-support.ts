import fs from "node:fs/promises";
import path from "node:path";

export async function writeFixtureTree(root: string, files: Record<string, string>) {
  for (const [file, contents] of Object.entries(files)) {
    const destination = path.join(root, file);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, contents);
  }
}
