import { expect } from "vitest";
import type { CompletionShell } from "./completion-runtime.js";

export function expectInstalledCompletionProfile(
  profile: string,
  shell: CompletionShell,
  cachePath: string,
): void {
  if (shell !== "fish") {
    expect(profile).toContain(cachePath);
    return;
  }
  const operand = `'${cachePath.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
  expect(profile).toBe(`# OpenClaw Completion\ntest -f ${operand}; and source ${operand}\n`);
}
