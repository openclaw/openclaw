import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { runManagedCommand } from "../../../scripts/lib/managed-child-process.mts";

// Retaining a large projected transcript plus rendered text exhausts the
// production 512 MiB worker. Only the actual accessor/worker boundary proves this.
it("exports a large session twice within the production worker heap", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "openclaw-export-memory-"));
  const seeded = path.join(temporary, "seeded");
  let output = "";
  try {
    const result = await runManagedCommand({
      bin: process.execPath,
      args: [
        "--max-old-space-size=1024",
        "--import",
        "./scripts/tsx.mjs",
        fileURLToPath(
          new URL("./session-memory-export-memory.fixture.test-support.ts", import.meta.url),
        ),
        seeded,
      ],
      cwd: fileURLToPath(new URL("../../../", import.meta.url)),
      env: { ...process.env, NODE_OPTIONS: "" },
      stdio: ["ignore", "pipe", "pipe"],
      timeoutMs: 60_000,
      onReady(child) {
        child.stdout?.on("data", (chunk: Buffer) => {
          output += chunk.toString();
        });
        child.stderr?.on("data", (chunk: Buffer) => {
          output += chunk.toString();
        });
      },
    });
    // Distinguish a product memory failure from import/bootstrap/fixture failure.
    expect(await readFile(seeded, "utf8"), output).toBe("seeded");
    expect(result, output).toBe(0);
    expect(output).toContain("memory export bounded-memory regression passed");
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}, 70_000);
