import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { INSTALL_FILE_MAX_BYTES, readSystemAgentInstallFile } from "./read-install-file.js";

const tempDirs = createTempDirTracker();
afterEach(() => tempDirs.cleanup());

async function fixture(
  layout: { stateInsideInstall?: boolean; installInsideState?: boolean } = {},
) {
  const base = tempDirs.make("system-agent-install-file-");
  const stateDir = path.join(base, layout.stateInsideInstall ? "install/state" : "state");
  const installRoot = layout.installInsideState
    ? path.join(stateDir, "lib/openclaw")
    : path.join(base, "install");
  const logDir = path.join(base, "logs");
  const write = async (file: string, content: string | Buffer) => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
    return file;
  };
  await write(path.join(installRoot, "docs/guide.md"), "install guide text\n");
  await write(path.join(stateDir, "credentials.json"), '{"token":"state-only"}\n');
  await write(path.join(base, "outside/secret.txt"), "outside text\n");
  await write(path.join(logDir, "openclaw-2026-01-22.log"), "current log line\n");
  await write(path.join(logDir, "openclaw-2026-01-21.log"), "older log line\n");
  await write(path.join(logDir, "notes.txt"), "unrelated log dir file\n");
  return {
    base,
    installRoot,
    stateDir,
    logDir,
    write,
    roots: { installRoot, stateDir, logFile: path.join(logDir, "openclaw-2026-01-22.log") },
  };
}

describe("readSystemAgentInstallFile", () => {
  it("reads install files by relative or absolute path and the log family", async () => {
    const { installRoot, logDir, roots } = await fixture();
    await expect(readSystemAgentInstallFile("docs/guide.md", roots)).resolves.toContain(
      "install guide text",
    );
    await expect(
      readSystemAgentInstallFile(path.join(installRoot, "docs/guide.md"), roots),
    ).resolves.toContain("install guide text");
    await expect(
      readSystemAgentInstallFile(path.join(logDir, "openclaw-2026-01-21.log"), roots),
    ).resolves.toContain("older log line");
    await expect(readSystemAgentInstallFile(path.join(logDir, "notes.txt"), roots)).rejects.toThrow(
      "Only files under the OpenClaw install root",
    );
  });

  it("refuses a dot-dot escape and a symlink that leaves the install root", async () => {
    const { base, installRoot, roots } = await fixture();
    await fs.symlink(path.join(base, "outside/secret.txt"), path.join(installRoot, "link.txt"));
    for (const requested of [
      "../outside/secret.txt",
      "docs/../../outside/secret.txt",
      "link.txt",
    ]) {
      await expect(readSystemAgentInstallFile(requested, roots)).rejects.toThrow(
        "Only files under the OpenClaw install root",
      );
    }
  });

  it("refuses state files beside or inside the install root", async () => {
    const beside = await fixture();
    await expect(
      readSystemAgentInstallFile(path.join(beside.stateDir, "credentials.json"), beside.roots),
    ).rejects.toThrow("Only files under the OpenClaw install root");
    const inside = await fixture({ stateInsideInstall: true });
    await expect(
      readSystemAgentInstallFile("state/credentials.json", inside.roots),
    ).rejects.toThrow("State directory files and hidden files are not readable");
  });

  it("reads an install root that lives under the state directory but not its siblings", async () => {
    const { stateDir, roots } = await fixture({ installInsideState: true });
    await expect(readSystemAgentInstallFile("docs/guide.md", roots)).resolves.toContain(
      "install guide text",
    );
    await expect(
      readSystemAgentInstallFile(path.join(stateDir, "credentials.json"), roots),
    ).rejects.toThrow("Only files under the OpenClaw install root");
  });

  it("refuses hidden and binary files", async () => {
    const { installRoot, write, roots } = await fixture();
    await write(path.join(installRoot, ".env"), "KEY=value\n");
    await write(path.join(installRoot, "image.bin"), Buffer.from([1, 2, 0, 3]));
    await expect(readSystemAgentInstallFile(".env", roots)).rejects.toThrow("hidden files");
    await expect(readSystemAgentInstallFile("image.bin", roots)).rejects.toThrow("Binary file");
  });

  it("truncates at the byte cap and redacts secrets", async () => {
    const { installRoot, write, roots } = await fixture();
    await write(path.join(installRoot, "big.txt"), "line of text\n".repeat(6_000));
    await write(path.join(installRoot, "auth.txt"), "Authorization: Basic c2VjcmV0OnBhc3M=\n");
    const big = await readSystemAgentInstallFile("big.txt", roots);
    expect(big).toContain("(truncated at 64 KiB)");
    expect(big.split("\n").slice(1).join("\n")).toHaveLength(INSTALL_FILE_MAX_BYTES);
    const auth = await readSystemAgentInstallFile("auth.txt", roots);
    expect(auth).toContain("Authorization");
    expect(auth).not.toContain("c2VjcmV0OnBhc3M=");
  });
});
