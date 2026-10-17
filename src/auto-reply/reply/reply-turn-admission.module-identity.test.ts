import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "tsdown";
import { expect, it } from "vitest";
import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import { spawnNodeEvalSync } from "../../test-utils/node-process.js";

it("keeps admitted session ownership when transformed plugins import the native SDK", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "reply-admission-module-")));
  const repo = process.cwd();
  const dist = path.join(root, "dist");
  const processDeclaration = resolveRuntimeWorkerUrl({
    currentModuleUrl: runtimeProcessEntrypoints.stateRead.currentModuleUrl,
    sourceWorkerName: "runtime-process-entrypoints",
    distWorkerPath: "infra/runtime-process-entrypoints.js",
  }).href;
  const deferredModules = new Set<string>();
  const source = (relativePath: string) => JSON.stringify(path.join(repo, relativePath));
  const writeFixture = (name: string, contents: string) =>
    fs.writeFileSync(path.join(root, name), contents);
  const ownerExports = `
    export { admitReplyTurn } from ${source("src/auto-reply/reply/reply-turn-admission.ts")};
    export { replyRunRegistry } from ${source("src/auto-reply/reply/reply-run-registry.ts")};
    export { replaceSessionEntrySync } from ${source("src/config/sessions/session-accessor.sqlite-entry.ts")};
    export { closeOpenClawAgentDatabasesAsync } from ${source("src/state/openclaw-agent-db.ts")};
    export { closeOpenClawStateDatabaseAsync } from ${source("src/state/openclaw-state-db.ts")};
  `;
  try {
    fs.mkdirSync(dist);
    fs.symlinkSync(path.join(repo, "node_modules"), path.join(root, "node_modules"), "junction");
    writeFixture("package.json", '{"type":"module"}\n');
    writeFixture("config.json", "{}\n");
    writeFixture(
      "host.ts",
      `${ownerExports}
       export { getCachedPluginModuleLoader } from ${source("src/plugins/plugin-module-loader-cache.ts")};`,
    );
    writeFixture("admission-runtime.ts", ownerExports);
    writeFixture("plugin.ts", 'export * from "openclaw/plugin-sdk/admission-fixture";\n');
    // Admission uses the real history worker and its cleanup owner. Borrow the maintained
    // subprocess generation; keep unrelated recovery/archival graphs deferred.
    await build({
      plugins: [
        {
          name: "defer-unexercised-runtime",
          async resolveId(id, importer, options) {
            const resolved = await this.resolve(id, importer, { skipSelf: true });
            if (!resolved || resolved.external) {
              return resolved;
            }
            const filename = path.normalize(resolved.id);
            if (filename === path.join(repo, "src/infra/runtime-process-entrypoints.ts")) {
              return { id: processDeclaration, external: true };
            }
            if (
              options.kind !== "dynamic-import" ||
              filename ===
                path.join(repo, "src/config/sessions/session-transcript-worker-runtime.ts") ||
              filename === path.join(repo, "src/infra/temp-artifact-cleanup.ts")
            ) {
              return resolved;
            }
            const url = pathToFileURL(resolved.id).href;
            deferredModules.add(url);
            return { id: url, external: true };
          },
        },
      ],
      config: false,
      cwd: repo,
      entry: {
        host: path.join(root, "host.ts"),
        "admission-runtime": path.join(root, "admission-runtime.ts"),
      },
      dts: false,
      envPrefix: [],
      clean: false,
      deps: {
        // Build the host and SDK together, matching the packaged host graph.
        alwaysBundle: (id) => id !== "@openclaw/fs-safe" && !id.startsWith("@openclaw/fs-safe/"),
      },
      platform: "node",
      format: "esm",
      outDir: dist,
      outExtensions: () => ({ js: ".js" }),
      tsconfig: path.join(repo, "tsconfig.json"),
      logLevel: "silent",
    });
    for (const schema of ["openclaw-agent-schema.sql", "openclaw-state-schema.sql"]) {
      fs.copyFileSync(path.join(repo, "src/state", schema), path.join(dist, schema));
    }
    const result = spawnNodeEvalSync(
      String.raw`
        import assert from "node:assert/strict";
        import path from "node:path";
        import { registerHooks } from "node:module";
        import { withTimeout } from "@openclaw/fs-safe/advanced";
        const root = ${JSON.stringify(root)};
        const deferredModules = new Set(${JSON.stringify([...deferredModules])});
        const unexpectedImports = [];
        const hooks = registerHooks({
          resolve(specifier, context, nextResolve) {
            if (deferredModules.has(specifier)) {
              unexpectedImports.push(specifier);
              throw new Error("Admission fixture entered deferred runtime: " + specifier);
            }
            return nextResolve(specifier, context);
          },
        });
        let host;
        let transformed;
        const bounded = (work, label) => withTimeout(work, 5_000, {
          message: "Admission probe stalled: " + label,
        });
        try {
          host = await import(${JSON.stringify(pathToFileURL(path.join(dist, "host.js")).href)});
          const native = await import(${JSON.stringify(pathToFileURL(path.join(dist, "admission-runtime.js")).href)});
          assert.equal(native.admitReplyTurn, host.admitReplyTurn, "native SDK shares the host graph");
          const modulePath = path.join(root, "plugin.ts");
          transformed = host.getCachedPluginModuleLoader({
            modulePath, rootDir: root, importerUrl: import.meta.url, tryNative: false,
            aliasMap: { "openclaw/plugin-sdk/admission-fixture": path.join(root, "dist/admission-runtime.js") },
          })(modulePath);
          assert.equal(transformed.admitReplyTurn, host.admitReplyTurn, "plugin transformation retains the native admission owner");
          for (const foreign of [false, true]) {
            const name = foreign ? "transformed-foreign-store" : "transformed-same-store";
            const sessionKey = "global";
            const sessionId = "before-" + name;
            const successorId = "after-" + name;
            // Reuse the target database; each scenario still owns a distinct operation and UUID.
            const caseRoot = path.join(root, "state");
            const targetStore = path.join(caseRoot, "target", "sessions.json");
            const parentStore = foreign
              ? path.join(caseRoot, "foreign", "sessions.json") : targetStore;
            const write = (storePath, id) => host.replaceSessionEntrySync(
              { storePath, sessionKey }, { sessionId: id, updatedAt: Date.now() },
            );
            write(targetStore, sessionId);
            if (foreign) write(parentStore, sessionId);
            const admitted = await bounded(transformed.admitReplyTurn({
              sessionKey, sessionId, storePath: parentStore, kind: "visible", resetTriggered: false,
            }), name + " parent");
            assert.equal(admitted.status, "owned", "parent must hold actual admission");
            const parent = admitted.operation;
            const waitForIdle = host.replyRunRegistry.waitForIdle;
            const controller = new AbortController();
            let child;
            let pending;
            try {
              parent.setPhase("preflight_compacting");
              let enteredWait;
              const waiting = new Promise(resolve => { enteredWait = resolve; });
              host.replyRunRegistry.waitForIdle = function (...args) {
                const result = waitForIdle.apply(this, args);
                enteredWait();
                return result;
              };
              pending = host.admitReplyTurn({
                sessionKey, sessionId, expectedSessionId: sessionId, storePath: targetStore,
                kind: "queued_followup", resetTriggered: false, waitTimeoutMs: 5_000,
                upstreamAbortSignal: controller.signal,
              });
              void pending.catch(() => {});
              await bounded(waiting, name + " native waitForIdle");
              write(parentStore, successorId);
              // Equal UUIDs in a separately replaced store cannot prove this parent's ownership.
              if (foreign) write(targetStore, successorId);
              parent.updateSessionId(successorId);
              parent.complete();
              child = await bounded(pending, name + " successor");
              if (foreign) {
                assert.equal(child.status, "skipped");
                assert.equal(child.reason, "lifecycle-invalidated");
              } else {
                assert.equal(child.status, "owned");
                assert.equal(child.operation.sessionId, successorId);
              }
            } finally {
              host.replyRunRegistry.waitForIdle = waitForIdle;
              parent.complete();
              if (child?.status === "owned") child.operation.complete();
              controller.abort();
              if (pending) {
                const unfinished = await bounded(pending, name + " cleanup").catch(() => undefined);
                if (unfinished?.status === "owned") unfinished.operation.complete();
              }
            }
          }
        } finally {
          for (const runtime of [transformed, host]) await runtime?.closeOpenClawAgentDatabasesAsync();
          for (const runtime of [transformed, host]) await runtime?.closeOpenClawStateDatabaseAsync();
          hooks.deregister();
        }
        assert.deepEqual(unexpectedImports, [], "all exercised runtime must stay in the fixture graph");
      `,
      {
        timeout: 45_000,
        env: {
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          HOME: root,
          USERPROFILE: root,
          OPENCLAW_STATE_DIR: path.join(root, "state"),
          OPENCLAW_CONFIG_PATH: path.join(root, "config.json"),
          XDG_CACHE_HOME: path.join(root, "cache"),
          JITI_FS_CACHE: "0",
        },
      },
    );
    expect(
      result.status,
      [result.stdout, result.stderr, result.error?.message].filter(Boolean).join("\n"),
    ).toBe(0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 90_000);
