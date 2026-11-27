import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import type { MsgContext } from "../auto-reply/templating.js";
import type { OpenClawConfig } from "../config/types.js";
import { withCommandProcessScope } from "../process/exec-spawn.js";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { withEnvAsync } from "../test-utils/env.js";
import { transcribeFirstAudio } from "./audio-preflight.js";
import { createSafeAudioFixtureBuffer } from "./runner.test-utils.js";

const transcript = "Alice and Bob, please respond.";
type Fixture = {
  cfg: OpenClawConfig;
  contexts: MsgContext[];
  command: string;
  model: string;
  failPath: string;
  calls: () => Promise<number>;
  invoke: (index: number, overrides?: Partial<MsgContext>) => Promise<string | undefined>;
};

async function withAccounts(run: (fixture: Fixture) => Promise<void>) {
  await withTestDir({ prefix: "openclaw-shared-audio-" }, async (dir) => {
    const callsPath = path.join(dir, "calls.txt");
    const failPath = path.join(dir, "fail-once");
    const command = path.join(dir, "whisper-cli");
    const model = path.join(dir, "fixture-model.bin");
    await fs.writeFile(model, "fixture, not an inference model");
    // Only external STT I/O is fixed. Discovery, safe input read, preflight,
    // subprocess execution, output-file decoding and per-caller handoff are real.
    await fs.writeFile(
      command,
      "#!" +
        process.execPath +
        "\n" +
        'const fs = require("node:fs"); const args = process.argv.slice(2);' +
        "fs.appendFileSync(" +
        JSON.stringify(callsPath) +
        ', "transcribed" + String.fromCharCode(10));' +
        "if (fs.existsSync(" +
        JSON.stringify(failPath) +
        ")) { fs.unlinkSync(" +
        JSON.stringify(failPath) +
        "); process.exit(1); }" +
        "const input = args.at(-1); if (fs.readFileSync(input).length < 100) process.exit(2);" +
        'const output = args[args.indexOf("-of") + 1]; fs.writeFileSync(output + ".txt", ' +
        JSON.stringify(transcript) +
        ");",
      { mode: 0o700 },
    );
    const cfg: OpenClawConfig = { plugins: { enabled: false }, tools: { media: { audio: {} } } };
    const contexts: MsgContext[] = await Promise.all(
      ["alice", "bob"].map(async (account) => {
        const audioPath = path.join(dir, account + ".wav");
        await fs.writeFile(audioPath, createSafeAudioFixtureBuffer());
        return {
          Provider: "telegram",
          Surface: "telegram",
          OriginatingChannel: "telegram",
          OriginatingTo: "telegram:-1001234567",
          AccountId: account,
          MessageSid: "42",
          ChatType: "group",
          MessageThreadId: 9,
          media: [
            { path: audioPath, contentType: "audio/wav", fileName: "voice.wav", workspaceDir: dir },
          ],
        };
      }),
    );
    await withEnvAsync(
      { PATH: dir, WHISPER_CPP_MODEL: model, SHERPA_ONNX_MODEL_DIR: undefined },
      async () => {
        await run({
          cfg,
          contexts,
          command,
          model,
          failPath,
          calls: async () => (await fs.readFile(callsPath, "utf8")).trim().split("\n").length,
          invoke: (index, overrides = {}) =>
            transcribeFirstAudio({
              ctx: {
                ...contexts[index],
                media: structuredClone(contexts[index]?.media),
                ...overrides,
              },
              cfg,
            }),
        });
      },
    );
  });
}

const unixTest = it.skipIf(process.platform === "win32");
unixTest(
  "transcribes matching Telegram accounts once, including a near-concurrent account",
  async () => {
    await withAccounts(async ({ contexts, cfg, calls, invoke }) => {
      const texts = await Promise.all(contexts.map((ctx) => transcribeFirstAudio({ ctx, cfg })));
      expect(texts).toEqual([transcript, transcript]);
      for (const ctx of contexts) {
        expect(ctx.media?.[0]?.transcribed).toBe(true);
        expect(ctx.CommandAuthorized).toBeUndefined();
        ctx.media = ctx.media?.map(({ transcribed: _transcribed, ...fact }) => fact);
      }
      expect(await invoke(1)).toBe(transcript);
      expect(await calls()).toBe(1);
    });
  },
);

