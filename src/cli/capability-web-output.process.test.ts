import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { cliRecoveryEntrypoints } from "./cli-entrypoint.test-support.js";
import { runCliProcessChild } from "./cli-process-child.test-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const fixture = fileURLToPath(new URL("../../test/fixtures/web-output-provider/", import.meta.url));
const expectedTextSha256 = "11676c445927c8cab4e9e4ef114c9839e36f150d00e2eaa827360ec9bd23d053";
const providerId = "qa-web-output";
const cases = [
  { alias: "infer", action: "fetch" },
  { alias: "infer", action: "search" },
  { alias: "capability", action: "fetch" },
  { alias: "capability", action: "search" },
] as const;

// Node documents POSIX pipes as asynchronous; Windows pipe writes are synchronous.
describe.skipIf(process.platform === "win32")("web CLI failure output completion", () => {
  it.each(cases)(
    "drains $alias web $action JSON before its failure exit",
    async ({ alias, action }) => {
      const root = tempDirs.make("openclaw-web-output-");
      const pluginDir = path.join(root, "plugin");
      const workspace = path.join(root, "workspace");
      const tmp = path.join(root, "tmp");
      await fs.mkdir(pluginDir);
      await fs.mkdir(workspace);
      await fs.mkdir(tmp);
      for (const file of ["package.json", "openclaw.plugin.json", "index.js"]) {
        await fs.copyFile(path.join(fixture, file), path.join(pluginDir, file));
      }
      const configPath = path.join(root, "openclaw.json");
      await fs.writeFile(
        configPath,
        JSON.stringify({
          agents: { defaults: { workspace } },
          plugins: {
            allow: [providerId],
            load: { paths: [pluginDir] },
            entries: { [providerId]: { enabled: true } },
          },
          tools: {
            web: {
              fetch: { enabled: true, provider: providerId },
              search: { enabled: true, provider: providerId },
            },
          },
          logging: { level: "silent", consoleLevel: "silent" },
        }),
      );

      const reader = { requestedPauseMs: 200, firstBufferedBytes: 0, actualPauseMs: 0 };
      const result = await runCliProcessChild({
        nodeArgs: [
          ...resolveRuntimeWorkerArgv(resolveRuntimeWorkerUrl(cliRecoveryEntrypoints.cli)),
          alias,
          "web",
          action,
          "--provider",
          providerId,
          ...(action === "fetch"
            ? ["--url", "https://example.invalid/failure"]
            : ["--query", "failure"]),
          "--json",
        ],
        env: {
          PATH: process.env.PATH,
          ESBUILD_WORKER_THREADS: process.env.ESBUILD_WORKER_THREADS,
          HOME: root,
          USERPROFILE: root,
          TMPDIR: tmp,
          TMP: tmp,
          TEMP: tmp,
          OPENCLAW_CONFIG_PATH: configPath,
          OPENCLAW_STATE_DIR: path.join(root, "state"),
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
          OPENCLAW_NO_RESPAWN: "1",
          NODE_DISABLE_COMPILE_CACHE: "1",
          NO_COLOR: "1",
        },
        async interact(child) {
          child.stdout.pause();
          child.stdin.end();
          let onReadable: () => void = () => {};
          try {
            // Deliberate backpressure starts at real output, not process startup.
            // The helper separately observes EOF and the natural terminal status.
            await new Promise<void>((resolve) => {
              onReadable = () => {
                if (child.stdout.readableLength > 0) {
                  resolve();
                }
              };
              child.stdout.on("readable", onReadable);
              onReadable();
            });
            reader.firstBufferedBytes = child.stdout.readableLength;
            const startedAt = performance.now();
            let remaining = reader.requestedPauseMs;
            while (remaining > 0) {
              await delay(Math.ceil(remaining));
              remaining = reader.requestedPauseMs - (performance.now() - startedAt);
            }
            reader.actualPauseMs = performance.now() - startedAt;
          } finally {
            child.stdout.off("readable", onReadable);
            child.stdout.resume();
          }
        },
      });
      let parsed: unknown;
      try {
        parsed = JSON.parse(result.stdout);
      } catch {}
      const value = isRecord(parsed) ? parsed : {};
      const first =
        Array.isArray(value.outputs) && isRecord(value.outputs[0]) ? value.outputs[0] : {};
      const body = isRecord(first.result) ? first.result : {};
      const actualTextSha256 =
        typeof body.text === "string"
          ? createHash("sha256").update(body.text).digest("hex")
          : undefined;
      expect(
        {
          code: result.code,
          signal: result.signal,
          ok: value.ok,
          capability: value.capability,
          provider: value.provider,
          error: value.error,
          textSha256: actualTextSha256,
          backpressureExercised:
            reader.firstBufferedBytes > 0 && reader.actualPauseMs >= reader.requestedPauseMs,
        },
        `${result.stderr}\nReader evidence: ${JSON.stringify(reader)}`,
      ).toEqual({
        code: 1,
        signal: null,
        ok: false,
        capability: `web.${action}`,
        provider: providerId,
        error: "Synthetic failure",
        textSha256: expectedTextSha256,
        backpressureExercised: true,
      });
    },
  );
});
