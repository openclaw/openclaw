import { runGitBuffered } from "../agents/worktrees/git.js";
import type { GitReadOperations } from "./git-read-operations.js";

const MAX_REF_FILE_BYTES = 64 * 1024;
const OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;

/** Read one literal path from a direct ref; ref movement cannot mix object generations. */
export async function readGitRefFile({
  root,
  ref,
  path,
}: GitReadOperations["repository.ref-file"]["input"]): Promise<string | null> {
  if (
    !ref.startsWith("refs/") ||
    ref.length > 1024 ||
    /[\0\r\n]/u.test(ref) ||
    path.length > 4096 ||
    // oxlint-disable-next-line eslint/no-control-regex -- Reject control characters before constructing Git's line-delimited batch input.
    /[\0-\x1f\x7f\\:]/u.test(path) ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    return null;
  }
  const read = async (args: string[], input?: string, maxBytes = 4096) => {
    const result = await runGitBuffered(root, args, {
      input,
      maxOutputBytes: { stdout: maxBytes, stderr: 4096 },
      env: {
        GIT_NO_LAZY_FETCH: "1",
        GIT_ALLOW_PROTOCOL: "",
        GIT_NO_REPLACE_OBJECTS: "1",
        GIT_OPTIONAL_LOCKS: "0",
        GIT_TERMINAL_PROMPT: "0",
      },
    });
    return result.termination === "exit" && result.code === 0 ? result.stdout : null;
  };
  if ((await read(["check-ref-format", ref])) === null) {
    return null;
  }
  const reference = await read([
    "for-each-ref",
    "--count=1",
    "--format=%(refname)%00%(objectname)%00%(symref)",
    "--",
    ref,
  ]);
  const fields = reference?.toString("utf8").trimEnd().split("\0");
  if (fields?.length !== 3 || fields[0] !== ref || !OBJECT_ID.test(fields[1]!) || fields[2]) {
    return null;
  }
  // Resolve size and blob identity before reading content; never reread the mutable ref.
  // No filters or symlink following: repository configuration cannot execute converters.
  const metadata = await read(
    ["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"],
    `${fields[1]}:${path}\n`,
  );
  const blob = metadata?.toString("utf8").trimEnd().split(" ");
  const size = Number(blob?.[2]);
  if (
    blob?.length !== 3 ||
    !OBJECT_ID.test(blob[0]!) ||
    blob[1] !== "blob" ||
    !Number.isSafeInteger(size) ||
    size < 0 ||
    size > MAX_REF_FILE_BYTES
  ) {
    return null;
  }
  const content = await read(["cat-file", "blob", blob[0]!], undefined, MAX_REF_FILE_BYTES);
  return content?.byteLength === size ? content.toString("utf8") : null;
}
