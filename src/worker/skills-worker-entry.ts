import path from "node:path";
import { drainGlobalSingletonLifecycleState } from "../shared/global-singleton.js";

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
} catch (error) {
  process.stderr.write(`Skills worker failed: ${String(error)}\n`);
  process.exitCode = 1;
} finally {
  // The serving owner has drained results and retired watchers. Release its
  // native state workers as well as a publisher that may still hold stdin open.
  process.stdin.destroy();
  try {
    await drainGlobalSingletonLifecycleState();
  } catch (error) {
    process.stderr.write(`Skills worker cleanup failed: ${String(error)}\n`);
    process.exitCode = 1;
  }
  if (process.connected) {
    process.disconnect?.();
  }
}
