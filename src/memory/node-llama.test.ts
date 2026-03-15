import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { importNodeLlamaCpp } from "./node-llama.js";

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("importNodeLlamaCpp", () => {
  it("falls back to a resolved package entry when bare global import is unavailable", async () => {
    const prefix = await makeTempDir("openclaw-node-llama-prefix-");
    const globalRoot = path.join(prefix, "lib", "node_modules");
    const fakeOpenClawDist = path.join(globalRoot, "openclaw", "dist");
    const fakeNodeLlama = path.join(globalRoot, "node-llama-cpp");

    await fs.mkdir(fakeOpenClawDist, { recursive: true });
    await fs.mkdir(fakeNodeLlama, { recursive: true });
    await fs.writeFile(
      path.join(fakeNodeLlama, "package.json"),
      `${JSON.stringify(
        {
          name: "node-llama-cpp",
          type: "module",
          exports: "./index.js",
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );
    await fs.writeFile(
      path.join(fakeNodeLlama, "index.js"),
      'export const marker = "resolved-global-node-llama";\n',
      "utf-8",
    );

    const importer = async (specifier: string) => {
      if (specifier === "node-llama-cpp") {
        throw Object.assign(new Error("Cannot find package 'node-llama-cpp'"), {
          code: "ERR_MODULE_NOT_FOUND",
        });
      }
      return import(specifier);
    };

    const mod = (await importNodeLlamaCpp({
      metaUrl: pathToFileURL(path.join(fakeOpenClawDist, "auth-profiles.mjs")).href,
      env: { npm_config_prefix: prefix },
      globalPaths: [],
      importer,
    })) as { marker?: string };

    expect(mod.marker).toBe("resolved-global-node-llama");
  });
});
