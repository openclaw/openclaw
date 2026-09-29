import path from "node:path";

try {
  const [workspace, home, operation, ...extra] = process.argv.slice(2);
  if (!workspace || !home || !operation || extra.length) {
    throw new Error("Skills worker requires workspace, home, and operation");
  }
  // Native startup messages must not enter the result stream.
  console.log = console.info = (...values: unknown[]) => console.error(...values);
  const { serveWorkspaceSkills } = await import("../skills/runtime/workspace-worker.js");
  await serveWorkspaceSkills({
    workspace: path.resolve(workspace),
    home: path.resolve(home),
    operation,
    input: process.stdin,
    output: process.stdout,
  });
  // Native state owners can retain process handles; every result write has drained.
  process.exit(0);
} catch (error) {
  process.stderr.write(`Skills worker failed: ${String(error)}\n`);
  process.exit(1);
}
