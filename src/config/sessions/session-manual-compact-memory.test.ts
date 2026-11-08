import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { runManagedCommand } from "../../../scripts/lib/managed-child-process.mts";

// Eagerly reading 256 MiB of decoded rows and intermediate strings exhausts the
// production 512 MiB worker. Only the actual accessor/worker boundary proves this.
it("manually compacts without materializing the full decoded transcript", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "openclaw-compact-memory-"));
  const seeded = path.join(temporary, "seeded");
  let output = "";
  try {
    const result = await runManagedCommand({
      bin: process.execPath,
      args: [
        "--max-old-space-size=256",
        "--import",
        "./scripts/tsx.mjs",
        fileURLToPath(
          new URL("./session-manual-compact-memory.fixture.test-support.ts", import.meta.url),
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
    expect(output).toContain("manual compact bounded-memory regression passed");
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}, 70_000);
