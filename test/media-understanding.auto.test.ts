import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MsgContext } from "../src/auto-reply/templating.js";
import type { OpenClawConfig } from "../src/config/config.js";
import { resolvePreferredOpenClawTmpDir } from "../src/infra/tmp-openclaw-dir.js";
import { applyMediaUnderstanding } from "../src/media-understanding/apply.js";
import { clearMediaUnderstandingBinaryCacheForTests } from "../src/media-understanding/runner.js";

const makeTempDir = async (prefix: string) => {
  const baseDir = resolvePreferredOpenClawTmpDir();
  await fs.mkdir(baseDir, { recursive: true });
  return await fs.mkdtemp(path.join(baseDir, prefix));
};

const writeExecutable = async (dir: string, name: string, content: string) => {
  const filePath = path.join(dir, name);
  await fs.writeFile(filePath, content, { mode: 0o755 });
  return filePath;
};

const makeTempMedia = async (ext: string) => {
  const dir = await makeTempDir("openclaw-media-e2e-");
  const filePath = path.join(dir, `sample${ext}`);
  await fs.writeFile(filePath, "audio");
  return { dir, filePath };
};

const envSnapshot = () => ({
  PATH: process.env.PATH,
  SHERPA_ONNX_MODEL_DIR: process.env.SHERPA_ONNX_MODEL_DIR,
  WHISPER_CPP_MODEL: process.env.WHISPER_CPP_MODEL,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  GROQ_API_KEY: process.env.GROQ_API_KEY,
  DEEPGRAM_API_KEY: process.env.DEEPGRAM_API_KEY,
  GEMINI_API_KEY: process.env.GEMINI_API_KEY,
  OPENCLAW_AGENT_DIR: process.env.OPENCLAW_AGENT_DIR,
  PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
});

const restoreEnv = (snapshot: ReturnType<typeof envSnapshot>) => {
  const restoreEnvVar = (key: string, value: string | undefined) => {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  };
  restoreEnvVar("PATH", snapshot.PATH);
  restoreEnvVar("SHERPA_ONNX_MODEL_DIR", snapshot.SHERPA_ONNX_MODEL_DIR);
  restoreEnvVar("WHISPER_CPP_MODEL", snapshot.WHISPER_CPP_MODEL);
  restoreEnvVar("OPENAI_API_KEY", snapshot.OPENAI_API_KEY);
  restoreEnvVar("GROQ_API_KEY", snapshot.GROQ_API_KEY);
  restoreEnvVar("DEEPGRAM_API_KEY", snapshot.DEEPGRAM_API_KEY);
  restoreEnvVar("GEMINI_API_KEY", snapshot.GEMINI_API_KEY);
  restoreEnvVar("OPENCLAW_AGENT_DIR", snapshot.OPENCLAW_AGENT_DIR);
  restoreEnvVar("PI_CODING_AGENT_DIR", snapshot.PI_CODING_AGENT_DIR);
};

const withEnvSnapshot = async <T>(run: () => Promise<T>): Promise<T> => {
  const snapshot = envSnapshot();
  try {
    return await run();
  } finally {
    restoreEnv(snapshot);
  }
};

const createTrackedTempDir = async (tempPaths: string[], prefix: string) => {
  const dir = await makeTempDir(prefix);
  tempPaths.push(dir);
  return dir;
};

const createTrackedTempMedia = async (tempPaths: string[], ext: string) => {
  const media = await makeTempMedia(ext);
  tempPaths.push(media.dir);
  return media.filePath;
};

