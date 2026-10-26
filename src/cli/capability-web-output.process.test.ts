import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createCliProcessFixture } from "./isolated-process-fixture.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const fixture = fileURLToPath(new URL("../../test/fixtures/web-output-provider/", import.meta.url));
const expectedTextSha256 = "11676c445927c8cab4e9e4ef114c9839e36f150d00e2eaa827360ec9bd23d053";
const providerId = "qa-web-output";

// Node documents POSIX pipes as asynchronous; Windows pipe writes are synchronous.
describe.skipIf(process.platform === "win32")("web CLI failure output completion", () => {
  it.each([
    ["infer", "fetch", "--url", "https://example.invalid/failure"],
    ["capability", "search", "--query", "failure"],
  ])("drains %s web %s JSON before its failure exit", async (alias, action, flag, input) => {
    const root = tempDirs.make("openclaw-web-output-");
    const pluginDir = path.join(root, "plugin");
    const workspace = path.join(root, "workspace");
    const tmp = path.join(root, "tmp");
    for (const dir of [pluginDir, workspace, tmp]) {
      await fs.mkdir(dir);
    }
    await fs.cp(fixture, pluginDir, { recursive: true });
    const cli = createCliProcessFixture(root, {
      ESBUILD_WORKER_THREADS: process.env.ESBUILD_WORKER_THREADS,
      TMPDIR: tmp,
      TMP: tmp,
      TEMP: tmp,
      NODE_DISABLE_COMPILE_CACHE: "1",
      NO_COLOR: "1",
    });
    const webProvider = { enabled: true, provider: providerId };
    await cli.writeConfig({
      agents: { defaults: { workspace } },
      plugins: {
        allow: [providerId],
        load: { paths: [pluginDir] },
        entries: { [providerId]: { enabled: true } },
      },
      tools: { web: { fetch: webProvider, search: webProvider } },
      logging: { level: "silent", consoleLevel: "silent" },
    });

    const reader = { requestedPauseMs: 200, firstBufferedBytes: 0, actualPauseMs: 0 };
    const result = await cli.run(
      [alias, "web", action, "--provider", providerId, flag, input, "--json"],
      async (child) => {
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
    );
    const diagnostics = `${result.stderr}\nReader evidence: ${JSON.stringify(reader)}`;
    expect(result, diagnostics).toMatchObject({ code: 1, signal: null });
    const value: unknown = JSON.parse(result.stdout);
    assert(isRecord(value) && Array.isArray(value.outputs), diagnostics);
    const first: unknown = value.outputs[0];
    assert(
      isRecord(first) && isRecord(first.result) && typeof first.result.text === "string",
      diagnostics,
    );
    expect(value, diagnostics).toMatchObject({
      ok: false,
      capability: `web.${action}`,
      provider: providerId,
      error: "Synthetic failure",
    });
    expect(createHash("sha256").update(first.result.text).digest("hex"), diagnostics).toBe(
      expectedTextSha256,
    );
    expect(reader.firstBufferedBytes, diagnostics).toBeGreaterThan(0);
    expect(reader.actualPauseMs, diagnostics).toBeGreaterThanOrEqual(reader.requestedPauseMs);
  });
});
