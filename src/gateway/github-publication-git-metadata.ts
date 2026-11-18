import fs from "node:fs/promises";
import path from "node:path";
import { hasErrnoCode } from "../infra/errno.js";

function assertNoGitFilterAttributes(contents: Buffer): void {
  for (const line of contents.toString("latin1").split(/\r?\n/u)) {
    const fields = line.trimStart().split(/[\t ]+/u);
    if (!fields[0] || fields[0].startsWith("#")) {
      continue;
    }
    if (fields.slice(1).some((field) => /^(?:-|!)?filter(?:=|$)/u.test(field))) {
      throw new Error("GitHub publication workspace uses an unsupported Git clean filter.");
    }
  }
}

export async function readOptionalAttributeFile(file: string): Promise<Buffer | undefined> {
  try {
    return await fs.readFile(file);
  } catch (error) {
    if (hasErrnoCode(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  }
}

export async function assertGitHubPublicationIndexHasNoFilters(
  cwd: string,
  indexFile: string,
  runPublicationCommand: (
    argv: string[],
    options: { cwd: string; env?: NodeJS.ProcessEnv; maxOutputBytes?: number },
  ) => Promise<{ code: number | null; stdout: Buffer }>,
  maxOutputBytes: number,
): Promise<void> {
  // This private index just produced the accepted tree, including admission pruning.
  // Select attributes in Git instead of buffering every path in that tree.
  const listing = await runPublicationCommand(
    [
      "git",
      "-c",
      "core.fsmonitor=false",
      "ls-files",
      "--cached",
      "--format=%(objectname)",
      "--",
      ":(top,icase,glob)**/.gitattributes",
    ],
    {
      cwd,
      env: { GIT_INDEX_FILE: indexFile, GIT_LITERAL_PATHSPECS: "0" },
      maxOutputBytes,
    },
  );
  if (listing.code !== 0) {
    throw new Error("GitHub publication workspace attributes could not be verified.");
  }
  const attributeObjects = new Set(
    listing.stdout.toString("utf8").trim().split("\n").filter(Boolean),
  );
  if (attributeObjects.size > 1024) {
    throw new Error("GitHub publication workspace has too many Git attribute files.");
  }
  for (const objectId of attributeObjects) {
    const blob = await runPublicationCommand(["git", "cat-file", "blob", objectId], { cwd });
    if (blob.code !== 0) {
      throw new Error("GitHub publication workspace attributes could not be verified.");
    }
    assertNoGitFilterAttributes(blob.stdout);
  }

  const infoPath = await runPublicationCommand(
    ["git", "rev-parse", "--git-path", "info/attributes"],
    {
      cwd,
    },
  );
  if (infoPath.code !== 0) {
    throw new Error("GitHub publication workspace attributes could not be verified.");
  }
  const attributeFiles = await Promise.all(
    ["GIT_ATTR_GLOBAL", "GIT_ATTR_SYSTEM"].map(
      async (name) => await runPublicationCommand(["git", "var", name], { cwd }),
    ),
  );
  if (attributeFiles.some((result) => result.code !== 0)) {
    throw new Error("GitHub publication workspace attributes could not be verified.");
  }
  const paths = [
    path.resolve(cwd, infoPath.stdout.toString("utf8").trim()),
    ...attributeFiles.flatMap((result) =>
      result.stdout.length > 0 ? [result.stdout.toString("utf8").trim()] : [],
    ),
  ];
  for (const file of paths) {
    const contents = await readOptionalAttributeFile(file);
    if (contents) {
      assertNoGitFilterAttributes(contents);
    }
  }
}
