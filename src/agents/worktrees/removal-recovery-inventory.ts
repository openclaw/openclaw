import { createHash } from "node:crypto";
import fsSync from "node:fs";
import path from "node:path";
import type { GitCommandOptions } from "../../infra/git-exec.js";
import { withWorktreeGitConfig } from "./checkout-git-config.js";
import { splitNullBuffer } from "./git-path-inventory.js";
import { commandError, requireGitBuffer, runGit } from "./git.js";
import type { ManagedWorktreeRecord } from "./types.js";

type Entry = { filename: string; mode: string; oid: string; size: number };

/** Match physical checkout bytes to the original capture under Git's filename/content policy. */
export async function createRemovalRecoveryInventory(params: {
  record: Pick<ManagedWorktreeRecord, "path" | "repoRoot">;
  snapshot: string;
  gitdir: string;
  options: GitCommandOptions;
  assertIdentity: () => void;
  refuse: (reason: string) => Error;
}) {
  const { record, snapshot, gitdir, options, assertIdentity, refuse: preserved } = params;
  const readRetainedGitBoolean = async (key: string, fallback: boolean) => {
    const result = await runGit(record.repoRoot, ["config", "--type=bool", "--get", key], {
      ...options,
      beforeRun: assertIdentity,
      env: { ...options.env, GIT_DIR: gitdir },
    });
    if (result.code !== 0 && result.code !== 1) {
      throw commandError(`git config ${key}`, result);
    }
    return result.code === 1 ? fallback : result.stdout.trim() === "true";
  };
  const precompose =
    process.platform === "darwin" &&
    (await readRetainedGitBoolean("core.precomposeunicode", false));
  const pathKey = (filename: string) => (precompose ? filename.normalize("NFC") : filename);
  const entries = new Map<string, Entry>();
  for (const item of splitNullBuffer(
    await requireGitBuffer(record.repoRoot, ["ls-tree", "-r", "-l", "-z", snapshot], options),
  )) {
    const tab = item.indexOf(9);
    const filename = item.subarray(tab + 1).toString("utf8");
    const fields = item.subarray(0, tab).toString("ascii").trim().split(/\s+/u);
    if (
      tab < 0 ||
      !Buffer.from(filename).equals(item.subarray(tab + 1)) ||
      filename
        .split("/")
        .some((part) => !part || part === "." || part === ".." || part.toLowerCase() === ".git") ||
      !["100644", "100755", "120000"].includes(fields[0]!)
    ) {
      throw preserved("Unsupported snapshot path or file type");
    }
    const key = pathKey(filename);
    if (entries.has(key)) {
      throw preserved("Snapshot paths alias under the checkout filename policy");
    }
    entries.set(key, { filename, mode: fields[0]!, oid: fields[2]!, size: Number(fields[3]) });
  }
  const materializedSymlinks =
    [...entries.values()].some((entry) => entry.mode === "120000") &&
    !(await readRetainedGitBoolean("core.symlinks", process.platform !== "win32"));
  // Each four-byte $Id$ can expand to OID length + 8 bytes; encoding
  // conversion can then use four bytes per character. Include BOM slack.
  const checkoutBytes = (entry: Entry) => entry.size * (snapshot.length + 8) + 65536;
  const inventory = (conversionCandidates?: string[]) => {
    const found = new Set<string>();
    const visit = (relative: string) => {
      const directory = path.join(record.path, relative);
      for (const raw of fsSync.readdirSync(directory, { encoding: "buffer" })) {
        const name = raw.toString("utf8");
        if (!Buffer.from(name).equals(raw)) {
          throw preserved("Unsupported remaining path");
        }
        if (!relative && name === ".git") {
          continue;
        }
        const child = relative ? `${relative}/${name}` : name;
        const key = pathKey(child);
        const target = path.join(record.path, child);
        const info = fsSync.lstatSync(target);
        if (info.isDirectory()) {
          if (![...entries.keys()].some((entry) => entry.startsWith(`${key}/`))) {
            throw preserved(`Foreign directory: ${child}`);
          }
          visit(child);
          continue;
        }
        if (found.has(key)) {
          throw preserved(`Aliased remaining path: ${child}`);
        }
        const expected = entries.get(key);
        const mode = info.isSymbolicLink()
          ? "120000"
          : info.isFile()
            ? (process.platform === "win32" ? expected?.mode === "100755" : info.mode & 0o111)
              ? "100755"
              : "100644"
            : "unsupported";
        const symlinkFile =
          materializedSymlinks && expected?.mode === "120000" && mode === "100644";
        if (!expected || (mode !== expected.mode && !symlinkFile)) {
          throw preserved(`Changed or foreign file: ${child}`);
        }
        const content = info.isSymbolicLink()
          ? fsSync.readlinkSync(target, { encoding: "buffer" })
          : fsSync.readFileSync(target);
        const oid = createHash(snapshot.length === 64 ? "sha256" : "sha1")
          .update(`blob ${content.length}\0`)
          .update(content)
          .digest("hex");
        if (oid !== expected.oid) {
          if (conversionCandidates && expected.mode !== "120000") {
            conversionCandidates.push(key);
          } else {
            throw preserved(`Changed file: ${child}`);
          }
        }
        found.add(key);
      }
    };
    assertIdentity();
    visit("");
    assertIdentity();
    return [...entries].filter(([key]) => !found.has(key)).map(([, entry]) => entry.filename);
  };
  const verifyInventory = async () => {
    const conversions: string[] = [];
    inventory(conversions);
    if (conversions.length) {
      // Most files match their blobs directly. Only mismatches need Git's
      // trusted checkout representation (e.g. text eol=crlf), never a clean filter.
      await withWorktreeGitConfig(
        record.repoRoot,
        true,
        {
          ...options,
          beforeRun: assertIdentity,
          env: { ...options.env, GIT_DIR: gitdir },
        },
        async (git) => {
          for (const key of conversions) {
            const entry = entries.get(key)!;
            const filename = entry.filename;
            const result = await git.worker.buffered(
              record.repoRoot,
              [
                `--attr-source=${snapshot}`,
                "cat-file",
                "--filters",
                `--path=${filename}`,
                `${snapshot}:${filename}`,
              ],
              { ...options, maxOutputBytes: { stdout: checkoutBytes(entry), stderr: 65536 } },
            );
            if (result.code !== 0 || result.termination !== "exit" || result.outputLimitStream) {
              throw preserved("Captured checkout representation is unavailable");
            }
            entry.oid = createHash(snapshot.length === 64 ? "sha256" : "sha1")
              .update(`blob ${result.stdout.length}\0`)
              .update(result.stdout)
              .digest("hex");
          }
        },
      );
    }
    return inventory();
  };
  return {
    verify: verifyInventory,
    missingBytes: (files: readonly string[]) =>
      files.reduce((sum, file) => sum + checkoutBytes(entries.get(pathKey(file))!), 0),
    assertComplete: () => {
      if (inventory().length) {
        throw preserved("Checkout changed before destructive admission");
      }
    },
  };
}
