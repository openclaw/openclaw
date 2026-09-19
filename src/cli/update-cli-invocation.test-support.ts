import { Command } from "commander";
import { expect } from "vitest";
import type { UpdateCommandOptions } from "./update-cli/shared.js";

export function expectGitMetadataPreview(result: unknown): void {
  expect(result).toMatchObject({
    dryRun: true,
    mode: "git",
    notes: expect.arrayContaining([
      expect.stringMatching(/Git target manifest or revision[\s\S]*retry openclaw update/),
    ]),
    failures: expect.arrayContaining([
      expect.objectContaining({
        reason: "target-metadata-preflight",
        message: expect.stringMatching(/Git[\s\S]*openclaw update/),
        failureFacts: [
          expect.objectContaining({
            code: "target-git-metadata",
            message: expect.stringContaining("a dry-run does not fetch missing objects"),
          }),
        ],
      }),
    ]),
  });
}

export async function invokeUpdateCli(opts: UpdateCommandOptions) {
  const { registerUpdateCli } = await import("./update-cli.js");
  const program = new Command();
  registerUpdateCli(program);
  const args = ["update"];
  for (const key of ["yes", "json", "dryRun", "acceptCapabilities"] as const) {
    if (opts[key]) {
      args.push(`--${key.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`)}`);
    }
  }
  if (opts.restart === false) {
    args.push("--no-restart");
  }
  for (const key of ["channel", "tag", "timeout"] as const) {
    if (opts[key] !== undefined) {
      args.push(`--${key}`, opts[key]);
    }
  }
  await program.parseAsync(args, { from: "user" });
}

export const devTargetRefusalCases = [
  ["malformed tracked", "openclaw-dev-target:v1:not+base64url", false, false],
  ["unknown version tracked", "openclaw-dev-target:v2:hostile-ref", false, false],
  ["unknown namespace tracked", "other-dev-target:v1:hostile-ref", false, false],
  ["malformed inferred", "openclaw-dev-target:v1:not+base64url", true, false],
  ["malformed inferred JSON", "openclaw-dev-target:v1:not+base64url", true, true],
] as const;
