import { execFile } from "node:child_process";
import { symlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { runtimeProcessEntrypoints } from "../../src/infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../../src/infra/runtime-worker-url.js";
import { createNodeEvalArgs, resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const driver = `
import assert from "node:assert/strict";
const { resolveRuntimeProcessEntrypointUrl } = await import(${JSON.stringify(new URL("../../src/infra/runtime-process-url.ts", import.meta.url).href)});
// This process must not inherit Vitest's compiled declaration or sealed binding.
assert.ok(resolveRuntimeProcessEntrypointUrl("serviceChildGroupAnchor").pathname.endsWith(".ts"));
const supervisor = process.argv[2] === "matrix"
  ? await (await import(${JSON.stringify(new URL("../../scripts/lib/code-mode-matrix-process-owner.ts", import.meta.url).href)})).createGatewayMatrixProcessSupervisor(process.argv[1])
  : (await import(${JSON.stringify(new URL("../../src/process/supervisor/supervisor.ts", import.meta.url).href)})).createProcessSupervisor();
const cleanup = supervisor.acquireScopeCleanup("matrix-owner", { processTree: "required-all" });
const receipt = { owner: resolveRuntimeProcessEntrypointUrl("serviceChildGroupAnchor").href };
try {
  const child = await supervisor.spawn({
    mode: "child",
    scopeKey: "matrix-owner",
    argv: [process.execPath, "-e", 'process.stdout.write("matrix-owner-output")'],
    stdinMode: "pipe-closed",
    timeoutMs: 5000,
  });
  receipt.result = await child.wait();
} catch (error) {
  receipt.error = String(error);
} finally {
  receipt.cleanup = (await Promise.allSettled([cleanup(), supervisor.shutdown()])).map(result =>
    result.status === "fulfilled" ? { status: result.status } : { status: result.status, error: String(result.reason) }
  );
}
process.stdout.write(JSON.stringify(receipt));
`;

type OwnerReceipt = {
  owner: string;
  error?: string;
  result?: { exitCode: number | null; stdout: string; timedOut: boolean };
  cleanup: { status: "fulfilled" | "rejected"; error?: string }[];
};

async function runOwner(runtimeRoot: string, mode: "matrix" | "unbound") {
  const { stdout } = await promisify(execFile)(
    resolveTestNodeExecPath(),
    [...createNodeEvalArgs(driver, { imports: [import.meta.resolve("tsx")] }), runtimeRoot, mode],
    { cwd: repoRoot, encoding: "utf8", timeout: 20_000 },
  );
  return JSON.parse(stdout) as OwnerReceipt;
}

describe.skipIf(process.platform !== "linux")("matrix prepared process owner", () => {
  it("rejects the original source-loaded owner before the command runs", async () => {
    const receipt = await runOwner(repoRoot, "unbound");
    expect(receipt.error).toContain("native owner closed without kernel descendant extinction");
    expect(receipt.result).toBeUndefined();
    expect(receipt.cleanup).toEqual([
      expect.objectContaining({ status: "rejected" }),
      expect.objectContaining({ status: "rejected" }),
    ]);
  });

  it.each(["prepared", "overlay"] as const)(
    "runs and joins the built owner from the %s runtime root",
    async (layout) => {
      // Reuse the invocation's real compiled native owner, not a mocked registry
      // or a source-loader substitute. A new host gets no Vitest process bindings.
      const builtOwner = resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.serviceChildGroupAnchor);
      expect(builtOwner.pathname).toMatch(/\.js$/u);
      const builtRoot = path.resolve(path.dirname(fileURLToPath(builtOwner)), "../../..");
      const runtimeRoot = layout === "prepared" ? builtRoot : tempDirs.make("matrix-runtime-");
      if (layout === "overlay") {
        symlinkSync(path.join(builtRoot, "dist"), path.join(runtimeRoot, "dist"), "dir");
      }
      expect(runtimeRoot).not.toBe(repoRoot);
      const receipt = await runOwner(runtimeRoot, "matrix");
      expect(receipt.error).toBeUndefined();
      expect(receipt.result).toMatchObject({
        exitCode: 0,
        stdout: "matrix-owner-output",
        timedOut: false,
      });
      expect(receipt.cleanup).toEqual([{ status: "fulfilled" }, { status: "fulfilled" }]);
      expect(fileURLToPath(receipt.owner)).toBe(
        path.join(runtimeRoot, "dist", "process/supervisor/service-child-group-anchor.js"),
      );
    },
  );
});
