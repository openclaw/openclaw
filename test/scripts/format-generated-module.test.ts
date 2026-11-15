import { writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  formatGeneratedModule,
  GENERATED_MODULE_FORMAT_MAX_BUFFER_BYTES,
  GENERATED_MODULE_FORMAT_TIMEOUT_MS,
} from "../../scripts/lib/format-generated-module.mts";

const repoRoot = path.resolve("formatter-fixture");
const format = (spawnSync: NonNullable<Parameters<typeof formatGeneratedModule>[2]>["spawnSync"]) =>
  formatGeneratedModule(
    "export const value=1;",
    { errorLabel: "test module", outputPath: "generated.ts", repoRoot },
    { spawnSync },
  );
function failureMessage(spawnSync: Parameters<typeof format>[0]) {
  try {
    format(spawnSync);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("Expected formatter failure");
}

describe("formatGeneratedModule", () => {
  it("runs generated module formatting with bounded child execution", () => {
    const calls: unknown[] = [];

    const formatted = format((command, args, options) => {
      calls.push({ args, command, options });
      writeFileSync(args[2] ?? "", "export const value = 1;\n", "utf8");
      return { status: 0, stderr: "", stdout: "" };
    });

    expect(formatted).toBe("export const value = 1;\n");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      args: [
        path.join(repoRoot, "node_modules", "oxfmt", "bin", "oxfmt"),
        "--write",
        expect.stringMatching(/generated\.ts$/u),
      ],
      command: process.execPath,
      options: {
        cwd: repoRoot,
        encoding: "utf8",
        maxBuffer: GENERATED_MODULE_FORMAT_MAX_BUFFER_BYTES,
        shell: false,
        timeout: GENERATED_MODULE_FORMAT_TIMEOUT_MS,
      },
    });
  });

  it("reports formatter timeouts with bounded output tails", () => {
    const timeoutError = Object.assign(new Error("spawnSync oxfmt ETIMEDOUT"), {
      code: "ETIMEDOUT",
    });

    const message = failureMessage(() => ({
      error: timeoutError,
      signal: "SIGTERM",
      status: null,
      stderr: `DO_NOT_DUMP_OLD_STDERR${"x".repeat(20 * 1024)}\nrecent stderr tail`,
      stdout: `DO_NOT_DUMP_OLD_STDOUT${"x".repeat(20 * 1024)}\nrecent stdout tail`,
    }));
    expect(message).toMatch(
      /formatter timed out after 30000ms[\s\S]*recent stderr tail[\s\S]*recent stdout tail/u,
    );
    expect(message).not.toContain("DO_NOT_DUMP_OLD_STDERR");
    expect(message).not.toContain("DO_NOT_DUMP_OLD_STDOUT");
  });

  it("keeps truncated formatter diagnostics UTF-8 safe", () => {
    const message = failureMessage(() => ({
      status: 1,
      stderr: `你好${"x".repeat(16_380)}`,
      stdout: "",
    }));
    expect(message).toMatch(/stderr tail:\n好x/u);
    expect(message).not.toContain("�");
  });
});
