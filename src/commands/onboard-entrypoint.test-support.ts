import fs from "node:fs/promises";
import path from "node:path";
import { onTestFinished } from "vitest";

export async function setEntrypoint(root: string, kind: "npx" | "durable"): Promise<string> {
  const entrypoint =
    kind === "npx"
      ? path.join(root, ".npm", "_npx", "testhash", "node_modules", "openclaw", "openclaw.mjs")
      : path.join(root, "node_modules", "openclaw", "openclaw.mjs");
  await fs.mkdir(path.dirname(entrypoint), { recursive: true });
  await fs.writeFile(entrypoint, "");
  const originalArgv = [...process.argv];
  process.argv = [process.execPath, await fs.realpath(entrypoint)];
  onTestFinished(() => {
    process.argv = originalArgv;
  });
  return process.argv[1]!;
}