unixTest.each([
  ["chat", { OriginatingTo: "telegram:-1007654321" }],
  ["topic", { MessageThreadId: 10 }],
  ["message", { MessageSid: "43" }],
] satisfies Array<[string, Partial<MsgContext>]>)(
  "does not share across a different %s",
  async (_name, overrides) => {
    await withAccounts(async ({ invoke, calls }) => {
      expect(await invoke(0)).toBe(transcript);
      expect(await invoke(1, overrides)).toBe(transcript);
      expect(await calls()).toBe(2);
    });
  },
);

unixTest("does not share changed bytes or changed transcription settings", async () => {
  await withAccounts(async ({ invoke, calls, contexts, cfg }) => {
    expect(await invoke(0)).toBe(transcript);
    await fs.writeFile(
      contexts[1]!.media![0]!.path!,
      createSafeAudioFixtureBuffer(undefined, 0x52),
    );
    expect(await invoke(1)).toBe(transcript);
    cfg.tools!.media!.audio!.language = "de";
    expect(await invoke(0)).toBe(transcript);
    expect(await calls()).toBe(3);
  });
});

unixTest("rechecks each account's scope before any cached result", async () => {
  await withAccounts(async ({ invoke, calls, cfg }) => {
    cfg.tools!.media!.audio!.scope = {
      rules: [{ action: "deny", match: { keyPrefix: "blocked:" } }],
    };
    expect(await invoke(0)).toBe(transcript);
    expect(await invoke(1, { SessionKey: "blocked:bob" })).toBeUndefined();
    expect(await calls()).toBe(1);
  });
});

unixTest("does not borrow a cached result into a caller-owned process scope", async () => {
  await withAccounts(async ({ invoke, calls }) => {
    expect(await invoke(0)).toBe(transcript);
    expect(await withCommandProcessScope(() => invoke(1))).toBe(transcript);
    expect(await calls()).toBe(2);
  });
});

unixTest("keeps explicitly configured CLI commands independent", async () => {
  await withAccounts(async ({ invoke, calls, cfg, command, model }) => {
    cfg.tools!.media!.models = [
      {
        type: "cli",
        command,
        capabilities: ["audio"],
        args: ["-m", model, "-otxt", "-of", "{{OutputBase}}", "{{AttachmentPath}}"],
      },
    ];
    expect(await invoke(0)).toBe(transcript);
    expect(await invoke(1)).toBe(transcript);
    expect(await calls()).toBe(2);
  });
});

unixTest("evicts a failed local transcription so the next account can retry", async () => {
  await withAccounts(async ({ invoke, calls, failPath }) => {
    await fs.writeFile(failPath, "fail");
    expect(await invoke(0)).toBeUndefined();
    expect(await invoke(1)).toBe(transcript);
    expect(await calls()).toBe(2);
  });
});

unixTest.each(["absolute", "relative"] as const)(
  "preserves discovery symlink traversal for %s PATH before sharing",
  async (form) => {
    await withAccounts(async ({ command, invoke, calls }) => {
      const root = path.dirname(command);
      const configured = path.join(root, "configured");
      const actual = path.join(root, "actual");
      await fs.mkdir(configured);
      await fs.mkdir(path.join(actual, "bin"), { recursive: true });
      await fs.symlink(path.join(actual, "bin"), path.join(configured, "alias"));
      const script = await fs.readFile(command, "utf8");
      await fs.writeFile(path.join(actual, "whisper-cli"), script, { mode: 0o700 });
      await fs.writeFile(
        path.join(configured, "whisper-cli"),
        script.replace(JSON.stringify(transcript), JSON.stringify("DECOY TRANSCRIPT")),
        { mode: 0o700 },
      );
      const directory = form === "absolute" ? configured : path.relative(process.cwd(), configured);
      await withEnvAsync({ PATH: directory + "/alias/.." }, async () => {
        expect(await Promise.all([invoke(0), invoke(1)])).toEqual([transcript, transcript]);
        expect(await calls()).toBe(1);
      });
    });
  },
);
