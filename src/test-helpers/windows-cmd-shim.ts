import fs from "node:fs/promises";
import path from "node:path";

export async function createWindowsCmdShimFixture(params: {
  shimPath: string;
  scriptPath: string;
  shimLine: string;
}): Promise<void> {
  await fs.mkdir(path.dirname(params.scriptPath), { recursive: true });
  await fs.mkdir(path.dirname(params.shimPath), { recursive: true });
  await fs.writeFile(params.scriptPath, "module.exports = {};\n", "utf8");
  await fs.writeFile(params.shimPath, `@echo off\r\n${params.shimLine}\r\n`, "utf8");
}
