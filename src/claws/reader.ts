// Local filesystem reader for claw manifest JSON files.
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseClawManifest } from "./schema.js";
import type { ClawDiagnostic, ClawReadResult } from "./types.js";

function fileDiagnostic(code: string, message: string): ClawDiagnostic {
  return {
    level: "error",
    code,
    path: "$",
    message,
  };
}

export async function readClawManifestFile(path: string): Promise<ClawReadResult> {
  const sourcePath = resolve(path);
  let raw: string;
  try {
    raw = await readFile(sourcePath, "utf8");
  } catch (error) {
    return {
      ok: false,
      diagnostics: [fileDiagnostic("read_failed", `Could not read claw manifest: ${(error as Error).message}`)],
    };
  }

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    return {
      ok: false,
      diagnostics: [fileDiagnostic("invalid_json", `Could not parse claw manifest JSON: ${(error as Error).message}`)],
    };
  }

  return parseClawManifest(value);
}
