import fs from "node:fs";
import path from "node:path";

export function writeArtifact(filename: string, contents = "export {};\n") {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, contents);
  return filename;
}

export function writeArtifacts(root: string, files: Record<string, string | object>) {
  for (const [name, value] of Object.entries(files)) {
    writeArtifact(path.join(root, name), typeof value === "string" ? value : JSON.stringify(value));
  }
}

export function captureThrownError(run: () => unknown): Error {
  try {
    run();
  } catch (error) {
    if (error instanceof Error) {
      return error;
    }
    throw error;
  }
  throw new Error("Expected function to throw");
}
