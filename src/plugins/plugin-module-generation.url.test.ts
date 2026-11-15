import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { createPluginModuleGenerationTestHarness } from "./plugin-module-generation.test-support.js";

const { fixture, host } = createPluginModuleGenerationTestHarness();

describe("plugin module URL identity", () => {
  it.each(
    ["mjs", "ts"].flatMap((extension) =>
      // Windows import() requires file URLs; a raw drive path is a c: URL.
      ["relative", "absolute", "absolute-encoded", "file"]
        .filter((form) => form !== "absolute" || process.platform !== "win32")
        .map((form) => ({ extension, form })),
    ),
  )("preserves computed import URL identity ($extension, $form)", async ({ extension, form }) => {
    const root = fixture({
      [`index.${extension}`]: "export const read = name => import(name);",
      [`helper space.${extension}`]: "export const token = Symbol('module');",
    });
    const plugin = host(root, true).load(`index.${extension}`) as {
      read(name: string): Promise<{ token: symbol }>;
    };
    const helper = path.join(root, `helper space.${extension}`);
    const target =
      form === "relative"
        ? extension === "ts"
          ? "./helper%20space.js"
          : "./helper%20space.mjs"
        : form === "file"
          ? pathToFileURL(helper).href
          : form === "absolute-encoded"
            ? pathToFileURL(helper).pathname
            : helper;
    const query = await plugin.read(`${target}?one`);
    const fragment = await plugin.read(`${target}#two`);
    const plain = await plugin.read(target);
    expect((await plugin.read(`${target}?one`)).token).toBe(query.token);
    expect((await plugin.read(`${target}#two`)).token).toBe(fragment.token);
    expect(query.token).not.toBe(plain.token);
    expect(fragment.token).not.toBe(plain.token);
    expect(fragment.token).not.toBe(query.token);
    const next = host(root, true).load(`index.${extension}`) as typeof plugin;
    expect((await next.read(`${target}?one`)).token).not.toBe(query.token);
    expect((await plugin.read(`${target}?one`)).token).toBe(query.token);
  });
});