describe("media understanding auto-detect (e2e)", () => {
  let tempPaths: string[] = [];

  beforeEach(() => {
    clearMediaUnderstandingBinaryCacheForTests();
  });

  afterEach(async () => {
    for (const p of tempPaths) {
      await fs.rm(p, { recursive: true, force: true }).catch(() => {});
    }
    tempPaths = [];
  });

  it.skipIf(process.platform === "win32")("uses sherpa-onnx-offline when available", async () => {
    await withEnvSnapshot(async () => {
      const binDir = await createTrackedTempDir(tempPaths, "openclaw-bin-sherpa-");
      const modelDir = await createTrackedTempDir(tempPaths, "openclaw-sherpa-model-");

      await fs.writeFile(path.join(modelDir, "tokens.txt"), "a");
      await fs.writeFile(path.join(modelDir, "encoder.onnx"), "a");
      await fs.writeFile(path.join(modelDir, "decoder.onnx"), "a");
      await fs.writeFile(path.join(modelDir, "joiner.onnx"), "a");

      await writeExecutable(
        binDir,
        "sherpa-onnx-offline",
        `#!/usr/bin/env bash\necho "{\\"text\\":\\"sherpa ok\\"}"\n`,
      );

      process.env.PATH = `${binDir}:/usr/bin:/bin`;
      process.env.SHERPA_ONNX_MODEL_DIR = modelDir;

      const filePath = await createTrackedTempMedia(tempPaths, ".wav");

      const ctx: MsgContext = {
        Body: "<media:audio>",
        MediaPath: filePath,
        MediaType: "audio/wav",
      };
      const cfg: OpenClawConfig = { tools: { media: { audio: {} } } };

      await applyMediaUnderstanding({ ctx, cfg });

      expect(ctx.Transcript).toBe("sherpa ok");
    });
  });

  it.skipIf(process.platform === "win32")("uses whisper-cli when sherpa is missing", async () => {
    await withEnvSnapshot(async () => {
      const binDir = await createTrackedTempDir(tempPaths, "openclaw-bin-whispercpp-");
      const modelDir = await createTrackedTempDir(tempPaths, "openclaw-whispercpp-model-");

      const modelPath = path.join(modelDir, "tiny.bin");
      await fs.writeFile(modelPath, "model");

      await writeExecutable(
        binDir,
        "whisper-cli",
        "#!/usr/bin/env bash\n" +
          'out=""\n' +
          'prev=""\n' +
          'for arg in "$@"; do\n' +
          '  if [ "$prev" = "-of" ]; then out="$arg"; break; fi\n' +
          '  prev="$arg"\n' +
          "done\n" +
          'if [ -n "$out" ]; then echo \'whisper cpp ok\' > "${out}.txt"; fi\n',
      );

      process.env.PATH = `${binDir}:/usr/bin:/bin`;
      process.env.WHISPER_CPP_MODEL = modelPath;

      const filePath = await createTrackedTempMedia(tempPaths, ".wav");

      const ctx: MsgContext = {
        Body: "<media:audio>",
        MediaPath: filePath,
        MediaType: "audio/wav",
      };
      const cfg: OpenClawConfig = { tools: { media: { audio: {} } } };

      await applyMediaUnderstanding({ ctx, cfg });

      expect(ctx.Transcript).toBe("whisper cpp ok");
    });
  });

  it.skipIf(process.platform === "win32")("uses gemini CLI for images when available", async () => {
    await withEnvSnapshot(async () => {
      const binDir = await createTrackedTempDir(tempPaths, "openclaw-bin-gemini-");

      await writeExecutable(
        binDir,
        "gemini",
        `#!/usr/bin/env bash\necho '{"response":"gemini ok"}'\n`,
      );

      process.env.PATH = `${binDir}:/usr/bin:/bin`;

      const filePath = await createTrackedTempMedia(tempPaths, ".png");

      const ctx: MsgContext = {
        Body: "<media:image>",
        MediaPath: filePath,
        MediaType: "image/png",
      };
      const cfg: OpenClawConfig = { tools: { media: { image: {} } } };

      await applyMediaUnderstanding({ ctx, cfg });

      expect(ctx.Body).toContain("gemini ok");
    });
  });

  it("skips auto-detect when no supported binaries are available", async () => {
    await withEnvSnapshot(async () => {
      const emptyBinDir = await createTrackedTempDir(tempPaths, "openclaw-bin-empty-");
      const isolatedAgentDir = await createTrackedTempDir(tempPaths, "openclaw-agent-empty-");
      process.env.PATH = emptyBinDir;
      delete process.env.SHERPA_ONNX_MODEL_DIR;
      delete process.env.WHISPER_CPP_MODEL;
      delete process.env.OPENAI_API_KEY;
      delete process.env.GROQ_API_KEY;
      delete process.env.DEEPGRAM_API_KEY;
      delete process.env.GEMINI_API_KEY;
      process.env.OPENCLAW_AGENT_DIR = isolatedAgentDir;
      process.env.PI_CODING_AGENT_DIR = isolatedAgentDir;

      const filePath = await createTrackedTempMedia(tempPaths, ".wav");
      const ctx: MsgContext = {
        Body: "<media:audio>",
        MediaPath: filePath,
        MediaType: "audio/wav",
      };
      const cfg: OpenClawConfig = { tools: { media: { audio: {} } } };

      await applyMediaUnderstanding({ ctx, cfg });

      expect(ctx.Transcript).toBeUndefined();
      expect(ctx.Body).toBe("<media:audio>");
    });
  });
});
