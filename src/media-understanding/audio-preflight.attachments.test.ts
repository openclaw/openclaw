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

const runExecMock = vi.hoisted(() => vi.fn());
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
      RawBody: "typed caption",
      CommandBody: "typed caption",
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
      const filePath = path.join(dir, "voice.wav");
      await fs.writeFile(filePath, createSafeAudioFixtureBuffer());
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
      const cfg: OpenClawConfig = {
        plugins: { enabled: false },
        tools: { media: { audio: {} } },
      };
      const ctx: MsgContext = {
        Body: "<media:audio>",
        media: [{ path: filePath, contentType: "audio/wav", workspaceDir: dir }],
      };

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

  it.each([
    { name: "default selection", attachments: undefined, emptyFirst: false, textField: "Body" },
    {
      name: "last preference",
      attachments: { prefer: "last" as const },
      emptyFirst: false,
      textField: "agentText",
    },
    {
      name: "all attachments",
      attachments: { mode: "all" as const, maxAttachments: 2 },
      emptyFirst: false,
      textField: "BodyForAgent",
    },
    {
      name: "empty first transcript",
      attachments: { mode: "all" as const, maxAttachments: 2 },
      emptyFirst: true,
      textField: "agentText",
    },
  ])(
    "keeps first-only preflight separate from $name",
    async ({ attachments, emptyFirst, textField }) => {
      await withTestDir({ prefix: "openclaw-audio-preflight-" }, async (dir) => {
        const callsPath = path.join(dir, "calls.txt");
        const media = await Promise.all(
          ["previous.wav", "first.wav", "second.wav"].map(async (name) => {
            const filePath = path.join(dir, name);
            await fs.writeFile(filePath, createSafeAudioFixtureBuffer());
            return { path: filePath, contentType: "audio/wav", workspaceDir: dir };
          }),
        );
        const cfg: OpenClawConfig = {
          plugins: { enabled: false },
          tools: {
            media: {
              models: [
                {
                  type: "cli",
                  command: process.execPath,
                  args: [
                    "-e",
                    `const fs = require("node:fs");
const name = require("node:path").basename(process.argv[1]);
fs.appendFileSync(process.argv[2], name + "\\n");
process.stdout.write(process.argv[3] === "empty" && name === "first.wav" ? "  \\n" : "heard " + name);`,
                    "{{AttachmentPath}}",
                    callsPath,
                    emptyFirst ? "empty" : "text",
                  ],
                  capabilities: ["audio"],
                },
              ],
              audio: { attachments },
            },
          },
        };
        const ctx: MsgContext = {
          Body: "",
          media: [{}, { ...media[0], transcribed: true }, ...media.slice(1)],
        };
        const transcript = await transcribeFirstAudio({ ctx, cfg });
        expect(transcript).toBe(emptyFirst ? undefined : "heard first.wav");
        expect(ctx.media?.map((fact) => fact.transcribed === true)).toEqual([
          false,
          true,
          !emptyFirst,
          false,
        ]);
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
        ctx.RawBody = "typed caption";
        ctx.CommandBody = "typed caption";
        await applyMediaUnderstanding({
          ctx,
          cfg,
          workspaceDir: dir,
          processingMode: "audio-only",
        });

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
        expect(ctx).toMatchObject({
          RawBody: "typed caption",
          CommandBody: "typed caption",
          rawText: "typed caption",
          commandText: "typed caption",
        });
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
  it.each([
    {
      name: "default limit",
      emptyFirst: false,
      attachments: undefined,
      expected: ["first.wav"],
      markers: ["[Audio attachment not processed: attachment limit reached]"],
    },
    {
      name: "last preference",
      emptyFirst: false,
      attachments: { prefer: "last" as const },
      expected: ["second.wav"],
      markers: ["[Audio attachment not processed: attachment limit reached]"],
    },
    {
      name: "all attachments",
      emptyFirst: false,
      attachments: { mode: "all" as const, maxAttachments: 2 },
      expected: ["first.wav", "second.wav"],
      markers: [],
    },
    {
      name: "partial success",
      emptyFirst: true,
      attachments: { mode: "all" as const, maxAttachments: 2 },
      expected: ["first.wav", "second.wav"],
      markers: ["[Audio attachment could not be analyzed]"],
    },
    {
      name: "bounded dropped-attachment warnings",
      emptyFirst: false,
      attachments: undefined,
      attachmentCount: 8,
      expected: ["first.wav"],
      markers: [
        ...Array.from(
          { length: 5 },
          () => "[Audio attachment not processed: attachment limit reached]",
        ),
        "[2 more attachments skipped]",
      ],
    },
    {
      name: "audio-only capability scope",
      emptyFirst: false,
      attachments: { mode: "all" as const, maxAttachments: 2 },
      previousImageFailure: true,
      expected: ["first.wav", "second.wav"],
      markers: [],
    },
  ])(
    "preserves configured $name through internal preflight and later enrichment",
    async ({
      attachments,
      expected,
      emptyFirst,
      markers,
      attachmentCount,
      previousImageFailure,
    }) => {
      await withTestDir({ prefix: "openclaw-audio-selection-" }, async (dir) => {
        const calls: string[] = [];
        runExecMock.mockImplementation(async (_command, args: string[]) => {
          const attachmentPath = args[0];
          if (attachmentPath === undefined) {
            throw new Error("Expected the selected audio attachment path");
          }
          const name = path.basename(attachmentPath);
          calls.push(name);
          return {
            stdout: emptyFirst && name === "first.wav" ? "  \n" : "heard " + name,
            stderr: "",
          };
        });
        const media = await Promise.all(
          Array.from({ length: attachmentCount ?? 2 }, (_, index) =>
            index === 0 ? "first.wav" : index === 1 ? "second.wav" : `note-${index}.wav`,
          ).map(async (name) => {
            const filePath = path.join(dir, name);
            await fs.writeFile(filePath, createSafeAudioFixtureBuffer());
            return { path: filePath, contentType: "audio/wav", workspaceDir: dir };
          }),
        );
        const cfg: OpenClawConfig = {
          plugins: { enabled: false },
          tools: {
            media: {
              models: [
                {
                  type: "cli",
                  command: "fixture-transcriber",
                  args: ["{{AttachmentPath}}"],
                  capabilities: ["audio"],
                },
              ],
              audio: { attachments, echoTranscript: true },
            },
          },
        };
        const ctx: MsgContext = {
          Body: "typed caption",
          RawBody: "typed caption",
          CommandBody: "typed caption",
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
        expect(transcript).toBe(
          emptyFirst
            ? "heard second.wav"
            : expected.length === 1
              ? "heard " + expected[0]
              : "Audio 1:\nheard first.wav\n\nAudio 2:\nheard second.wav",
        );
        expect(ctx.media?.map((fact) => fact.transcribed === true)).toEqual([
          false,
          ...media.map(
            (fact) =>
              (!emptyFirst || path.basename(fact.path) !== "first.wav") &&
              expected.includes(path.basename(fact.path)),
          ),
        ]);
        expect(transcript).toBeDefined();
        const preparedText = formatAudioTranscriptForAgent(transcript ?? "");
        ctx.agentText = preparedText;
        ctx.BodyForAgent = preparedText;
        await applyMediaUnderstanding({
          ctx,
          cfg,
          workspaceDir: dir,
          processingMode: "audio-only",
        });
        expect(calls).toEqual(expected);
        const expectedAgentText = [preparedText, ...markers].join("\n\n");
        expect(ctx.agentText).toBe(expectedAgentText);
        expect(ctx.BodyForAgent).toBe(expectedAgentText);
        expect(ctx.RawBody).toBe("typed caption");
        expect(ctx.CommandBody).toBe("typed caption");
        expect(ctx.MediaUnderstanding).toBeUndefined();
      });
    },
  );
});
