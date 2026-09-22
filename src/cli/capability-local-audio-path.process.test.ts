import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { createWhisperExecutable } from "../media-understanding/local-audio.test-support.js";
import { createSafeAudioFixtureBuffer } from "../media-understanding/runner.test-utils.js";
import { cliRecoveryEntrypoints } from "./cli-entrypoint.test-support.js";
import { runCliProcessChild } from "./cli-process-child.test-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

// The synthetic executable uses /bin/sh; Windows suffix lookup has owner coverage.
describe.skipIf(process.platform === "win32")("infer local audio executable selection", () => {
  it.each([
    { name: "a literal home-relative PATH", homeRelative: true, decoy: false },
    { name: "a home-relative PATH before a later decoy", homeRelative: true, decoy: true },
    { name: "an absolute PATH", homeRelative: false, decoy: false },
  ])("transcribes with the discovered executable from $name", async ({ homeRelative, decoy }) => {
    const root = tempDirs.make("openclaw-infer-local-audio-");
    const binDir = path.join(root, "qa-stt-bin");
    const decoyDir = path.join(root, "decoy-bin");
    const tmp = path.join(root, "tmp");
    const workspace = path.join(root, "workspace");
    await Promise.all([binDir, decoyDir, tmp, workspace].map((dir) => fs.mkdir(dir)));
    const transcript = "preferred synthetic transcript";
    await createWhisperExecutable(binDir, transcript);
    if (decoy) {
      await createWhisperExecutable(decoyDir, "wrong executable transcript");
    }
    const mediaPath = path.join(root, "input.wav");
    await fs.writeFile(mediaPath, createSafeAudioFixtureBuffer(2048, 0x52));
    const configPath = path.join(root, "openclaw.json");
    await fs.writeFile(
      configPath,
      JSON.stringify({
        agents: { defaults: { workspace }, entries: { main: {} } },
        plugins: { enabled: false },
        tools: { media: { audio: { enabled: true } } },
        logging: { level: "silent", consoleLevel: "silent" },
      }),
    );
    const searchPath = [homeRelative ? "~/qa-stt-bin" : binDir, ...(decoy ? [decoyDir] : [])];
    const result = await runCliProcessChild({
      nodeArgs: [
        ...resolveRuntimeWorkerArgv(resolveRuntimeWorkerUrl(cliRecoveryEntrypoints.cli)),
        "infer",
        "audio",
        "transcribe",
        "--file",
        mediaPath,
        "--json",
      ],
      cwd: root,
      env: {
        PATH: searchPath.join(path.delimiter),
        ESBUILD_WORKER_THREADS: process.env.ESBUILD_WORKER_THREADS,
        HOME: root,
        USERPROFILE: root,
        TMPDIR: tmp,
        TMP: tmp,
        TEMP: tmp,
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_STATE_DIR: path.join(root, "state"),
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
        // Keep startup from appending host audio tools to this isolated PATH.
        OPENCLAW_PATH_BOOTSTRAPPED: "1",
        OPENCLAW_NO_RESPAWN: "1",
        NODE_DISABLE_COMPILE_CACHE: "1",
        NO_COLOR: "1",
      },
    });
    expect(result.signal, result.stderr).toBeNull();
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      capability: "audio.transcribe",
      transport: "local",
      provider: "whisper",
      outputs: [{ path: mediaPath, text: transcript, kind: "audio.transcription" }],
    });
  });
});
