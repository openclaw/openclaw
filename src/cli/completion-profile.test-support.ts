import { expect } from "vitest";
import { Utf8InputError } from "../infra/utf8-input.js";
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

export function completionInstallError(code: string, profilePath: string): Error {
  const cause =
    code === "ERR_INVALID_UTF8"
      ? Object.assign(new Utf8InputError("Profile must be valid UTF-8; left untouched."), {
          profilePath,
        })
      : Object.assign(new Error(`${code}: profile write failed`), { code, path: profilePath });
  return new Error(`Failed to install completion: ${cause.message}`, { cause });
}
