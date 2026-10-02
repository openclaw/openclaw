/* @vitest-environment jsdom */
import { resolveObjectURL } from "node:buffer";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "./helpers/temp-dir.js";

// Exercise the environment installed by the native preload, including in VM tests.
const require = process.getBuiltinModule("module").createRequire(import.meta.url);
const { builtinEnvironments }: typeof import("vitest/runtime") = require("vitest/runtime");
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("jsdom native API boundary", () => {
  it("adapts the package-local Vitest environment before creating object URLs", () => {
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        pathToFileURL(path.resolve("test/vitest/vitest.jsdom-preload.mts")).href,
        "--input-type=module",
        "--eval",
        `
          import { createRequire } from "node:module";
          const require = createRequire(process.argv[1]);
          const { builtinEnvironments } = require("vitest/runtime");
          const environment = await builtinEnvironments.jsdom.setup(globalThis, {});
          try {
            const url = URL.createObjectURL(new Blob(["complete asset"], { type: "image/png" }));
            try {
              process.stdout.write(await (await fetch(url)).text());
            } finally {
              URL.revokeObjectURL(url);
            }
          } finally {
            await environment.teardown(globalThis);
          }
        `,
        path.join(
          path.dirname(
            process
              .getBuiltinModule("module")
              .createRequire(path.resolve("ui/package.json"))
              .resolve("vitest/package.json"),
          ),
          "dist/workers/forks.js",
        ),
      ],
      { encoding: "utf8" },
    );
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("complete asset");
  });

  it("allows ordinary Workers to inherit the preload without a Vitest dependency", async () => {
    const entry = path.join(tempDirs.make("openclaw-jsdom-worker-"), "worker.mjs");
    writeFileSync(
      entry,
      'import { parentPort, isMainThread } from "node:worker_threads";\n' +
        "parentPort.postMessage({ value: 42, isMainThread });\n",
    );
    const worker = new Worker(pathToFileURL(entry));
    try {
      const result = await new Promise((resolve, reject) => {
        worker.once("message", resolve);
        worker.once("error", reject);
        worker.once("exit", (code) => reject(new Error(`Worker exited before replying: ${code}`)));
      });
      expect(result).toEqual({ value: 42, isMainThread: false });
    } finally {
      await worker.terminate();
    }
  });

  it.each([0, 2])("keeps window event identity across %i iframe levels", (depth) => {
    let target: Window = window;
    let outerFrame: HTMLIFrameElement | undefined;
    for (let level = 0; level < depth; level++) {
      const frame = target.document.createElement("iframe");
      target.document.body.append(frame);
      outerFrame ??= frame;
      if (!frame.contentWindow) {
        throw new Error("Missing iframe window");
      }
      target = frame.contentWindow;
    }
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
      outerFrame?.remove();
    }
  });

  it("preserves Blob bytes through object URLs and revocation", async () => {
    const bytes = new Uint8Array([0, 1, 127, 128, 255]);
    const url = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
    try {
      expect(resolveObjectURL(url)?.type).toBe("application/octet-stream");
      const response = await fetch(url);
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    } finally {
      URL.revokeObjectURL(url);
    }
    await expect(fetch(url)).rejects.toThrow();
  });

  it("preserves Blob and multipart file bytes, names, and types in Request", async () => {
    const file = new File(["exact file bytes"], "report.bin", {
      type: "application/octet-stream",
    });
    const request = new Request("https://example.test/", { method: "POST", body: file });
    expect(await request.text()).toBe("exact file bytes");
    const form = new FormData();
    form.append("label", "synthetic");
    form.append("file", file);
    const multipart = new Request("https://example.test/", { method: "POST", body: form });
    const boundary = multipart.headers.get("content-type")?.match(/boundary=(.+)$/u)?.[1];
    expect(boundary).toBeTruthy();
    expect(await multipart.text()).toBe(
      `--${boundary}\r\n` +
        'Content-Disposition: form-data; name="label"\r\n\r\n' +
        "synthetic\r\n" +
        `--${boundary}\r\n` +
        'Content-Disposition: form-data; name="file"; filename="report.bin"\r\n' +
        "Content-Type: application/octet-stream\r\n\r\n" +
        "exact file bytes\r\n" +
        `--${boundary}--\r\n`,
    );
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
      expect(
        await new target.Request("https://example.test/", { method: "POST", body: "ok" }).text(),
      ).toBe("ok");
    } finally {
      await environment.teardown(target);
    }
    expect(Object.getOwnPropertyDescriptors(target)).toEqual(originals);
  });
});
