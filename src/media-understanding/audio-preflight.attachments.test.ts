import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MsgContext } from "../auto-reply/templating.js";
import type { OpenClawConfig } from "../config/types.js";
import { formatAudioTranscriptForAgent } from "../plugin-sdk/media-understanding-runtime.js";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { applyMediaUnderstanding } from "./apply.js";
import { transcribeAudioAttachments, transcribeFirstAudio } from "./audio-preflight.js";
import { createSafeAudioFixtureBuffer } from "./runner.test-utils.js";
import type { MediaUnderstandingProvider } from "./types.js";

type AudioConfig = NonNullable<NonNullable<NonNullable<OpenClawConfig["tools"]>["media"]>["audio"]>;
type SelectionOptions = {
  emptyFirst?: boolean;
  failFirst?: boolean;
  attachmentCount?: number;
  previousImageFailure?: boolean;
};
const runExecMock = vi.hoisted(() => vi.fn());
const caption = "typed caption";
const captionFields = { RawBody: caption, CommandBody: caption };
const allAttachments = { mode: "all", maxAttachments: 2 } as const;
const limitMarker = "[Audio attachment not processed: attachment limit reached]";
const failedMarker = "[Audio attachment could not be analyzed]";
const firstAudio = ["first.wav"];
const bothAudio = ["first.wav", "second.wav"];
const emptyTranscript = { emptyFirst: true };
const unsuccessfulMarkers = [failedMarker, limitMarker];

async function audioFiles(dir: string, names: string[]) {
  return Promise.all(
    names.map(async (name) => {
      const filePath = path.join(dir, name);
      await fs.writeFile(filePath, createSafeAudioFixtureBuffer());
      return { path: filePath, contentType: "audio/wav", workspaceDir: dir };
    }),
  );
}

function audioConfig(command: string, args: string[], audio: AudioConfig): OpenClawConfig {
  return {
    plugins: { enabled: false },
    tools: { media: { models: [{ type: "cli", command, args, capabilities: ["audio"] }], audio } },
  };
}
function enrichAudio(ctx: MsgContext, cfg: OpenClawConfig, workspaceDir: string) {
  return applyMediaUnderstanding({ ctx, cfg, workspaceDir, processingMode: "audio-only" });
}
vi.mock("../process/exec.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../process/exec.js")>();
  return {
    ...actual,
    runExec: (...args: Parameters<typeof actual.runExec>) =>
      args[0] === "fixture-transcriber" && runExecMock.getMockImplementation()
        ? runExecMock(...args)
        : actual.runExec(...args),
  };
});

