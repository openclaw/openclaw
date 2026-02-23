import fs from "node:fs/promises";
import path from "node:path";
import { listRuntimeSourceFiles } from "./repo-scan.js";

export type RuntimeSourceGuardrailFile = {
  relativePath: string;
  source: string;
};

const runtimeSourceGuardrailCache = new Map<string, Promise<RuntimeSourceGuardrailFile[]>>();
const FILE_READ_CONCURRENCY = 32;

async function readRuntimeSourceFiles(
  repoRoot: string,
  absolutePaths: string[],
): Promise<RuntimeSourceGuardrailFile[]> {
  const output: Array<RuntimeSourceGuardrailFile | undefined> = Array.from({
    length: absolutePaths.length,
  });
  let nextIndex = 0;

  const worker = async () => {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= absolutePaths.length) {
        return;
      }
      const absolutePath = absolutePaths[index];
      if (!absolutePath) {
        continue;
      }
      const source = await fs.readFile(absolutePath, "utf8");
      output[index] = {
        relativePath: path.relative(repoRoot, absolutePath),
        source,
      };
    }
  };

  const workers = Array.from(
    { length: Math.min(FILE_READ_CONCURRENCY, Math.max(1, absolutePaths.length)) },
    () => worker(),
  );
  await Promise.all(workers);
  return output.filter((entry): entry is RuntimeSourceGuardrailFile => entry !== undefined);
}

export async function loadRuntimeSourceFilesForGuardrails(
  repoRoot: string,
): Promise<RuntimeSourceGuardrailFile[]> {
  let pending = runtimeSourceGuardrailCache.get(repoRoot);
  if (!pending) {
    pending = (async () => {
      const files = await listRuntimeSourceFiles(repoRoot, {
        roots: ["src", "extensions"],
        extensions: [".ts", ".tsx"],
      });
      return await readRuntimeSourceFiles(repoRoot, files);
    })();
    runtimeSourceGuardrailCache.set(repoRoot, pending);
  }
  return await pending;
}
