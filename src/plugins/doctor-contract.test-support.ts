import fs from "node:fs";
import path from "node:path";

export function writeDoctorFiles(root: string, files: Record<string, unknown>): void {
  for (const [name, contents] of Object.entries(files)) {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof contents === "string" ? contents : JSON.stringify(contents));
  }
}
