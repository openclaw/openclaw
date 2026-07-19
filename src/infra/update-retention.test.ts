// Previous-package retention tests use isolated package-manager roots.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCommandWithTimeout } from "../process/exec.js";
import { retainCurrentPackageForUpdate } from "./update-retention.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true })));
});

describe("update package retention", () => {
  it("keeps exactly one launchable dereferenced previous package", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-update-retain-"));
    temporaryRoots.push(root);
    const globalRoot = path.join(root, "lib", "node_modules");
    const packageRoot = path.join(globalRoot, "openclaw");
    const abandonedStage = path.join(root, "lib", ".openclaw-previous.stage-4242-1000");
    await fs.mkdir(path.join(packageRoot, "dist"), { recursive: true });
    await fs.mkdir(abandonedStage, { recursive: true });
    await fs.writeFile(path.join(abandonedStage, "partial-copy"), "stale");
    await fs.writeFile(
      path.join(packageRoot, "package.json"),
      JSON.stringify({ name: "openclaw", version: "1.9.0" }),
    );
    await fs.writeFile(path.join(packageRoot, "dist", "entry.js"), 'console.log("1.9.0");\n');
    const managedNodePath = path.join(root, "managed-node");
    const observedNodePaths: string[] = [];
    const runWithManagedNode: typeof runCommandWithTimeout = async (argv, options) => {
      observedNodePaths.push(argv[0] ?? "");
      return await runCommandWithTimeout([process.execPath, ...argv.slice(1)], options);
    };

    const result = await retainCurrentPackageForUpdate({
      packageRoot,
      globalRoot,
      expectedVersion: "1.9.0",
      nodePath: managedNodePath,
      runCommand: async (argv, options) => {
        const command = await runWithManagedNode(argv, options);
        return { stdout: command.stdout, stderr: command.stderr, code: command.code };
      },
      timeoutMs: 5_000,
      processAlive: () => false,
    });

    expect(result.step.exitCode).toBe(0);
    expect(result.retainedRoot).toBe(path.join(root, "lib", ".openclaw-previous"));
    expect(
      JSON.parse(await fs.readFile(path.join(result.retainedRoot ?? "", "package.json"), "utf8")),
    ).toMatchObject({ version: "1.9.0" });
    expect(
      (await fs.readdir(path.dirname(result.retainedRoot ?? ""))).filter((entry) =>
        entry.startsWith(".openclaw-previous"),
      ),
    ).toEqual([".openclaw-previous"]);

    await fs.writeFile(
      path.join(packageRoot, "package.json"),
      JSON.stringify({ name: "openclaw", version: "2.0.0" }),
    );
    await fs.writeFile(path.join(packageRoot, "dist", "entry.js"), 'console.log("2.0.0");\n');
    const replacement = await retainCurrentPackageForUpdate({
      packageRoot,
      globalRoot,
      expectedVersion: "2.0.0",
      nodePath: managedNodePath,
      runCommand: async (argv, options) => {
        const command = await runWithManagedNode(argv, options);
        return { stdout: command.stdout, stderr: command.stderr, code: command.code };
      },
      timeoutMs: 5_000,
      processAlive: () => false,
    });

    expect(replacement.step.exitCode).toBe(0);
    expect(
      JSON.parse(
        await fs.readFile(path.join(replacement.retainedRoot ?? "", "package.json"), "utf8"),
      ),
    ).toMatchObject({ version: "2.0.0" });
    expect(
      (await fs.readdir(path.dirname(replacement.retainedRoot ?? ""))).filter((entry) =>
        entry.startsWith(".openclaw-previous"),
      ),
    ).toEqual([".openclaw-previous"]);
    expect(observedNodePaths).toEqual([managedNodePath, managedNodePath]);
  });
});
