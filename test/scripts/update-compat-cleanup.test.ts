import fs from "node:fs";
import { expect, it } from "vitest";
import {
  listUpdateCompatibilityChunkPaths,
  recordUpdateCompatibilityRelease,
  writeUpdateCompatibilityChunks,
} from "../../scripts/lib/update-compat-chunks.mts";
import { fixtureFiles } from "./script-fixture-files.test-support.js";
import { createScriptTestHarness } from "./test-helpers.js";

const { createTempDir } = createScriptTestHarness();

it("keeps the 10.1 updater's pending cleanup ahead of shared-state shutdown after replacement", async () => {
  const root = createTempDir("update-compat-cleanup-");
  const files = fixtureFiles(root);
  const { write, load, file } = fixtureFiles(files.file("dist"));
  files.json("package.json", { name: "openclaw", version: "2026.10.1", type: "module" });
  files.json("dist/build-info.json", {
    version: "2026.10.1",
    buildId: "fixture",
    commit: "0".repeat(40),
  });
  write("observe.mjs", "export const entered = Promise.withResolvers();");
  // Published 10.1 ABI: the queue is preloaded, but the facade first loads at exit.
  write(
    "runtime-cleanup-Dowg583v.mjs",
    `
    import { entered } from "./observe.mjs";
//#region src/cli/runtime-cleanup.ts
    const pending = new Set();
    export function retain(operation) { pending.add(operation); }
    async function runCliDisposerAfterPending(name, dispose) {
      entered.resolve();
      await Promise.all(pending);
      await dispose();
    }
    export { runCliDisposerAfterPending as i };
  `,
  );
  write(
    "runtime-cleanup-DlrF_x2c.mjs",
    'export { i as runCliDisposerAfterPending } from "./runtime-cleanup-Dowg583v.mjs";',
  );
  write(
    "scope.mjs",
    `
//#region src/cli/runtime-cleanup-scope.ts
    export async function command(run, close) {
      try { return await run(); }
      finally {
        const { runCliDisposerAfterPending } = await import("./runtime-cleanup-DlrF_x2c.mjs");
        await runCliDisposerAfterPending("shared-state", close);
      }
    }
  `,
  );
  const inventory = {
    schemaVersion: 1 as const,
    releases: [
      recordUpdateCompatibilityRelease({
        packageDir: root,
        integrity: `sha512-${Buffer.alloc(64).toString("base64")}`,
      }),
    ],
  };
  const { retain } = await load("runtime-cleanup-Dowg583v.mjs");
  const { command } = await load("scope.mjs");
  const { entered } = await load("observe.mjs");
  const pending = Promise.withResolvers<void>();
  const events: string[] = [];
  retain(
    pending.promise.then(() => {
      events.push("disposed");
    }),
  );
  const updating = command(
    async () => {
      for (const name of ["runtime-cleanup-Dowg583v.mjs", "runtime-cleanup-DlrF_x2c.mjs"]) {
        fs.unlinkSync(file(name));
      }
      write(
        "current.mjs",
        `
      import { entered } from "./observe.mjs";
//#region src/cli/runtime-cleanup.ts
      async function runCliDisposerAfterPending(name, dispose) {
        entered.resolve();
        await dispose();
      }
      export { runCliDisposerAfterPending as cleanup };
    `,
      );
      writeUpdateCompatibilityChunks({ distDir: files.file("dist"), sourceDir: root, inventory });
      return "updated";
    },
    async () => {
      events.push("closed");
    },
  );
  try {
    await Promise.race([entered.promise, updating]);
    expect(events).toEqual([]);
    pending.resolve();
    expect(await updating).toBe("updated");
    expect(events).toEqual(["disposed", "closed"]);
    // Postinstall's output inventory must retain the resolver-visible owner too.
    expect(listUpdateCompatibilityChunkPaths(inventory)).toContain("runtime-cleanup-Dowg583v.mjs");
  } finally {
    pending.resolve();
    await updating;
  }
});
