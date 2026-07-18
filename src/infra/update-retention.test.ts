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
    await fs.mkdir(path.join(packageRoot, "dist"), { recursive: true });
    await fs.writeFile(
      path.join(packageRoot, "package.json"),
      JSON.stringify({ name: "openclaw", version: "1.9.0" }),
    );
    await fs.writeFile(path.join(packageRoot, "dist", "entry.js"), 'console.log("1.9.0");\n');

    const result = await retainCurrentPackageForUpdate({
      packageRoot,
      globalRoot,
      expectedVersion: "1.9.0",
      runCommand: async (argv, options) => {
        const command = await runCommandWithTimeout(argv, options);
        return { stdout: command.stdout, stderr: command.stderr, code: command.code };
      },
      timeoutMs: 5_000,
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
  });
});