describe("audio preflight attachment handoff", () => {
  beforeEach(() => {
    runExecMock.mockReset();
  });
  it("preserves prepared text when there is no media enrichment", async () => {
    const ctx: MsgContext = {
      Body: "transport envelope",
      agentText: "",
      BodyForAgent: "stale alias",
      ...captionFields,
    };
    const before = { ...ctx };
    await applyMediaUnderstanding({ ctx, cfg: { plugins: { enabled: false } } });

    expect(ctx.MediaUnderstanding).toBeUndefined();
    expect(ctx).toMatchObject(before);
    expect(ctx.rawText).toBeUndefined();
    expect(ctx.commandText).toBeUndefined();
  });

  it("forwards the selected workspace through preflight to the provider request", async () => {
    await withTestDir({ prefix: "openclaw-audio-preflight-workspace-" }, async (dir) => {
      const media = await audioFiles(dir, ["voice.wav"]);
      let providerWorkspaceDir: string | undefined;
      const providers: Record<string, MediaUnderstandingProvider> = {
        fixture: {
          id: "fixture",
          capabilities: ["audio"],
          defaultModels: { audio: "fixture-audio" },
          transcribeAudioWithContext: async (request) => {
            providerWorkspaceDir = request.workspaceDir;
            return { ok: true, value: { text: "The meeting starts at nine." } };
          },
        },
      };
      const cfg: OpenClawConfig = { plugins: { enabled: false }, tools: { media: { audio: {} } } };
      const ctx: MsgContext = { Body: "<media:audio>", media };

      const transcript = await transcribeFirstAudio({
        ctx,
        cfg,
        agentDir: "/state/agents/support/agent",
        workspaceDir: "/workspaces/support",
        providers,
        activeModel: { provider: "fixture", model: "chat-model" },
      });
      expect(providerWorkspaceDir).toBe("/workspaces/support");
      expect(transcript).toBe("The meeting starts at nine.");
    });
  });

  it.each<[string, AudioConfig["attachments"], boolean, string]>([
    ["default selection", undefined, false, "Body"],
    ["last preference", { prefer: "last" }, false, "agentText"],
    ["all attachments", allAttachments, false, "BodyForAgent"],
    ["empty first transcript", allAttachments, true, "agentText"],
  ])(
    "keeps first-only preflight separate from %s",
    async (_name, attachments, emptyFirst, textField) => {
      await withTestDir({ prefix: "openclaw-audio-preflight-" }, async (dir) => {
        const callsPath = path.join(dir, "calls.txt");
        const media = await audioFiles(dir, ["previous.wav", "first.wav", "second.wav"]);
        const cfg = audioConfig(
          process.execPath,
          [
            "-e",
            `const fs = require("node:fs");
const name = require("node:path").basename(process.argv[1]);
fs.appendFileSync(process.argv[2], name + "\\n");
process.stdout.write(process.argv[3] === "empty" && name === "first.wav" ? "  \\n" : "heard " + name);`,
            "{{AttachmentPath}}",
            callsPath,
            emptyFirst ? "empty" : "text",
          ],
          { attachments },
        );
        const ctx: MsgContext = {
          Body: "",
          CommandAuthorized: false,
          media: [{}, { ...media[0], transcribed: true }, ...media.slice(1)],
        };
        const transcript = await transcribeFirstAudio({ ctx, cfg });
        expect(transcript).toBe(emptyFirst ? undefined : "heard first.wav");
        const transcribed = ctx.media?.map((fact) => fact.transcribed === true);
        expect(transcribed).toEqual([false, true, !emptyFirst, false]);
        expect(await fs.readFile(callsPath, "utf8")).toBe("first.wav\n");

        ctx.Body = "transport envelope <media:audio>";
        ctx.BodyForAgent = "stale alias";
        const preparedText = transcript ? formatAudioTranscriptForAgent(transcript) : "";
        if (textField === "Body") {
          ctx.Body = preparedText;
          delete ctx.BodyForAgent;
        } else if (textField === "BodyForAgent") {
          ctx.BodyForAgent = preparedText;
        } else {
          ctx.agentText = preparedText;
        }
        Object.assign(ctx, captionFields);
        await enrichAudio(ctx, cfg, dir);

        expect(await fs.readFile(callsPath, "utf8")).toBe(
          emptyFirst ? "first.wav\nfirst.wav\nsecond.wav\n" : "first.wav\nsecond.wav\n",
        );
        expect(ctx.MediaUnderstanding).toEqual([
          expect.objectContaining({
            kind: "audio.transcription",
            attachmentIndex: 3,
            text: "heard second.wav",
          }),
        ]);
        expect(ctx.Body).toContain("heard second.wav");
        expect(ctx.agentText).toContain("heard second.wav");
        expect(ctx.BodyForAgent).toBe(ctx.agentText);
        expect(ctx.agentText).not.toContain("stale alias");
        expect(ctx).toMatchObject({ ...captionFields, rawText: caption, commandText: caption });
        expect(ctx.CommandAuthorized).toBe(false);
        if (textField !== "Body") {
          expect(ctx.Body).toContain("transport envelope");
          expect(ctx.agentText).not.toContain("transport envelope");
        }
        if (!emptyFirst) {
          expect(ctx.agentText).toContain(preparedText);
        }
      });
    },
  );
  it.each<[string, AudioConfig["attachments"], string[], string[], SelectionOptions?]>([
    ["default limit", undefined, firstAudio, [limitMarker]],
    ["last preference", { prefer: "last" }, ["second.wav"], [limitMarker]],
    ["all attachments", allAttachments, bothAudio, []],
    ["partial success", allAttachments, bothAudio, [failedMarker], emptyTranscript],
    ["empty selected attachment", undefined, firstAudio, unsuccessfulMarkers, emptyTranscript],
    [
      "failed selected attachment",
      undefined,
      firstAudio,
      unsuccessfulMarkers,
      { emptyFirst: true, failFirst: true },
    ],
    [
      "bounded dropped-attachment warnings",
      undefined,
      firstAudio,
      [...Array.from({ length: 5 }, () => limitMarker), "[2 more attachments skipped]"],
      { attachmentCount: 8 },
    ],
    ["audio-only capability scope", allAttachments, bothAudio, [], { previousImageFailure: true }],
  ])(
    "preserves configured %s through internal preflight and later enrichment",
    async (_name, attachments, expected, markers, options = {}) => {
      const { emptyFirst, failFirst, attachmentCount, previousImageFailure } = options;
      await withTestDir({ prefix: "openclaw-audio-selection-" }, async (dir) => {
        const calls: string[] = [];
        runExecMock.mockImplementation(async (_command, args: string[]) => {
          const attachmentPath = args[0];
          if (attachmentPath === undefined) {
            throw new Error("Expected the selected audio attachment path");
          }
          const name = path.basename(attachmentPath);
          calls.push(name);
          if (failFirst && name === "first.wav") {
            throw new Error("fixture transcription unavailable");
          }
          return {
            stdout: emptyFirst && name === "first.wav" ? "  \n" : "heard " + name,
            stderr: "",
          };
        });
        const media = await audioFiles(
          dir,
          Array.from({ length: attachmentCount ?? 2 }, (_, index) =>
            index === 0 ? "first.wav" : index === 1 ? "second.wav" : `note-${index}.wav`,
          ),
        );
        const cfg = audioConfig("fixture-transcriber", ["{{AttachmentPath}}"], {
          attachments,
          echoTranscript: true,
        });
        const ctx: MsgContext = {
          Body: caption,
          ...captionFields,
          Surface: "webchat",
          From: "fixture-user",
          media: [{}, ...media],
        };
        if (previousImageFailure) {
          ctx.media = [
            { url: "https://example.test/photo.jpg", contentType: "image/jpeg" },
            ...media,
          ];
          ctx.MediaUnderstandingDecisions = [
            {
              capability: "image",
              outcome: "failed",
              attachments: [],
              attachmentDispositions: { 0: { kind: "failed" } },
              nativeVisionActive: false,
            },
          ];
        }
        const transcript = await transcribeAudioAttachments({ ctx, cfg });
        const heard = expected.filter((name) => !emptyFirst || name !== "first.wav");
        const expectedTranscript =
          heard.length > 1
            ? heard.map((name, index) => `Audio ${index + 1}:\nheard ${name}`).join("\n\n")
            : heard[0] && `heard ${heard[0]}`;
        expect(transcript).toBe(expectedTranscript);
        expect(ctx.media?.map((fact) => fact.transcribed === true)).toEqual([
          false,
          ...media.map(
            (fact) =>
              (!emptyFirst || path.basename(fact.path) !== "first.wav") &&
              expected.includes(path.basename(fact.path)),
          ),
        ]);
        const preparedText = transcript ? formatAudioTranscriptForAgent(transcript) : caption;
        Object.assign(ctx, { agentText: preparedText, BodyForAgent: preparedText });
        await enrichAudio(ctx, cfg, dir);
        expect(calls).toEqual(expected);
        const agentText = [preparedText, ...markers].join("\n\n");
        expect(ctx).toMatchObject({ ...captionFields, agentText, BodyForAgent: agentText });
        expect(ctx.MediaUnderstanding).toBeUndefined();
      });
    },
  );
});
