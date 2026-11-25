import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../helpers/temp-dir.js";
import {
  buildRealtimeTalkLiveCommand,
  parseRealtimeTalkLiveOptions,
  runRealtimeTalkLiveProducer,
} from "./realtime-talk-live.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function runSmoke(
  runChild: NonNullable<Parameters<typeof runRealtimeTalkLiveProducer>[2]>["runChild"],
  env: NodeJS.ProcessEnv = { OPENAI_API_KEY: "test-key" },
) {
  const artifactBase = tempDirs.make("realtime-talk-live-");
  const options = { artifactBase, repoRoot: process.cwd() };
  const evidence = await runRealtimeTalkLiveProducer(options, env, { runChild });
  return {
    result: evidence.entries[0]?.result,
    artifacts: JSON.stringify(evidence),
    log: await fs.readFile(path.join(artifactBase, "realtime-talk-live.log"), "utf8"),
  };
}

describe("realtime Talk live QA producer", () => {
  it("builds the canonical one-cycle OpenAI-only smoke command", () => {
    const command = buildRealtimeTalkLiveCommand({ OPENAI_API_KEY: "test-key" });
    expect(command.args).toEqual(
      "--import tsx scripts/dev/realtime-talk-live-smoke.ts --openai-only --openai-audio-cycles 1".split(
        " ",
      ),
    );
    expect(command.env.OPENAI_API_KEY).toBe("test-key");
  });

  it("writes blocked evidence without exposing unrelated or missing credentials", async () => {
    const runChild = vi.fn();
    const { result, artifacts, log } = await runSmoke(runChild, { OTHER_SECRET: "do-not-record" });

    expect(runChild).not.toHaveBeenCalled();
    expect(result?.status).toBe("blocked");
    expect(artifacts).not.toContain("do-not-record");
    expect(log).toContain("OPENAI_API_KEY is not set");
    expect(log).not.toContain("do-not-record");
  });

  it("records only normalized status and byte metadata for a passing smoke", async () => {
    const apiKey = "sk-private-test-key";
    const transcript = "private transcript must never persist";
    const { result, artifacts, log } = await runSmoke(
      async ({ onStderr, onStdout }) => {
        onStdout("openai-backend-bridge: o");
        onStdout(`k { token: '${apiKey}' }\n`);
        onStdout(`openai-backend-audio-roundtrip: ok {\n transcripts: ['${transcript}']\n}\n`);
        onStdout("openai-webrtc-browser: ok { state: 'connected' }");
        onStderr("provider debug output should not persist");
        return { exitCode: 0, signal: null };
      },
      { OPENAI_API_KEY: apiKey },
    );

    expect(result?.status).toBe("pass");
    expect(log).toContain("audioFormat: pcm16le");
    expect(log).toContain("audioSampleRateHz: 24000");
    expect(log).toContain("openai-webrtc-browser=ok");
    expect(log).toMatch(/statusSha256: [a-f0-9]{64}/u);
    for (const output of [log, artifacts]) {
      expect(output).not.toContain(apiKey);
      expect(output).not.toContain(transcript);
    }
    expect(log).not.toContain("provider debug output");
  });

  it("fails clean exits that omit an expected smoke leg", async () => {
    const { result } = await runSmoke(async ({ onStdout }) => {
      onStdout("openai-backend-bridge: ok {}\n");
      onStdout("openai-backend-audio-roundtrip: ok {}\n");
      return { exitCode: 0, signal: null };
    });

    expect(result?.status).toBe("fail");
    expect(result?.failure?.reason).toContain("openai-webrtc-browser=missing");
  });

  it("reports missing Playwright as blocked harness evidence", async () => {
    const { result } = await runSmoke(async ({ onStderr }) => {
      onStderr("Executable doesn't exist. Run npx playwright install chromium.");
      return { exitCode: 1, signal: null };
    });

    expect(result?.status).toBe("blocked");
  });

  it("keeps an observed smoke failure terminal when the harness is also blocked", async () => {
    const { result, log } = await runSmoke(async ({ onStderr, onStdout }) => {
      onStdout("openai-backend-bridge: failed { error: 'private provider error' }");
      onStderr("Executable doesn't exist. Run npx playwright install chromium.");
      return { exitCode: 1, signal: null };
    });

    expect(result?.status).toBe("fail");
    expect(result?.failure?.reason).toContain("openai-backend-bridge=failed");
    expect(log).not.toContain("private provider error");
  });
});

describe("realtime Talk live QA options", () => {
  const artifactFlag = "--artifact-base";

  it("resolves the artifact directory from the selected repo root", () => {
    expect(
      parseRealtimeTalkLiveOptions(["--repo-root", "/tmp/openclaw", artifactFlag, ".artifacts/a"]),
    ).toEqual({
      artifactBase: "/tmp/openclaw/.artifacts/a",
      repoRoot: "/tmp/openclaw",
    });
  });

  it("requires an artifact base and rejects duplicate options", () => {
    expect(() => parseRealtimeTalkLiveOptions([])).toThrow("--artifact-base is required");
    expect(() => parseRealtimeTalkLiveOptions([artifactFlag, "one", artifactFlag, "two"])).toThrow(
      "--artifact-base was provided more than once",
    );
  });
});
