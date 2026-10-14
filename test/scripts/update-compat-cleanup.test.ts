import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import {
  listUpdateCompatibilityChunkPaths,
  recordUpdateCompatibilityRelease,
  writeUpdateCompatibilityChunks,
} from "../../scripts/lib/update-compat-chunks.mts";
import { createScriptTestHarness } from "./test-helpers.js";

const { createTempDir } = createScriptTestHarness();

it("keeps the 10.1 updater's pending cleanup ahead of shared-state shutdown after replacement", async () => {
  const root = createTempDir("update-compat-cleanup-");
  const dist = path.join(root, "dist");
  fs.mkdirSync(dist);
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "openclaw", version: "2026.10.1", type: "module" }),
  );
  fs.writeFileSync(
    path.join(dist, "build-info.json"),
    JSON.stringify({ version: "2026.10.1", buildId: "fixture", commit: "0".repeat(40) }),
  );
  const write = (file: string, source: string) => fs.writeFileSync(path.join(dist, file), source);
  const load = (file: string) => import(pathToFileURL(path.join(dist, file)).href);
  write("observe.mjs", "export const entered = Promise.withResolvers();");
  // These URLs and export aliases are the published 10.1 ABI. Its run-main
  // preloads the queue owner, but its cleanup scope first loads the facade at exit.
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
  let disposed = false;
  let closed = false;
  retain(
    pending.promise.then(() => {
      disposed = true;
    }),
  );
  const updating = command(
    async () => {
      fs.unlinkSync(path.join(dist, "runtime-cleanup-Dowg583v.mjs"));
      fs.unlinkSync(path.join(dist, "runtime-cleanup-DlrF_x2c.mjs"));
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
      writeUpdateCompatibilityChunks({ distDir: dist, sourceDir: root, inventory });
      return "updated";
    },
    async () => {
      closed = true;
    },
  );
  try {
    await Promise.race([entered.promise, updating]);
    expect(closed).toBe(false);
    pending.resolve();
    expect(await updating).toBe("updated");
    expect(disposed).toBe(true);
    expect(closed).toBe(true);
    // Postinstall's output inventory must retain the resolver-visible owner too.
    expect(listUpdateCompatibilityChunkPaths(inventory)).toContain("runtime-cleanup-Dowg583v.mjs");
  } finally {
    pending.resolve();
    await updating;
  }
});
