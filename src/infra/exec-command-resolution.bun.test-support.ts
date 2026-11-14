import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { configureFsSafeNative } from "@openclaw/fs-safe/config";
import { drainGlobalSingletonLifecycleState } from "../shared/global-singleton.js";
import { resolveCommandResolutionFromArgv } from "./exec-command-resolution.js";
import { resolveExecRealpathInWorker } from "./exec-realpath-worker.js";
import { runWithWorkerStartObserver } from "./worker-request-diagnostics.js";

assert.ok(process.versions.bun, "native executable policy must execute in Bun");
const fixtureRoot = process.argv[2];
assert.ok(fixtureRoot, "native executable policy requires an isolated fixture root");
const root = await fs.realpath(fixtureRoot);
const addons = process.argv[3] === "true";
// Local cross-runtime proof can require the exact documented optional-addon outcome.
const executeOnlyFallback = process.argv[4];
assert.ok([undefined, "present", "absent"].includes(executeOnlyFallback));
const actual = path.join(root, "actual");
const configured = path.join(root, "configured");
await fs.mkdir(path.join(actual, "bin"), { recursive: true });
await fs.mkdir(configured);
await fs.symlink(path.join(actual, "bin"), path.join(configured, "alias"));
const executables = [
  { name: "readable", permissions: 0o755 },
  { name: "execute-only", permissions: 0o111 },
];
for (const { name, permissions } of executables) {
  await fs.writeFile(path.join(actual, name), "#!/bin/sh\nexit 0\n", { mode: permissions });
  await fs.writeFile(path.join(configured, name), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
}
const rawPath = `${configured}/alias/..`;
let workerStarts = 0;
try {
  await runWithWorkerStartObserver(
    (script) => {
      if (script === "exec-realpath.worker.js") {
        workerStarts++;
      }
    },
    async () => {
      for (const mode of ["require", "off", "auto", "require"] as const) {
        configureFsSafeNative({ mode });
        for (const { name, permissions } of executables) {
          const resolution = await resolveCommandResolutionFromArgv(
            [name],
            root,
            { PATH: rawPath },
            process.platform,
            { useCache: false },
          );
          const resolved = resolution?.execution.resolvedRealPath;
          const expected = path.join(actual, name);
          const label = `${mode}/${name}/addons=${addons}`;
          assert.equal(resolution?.execution.resolvedPath, `${rawPath}/${name}`, label);
          assert.ok(resolved === undefined || resolved === expected, label);
          if (mode === "require") {
            assert.equal(resolved, addons ? expected : undefined, label);
          } else if (permissions === 0o755 || (mode === "auto" && addons)) {
            assert.equal(resolved, expected, label);
          } else if (executeOnlyFallback !== undefined) {
            assert.equal(resolved, executeOnlyFallback === "present" ? expected : undefined, label);
          }
          console.log(
            JSON.stringify({ mode, executable: name, addons, resolved: Boolean(resolved) }),
          );
        }
        if (mode === "auto" && !addons) {
          // The command fast path needs no worker for a readable file; exercise reuse after require failed.
          assert.equal(
            await resolveExecRealpathInWorker(`${rawPath}/readable`, mode),
            path.join(actual, "readable"),
          );
        }
      }
    },
  );
  assert.equal(workerStarts, 1, "native mode changes must reuse the existing worker");
} finally {
  await drainGlobalSingletonLifecycleState();
}
