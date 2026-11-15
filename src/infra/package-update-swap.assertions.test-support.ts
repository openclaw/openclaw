import fs from "node:fs/promises";
import path from "node:path";
import { expect } from "vitest";
import type { PackageUpdateTransaction } from "./package-update-swap-contract.js";
import { swapStagedPackageInstall } from "./package-update-swap.js";

export const readText = (...parts: string[]) => fs.readFile(path.join(...parts), "utf8");

export async function expectVersion(root: string, version: string) {
  expect(await readText(root, "package.json")).toContain(`"version":"${version}"`);
}

export async function expectInstallation(root: string, launcher: string, candidate = false) {
  await expectVersion(root, candidate ? "2.0.0" : "1.0.0");
  expect(await readText(launcher)).toBe(candidate ? "candidate launcher\n" : "old launcher\n");
}

export function expectNoCalls(...mocks: unknown[]) {
  for (const mock of mocks) {
    expect(mock).not.toHaveBeenCalled();
  }
}

export async function captureSwap(params: Parameters<typeof swapStagedPackageInstall>[0]) {
  let transaction: PackageUpdateTransaction | undefined;
  const result = await swapStagedPackageInstall({
    ...params,
    onTransaction: async (value) => {
      transaction = value;
      await params.onTransaction?.(value);
    },
  });
  if (!transaction) {
    throw new Error("Missing retained transaction");
  }
  return { result, transaction };
}

export async function retain(params: Parameters<typeof swapStagedPackageInstall>[0]) {
  const { result, transaction } = await captureSwap(params);
  expect(result.status, result.step.stderrTail ?? "").toBe("committed");
  return transaction;
}
