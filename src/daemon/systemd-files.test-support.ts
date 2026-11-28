/** File fixtures shared by the systemd family. */
import fs from "node:fs/promises";
import path from "node:path";
import { expect, vi } from "vitest";

export function legacyGatewayUnit(version: string, ...directives: string[]) {
  return [
    "[Unit]",
    `Description=OpenClaw Gateway (v${version})`,
    "[Service]",
    "Environment=OPENCLAW_SERVICE_MARKER=openclaw",
    "Environment=OPENCLAW_SERVICE_KIND=gateway",
    ...directives,
    `Environment=OPENCLAW_SERVICE_VERSION=${version}`,
    "",
  ].join("\n");
}

export function environmentSnapshot(entries: Record<string, [value: string, source: string]>) {
  return {
    environment: Object.fromEntries(Object.entries(entries).map(([key, [value]]) => [key, value])),
    environmentValueSources: Object.fromEntries(
      Object.entries(entries).map(([key, [, source]]) => [key, source]),
    ),
  };
}

export async function expectFiles(
  files: Record<string, string | { contents: string; mode: number } | null>,
) {
  for (const [file, expected] of Object.entries(files)) {
    if (expected === null) {
      await expect(fs.access(file)).rejects.toMatchObject({ code: "ENOENT" });
    } else {
      await expect(fs.readFile(file, "utf8")).resolves.toBe(
        typeof expected === "string" ? expected : expected.contents,
      );
      if (typeof expected !== "string") {
        expect((await fs.stat(file)).mode & 0o777).toBe(expected.mode);
      }
    }
  }
}

export const captureOutput = (write = vi.fn()) => {
  const stdout = { write };
  return {
    write,
    stdout: stdout as typeof stdout & NodeJS.WritableStream,
  };
};

export async function writeUnit(unitPath: string, contents: string, mode = 0o644) {
  // Fault cases change permissions explicitly; defaults must not depend on umask.
  await fs.mkdir(path.dirname(unitPath), { recursive: true, mode: 0o755 });
  await fs.writeFile(unitPath, contents, { encoding: "utf8", mode });
}
