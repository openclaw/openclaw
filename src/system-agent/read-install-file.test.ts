import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { readSystemAgentInstallFile } from "./read-install-file.js";

const tempDirs = createTempDirTracker();
const scopeError = "Only files under the OpenClaw install root";
afterEach(() => tempDirs.cleanup());

async function fixture(stateInsideInstall = false) {
  const base = tempDirs.make("system-agent-install-file-");
  const stateDir = path.join(base, stateInsideInstall ? "install/state" : "state");
  const installRoot = path.join(base, "install");
  const logDir = path.join(base, "logs");
  const write = async (file: string, content: string | Buffer) => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
    return file;
  };
  await write(path.join(installRoot, "docs/guide.md"), "install guide text\n");
  const configPath = await write(path.join(stateDir, "openclaw.json"), "{}");
  await write(path.join(base, "outside/secret.txt"), "outside text\n");
  const logFile = await write(path.join(logDir, "openclaw-2026-01-22.log"), "current log line\n");
  const previousLog = await write(path.join(logDir, "openclaw-2026-01-21.log"), "older log line\n");
  const note = await write(path.join(logDir, "notes.txt"), "unrelated log dir file\n");
  return {
    base,
    installRoot,
    previousLog,
    note,
    write,
    roots: { configPath, installRoot, stateDir, logFile, logRolling: true, includeRoots: [] },
  };
}

describe("readSystemAgentInstallFile", () => {
  it("reads install files by relative or absolute path and the log family", async () => {
    const { installRoot, previousLog, note, roots } = await fixture();
    for (const requested of ["docs/guide.md", path.join(installRoot, "docs/guide.md")]) {
      expect(await readSystemAgentInstallFile(requested, roots)).toContain("install guide text");
    }
    expect(await readSystemAgentInstallFile(previousLog, roots)).toContain("older log line");
    const fixed = readSystemAgentInstallFile(previousLog, { ...roots, logRolling: false });
    await expect(fixed).rejects.toThrow(scopeError);
    await expect(readSystemAgentInstallFile(note, roots)).rejects.toThrow(scopeError);
  });

  it("refuses path escapes and links even within the install root", async () => {
    const { base, installRoot, roots } = await fixture();
    const secret = path.join(base, "outside/secret.txt");
    await fs.symlink(secret, path.join(installRoot, "link.txt"));
    await fs.symlink("docs/guide.md", path.join(installRoot, "link.md"));
    await fs.link(secret, path.join(installRoot, "hardlink.txt"));
    for (const requested of [
      "../outside/secret.txt",
      "../outside/missing.txt",
      "link.txt",
      "link.md",
      "hardlink.txt",
    ]) {
      await expect(readSystemAgentInstallFile(requested, roots)).rejects.toThrow(scopeError);
    }
  });

  it("refuses private state files even when roots overlap", async () => {
    for (const stateInsideInstall of [false, true, "same"] as const) {
      const { roots, write } = await fixture(stateInsideInstall === true);
      const stateDir = stateInsideInstall === "same" ? roots.installRoot : roots.stateDir;
      const privateFile = await write(path.join(stateDir, "credentials.json"), "private state");
      const logFile = await write(path.join(stateDir, "logs/openclaw-2026-01-22.log"), "log");
      for (const requested of [privateFile, logFile]) {
        const read = readSystemAgentInstallFile(requested, { ...roots, stateDir, logFile });
        await expect(read).rejects.toThrow("outside the diagnostics read scope");
      }
    }
  });

  it("protects config source directories regardless of the current config contents", async () => {
    const { roots, installRoot, write } = await fixture();
    const formerInclude = await write(path.join(installRoot, "config/part.txt"), "private");
    for (const configText of ['{"$include":"part.txt"}', "{}", "{"]) {
      const configPath = await write(path.join(installRoot, "config/current.json"), configText);
      const read = readSystemAgentInstallFile(formerInclude, { ...roots, configPath });
      await expect(read).rejects.toThrow("outside the diagnostics read scope");
    }
    const external = { ...roots, includeRoots: [path.dirname(formerInclude)] };
    await expect(readSystemAgentInstallFile(formerInclude, external)).rejects.toThrow(scopeError);
  });

  it("refuses hidden and binary files", async () => {
    const { installRoot, write, roots } = await fixture();
    await write(path.join(installRoot, ".env"), "KEY=value\n");
    await write(path.join(installRoot, "image.bin"), Buffer.from([255]));
    await expect(readSystemAgentInstallFile(".env", roots)).rejects.toThrow(scopeError);
    await expect(readSystemAgentInstallFile("image.bin", roots)).rejects.toThrow("Binary file");
  });

  it("truncates at the byte cap and redacts secrets", async () => {
    const { installRoot, write, roots } = await fixture();
    await write(path.join(installRoot, "big.txt"), "line of text\n".repeat(6_000));
    await write(path.join(installRoot, "auth.txt"), "Authorization: Basic c2VjcmV0OnBhc3M=\n");
    const big = await readSystemAgentInstallFile("big.txt", roots);
    expect(big).toContain("(truncated at 64 KiB)");
    expect(big.split("\n").slice(1).join("\n")).toHaveLength(64 * 1024);
    await write(path.join(installRoot, "unicode.txt"), `${"a".repeat(64 * 1024 - 1)}€`);
    await expect(readSystemAgentInstallFile("unicode.txt", roots)).resolves.not.toContain("�");
    const auth = await readSystemAgentInstallFile("auth.txt", roots);
    expect(auth).toContain("Authorization");
    expect(auth).not.toContain("c2VjcmV0OnBhc3M=");
  });
});
