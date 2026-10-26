/* @vitest-environment jsdom */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveTsxImport } from "../scripts/lib/tsx-cli-shim.mjs";

// Exercise the environment installed by the native preload, including in VM tests.
const require = process.getBuiltinModule("module").createRequire(import.meta.url);
const { builtinEnvironments }: typeof import("vitest/runtime") = require("vitest/runtime");

describe("jsdom native API boundary", () => {
  it("defers DOM loading until use and adapts package-local windows and object URLs", () => {
    const result = spawnSync(
      process.execPath,
      [
        ...(process.versions.bun ? [] : ["--import", resolveTsxImport(process.cwd())]),
        "--import",
        pathToFileURL(path.resolve("test/vitest/vitest.jsdom-preload.mts")).href,
        "--input-type=module",
        "--eval",
        `
          import assert from "node:assert/strict";
          import { resolveObjectURL } from "node:buffer";
          import { createRequire } from "node:module";
          const require = createRequire(process.argv[1]);
          const { builtinEnvironments } = require("vitest/runtime");
          assert.ok(!require.cache[require.resolve("jsdom")], "preload must leave jsdom unloaded");
          const { JSDOM } = require("jsdom");
          const direct = new JSDOM("<iframe></iframe>");
          try {
            const received = [];
            for (const target of [direct.window, direct.window.document.querySelector("iframe").contentWindow]) {
              target.addEventListener("probe", () => received.push("probe"));
              target.dispatchEvent(new target.Event("probe"));
            }
            assert.deepEqual(received, ["probe", "probe"]);
          } finally {
            direct.window.close();
          }
          const environment = await builtinEnvironments.jsdom.setup(globalThis, {});
          try {
            const url = URL.createObjectURL(new Blob([new Uint8Array([0, 1, 127, 128, 255])], { type: "image/png" }));
            try {
              assert.equal(resolveObjectURL(url)?.type, "image/png");
              process.stdout.write(Buffer.from(await (await fetch(url)).arrayBuffer()).toString("hex"));
            } finally {
              URL.revokeObjectURL(url);
            }
            await assert.rejects(fetch(url));
          } finally {
            await environment.teardown(globalThis);
          }
        `,
        path.join(
          path.dirname(require.resolve("vitest/package.json", { paths: [path.resolve("ui")] })),
          "dist/workers/forks.js",
        ),
      ],
      { encoding: "utf8" },
    );
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("00017f80ff");
  });

  it("keeps event identity in nested iframe windows", () => {
    const frame = document.createElement("iframe");
    document.body.append(frame);
    frame.contentDocument!.body.innerHTML = "<iframe></iframe>";
    const target = frame.contentWindow!.frames[0]!;
    const received: Event[] = [];
    const listener = (event: Event) => received.push(event);
    const event = new Event("openclaw-jsdom-probe");
    try {
      target.addEventListener(event.type, listener);
      target.dispatchEvent(event);
      target.removeEventListener(event.type, listener);
      target.dispatchEvent(event);
      expect(received).toEqual([event]);
      expect(() => EventTarget.prototype.addEventListener.call({}, event.type, listener)).toThrow(
        /not a valid instance of EventTarget/,
      );
    } finally {
      frame.remove();
    }
  });

  it("preserves Blob and multipart file bytes, names, and types in Request", async () => {
    const file = new File(["exact file bytes"], "report.bin", { type: "application/octet-stream" });
    const request = new Request("https://example.test/", { method: "POST", body: file });
    expect(await request.text()).toBe("exact file bytes");
    const form = new FormData();
    form.append("label", "synthetic");
    form.append("file", file);
    const multipart = new Request("https://example.test/", { method: "POST", body: form });
    const decoded = await multipart.formData();
    expect(decoded.get("label")).toBe("synthetic");
    const part = decoded.get("file");
    expect(part).toMatchObject({ name: "report.bin", type: "application/octet-stream" });
    expect(await new Response(part).text()).toBe("exact file bytes");
  });

  it("keeps the DOM FileReader and File brands paired", async () => {
    const reader = new FileReader();
    const finished = new Promise<string | ArrayBuffer | null>((resolve, reject) => {
      reader.addEventListener("load", () => resolve(reader.result), { once: true });
      reader.addEventListener(
        "error",
        () => reject(reader.error ?? new Error("FileReader failed")),
        {
          once: true,
        },
      );
    });
    reader.readAsDataURL(new File(["reader bytes"], "reader.txt", { type: "text/plain" }));
    expect(await finished).toBe("data:text/plain;base64,cmVhZGVyIGJ5dGVz");
  });

  it("composes beforeParse and restores native API descriptors on teardown", async () => {
    const target = { URL, Request };
    const originals = Object.getOwnPropertyDescriptors(target);
    let preparations = 0;
    const environment = await builtinEnvironments.jsdom.setup(target, {
      jsdom: {
        beforeParse(window: Window) {
          preparations++;
          window.addEventListener("prepared", () => {});
        },
      },
    });
    try {
      expect(preparations).toBe(1);
    } finally {
      await environment.teardown(target);
    }
    expect(Object.getOwnPropertyDescriptors(target)).toEqual(originals);
  });
});
