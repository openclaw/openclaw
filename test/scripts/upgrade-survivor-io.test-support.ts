import type { SpawnSyncReturns } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { expect } from "vitest";

export const readJson = (file: string) => JSON.parse(readFileSync(file, "utf8"));
export const writeJson = (file: string, value: unknown) =>
  writeFileSync(file, JSON.stringify(value));

export function expectStatus(
  result: Pick<SpawnSyncReturns<string>, "status" | "stderr">,
  status = 0,
) {
  expect(result.status, result.stderr).toBe(status);
}
