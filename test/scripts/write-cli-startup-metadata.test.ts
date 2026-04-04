import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  renderBundledRootHelpText,
  writeCliStartupMetadata,
} from "../../scripts/write-cli-startup-metadata.ts";

function createTempDir(prefix: string): string {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe("write-cli-startup-metadata", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("captures bundled root help text from the CLI program", async () => {
    const rootHelpText = await renderBundledRootHelpText();

    expect(rootHelpText).toContain("Usage:");
    expect(rootHelpText).toContain("openclaw");
  });

  it("writes startup metadata with populated root help text", async () => {
    const tempRoot = createTempDir("openclaw-startup-metadata-");
    tempDirs.push(tempRoot);
    const distDir = path.join(tempRoot, "dist");
    const extensionsDir = path.join(tempRoot, "extensions");
    const outputPath = path.join(distDir, "cli-startup-metadata.json");

    mkdirSync(distDir, { recursive: true });
    mkdirSync(path.join(extensionsDir, "matrix"), { recursive: true });
    writeFileSync(
      path.join(extensionsDir, "matrix", "package.json"),
      JSON.stringify({
        openclaw: {
          channel: {
            id: "matrix",
            order: 120,
            label: "Matrix",
          },
        },
      }),
      "utf8",
    );

    await writeCliStartupMetadata({ distDir, outputPath, extensionsDir });

    const written = JSON.parse(readFileSync(outputPath, "utf8")) as {
      channelOptions: string[];
      rootHelpText: string;
    };
    expect(written.channelOptions).toContain("matrix");
    expect(written.rootHelpText).toContain("Usage:");
    expect(written.rootHelpText).toContain("openclaw");
  });
});
