import { describe, expect, it } from "vitest";
import { findLegacyConfigIssues } from "../../../config/legacy.js";
import { applyLegacyDoctorMigrations } from "./legacy-config-compat.js";

describe("per-agent legacy migrations after roster normalization", () => {
  it.each(["entries", "list"])("migrates only the active %s roster", (shape) => {
    const agent = {
      tools: { exec: { timeoutSec: 45 } },
      sandbox: { browser: { enableNoVnc: false } },
      tts: { enabled: true, providers: { custom: { voice: "operator-voice" } } },
      model: "vllm/qwen-test",
      params: { qwenThinkingFormat: "chat-template", temperature: 0.2 },
    };
    const raw: Record<string, unknown> = {
      agents: {
        ownership: "explicit",
        ...(shape === "entries"
          ? {
              entries: { worker: agent },
              list: [
                {
                  id: "old",
                  model: "vllm/discarded",
                  params: { qwenThinkingFormat: "chat-template" },
                },
              ],
            }
          : { list: [{ id: "worker", ...agent }] }),
      },
    };
    expect(findLegacyConfigIssues(raw)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: expect.stringContaining("Final layout aliases") }),
        expect.objectContaining({ message: expect.stringContaining("tts.enabled") }),
        expect.objectContaining({ message: expect.stringContaining("qwenThinkingFormat") }),
      ]),
    );

    const { next } = applyLegacyDoctorMigrations(raw, { sourceConfigBeforeMigrations: raw });

    expect(next).toMatchObject({
      agents: {
        ownership: "explicit",
        entries: {
          worker: {
            tools: { exec: { timeoutSeconds: 45 } },
            sandbox: { browser: { noVncEnabled: false } },
            tts: { auto: "always", providers: { custom: { speakerVoice: "operator-voice" } } },
            params: { temperature: 0.2 },
          },
        },
      },
      models: {
        providers: {
          vllm: { models: [{ id: "qwen-test", compat: { thinkingFormat: "qwen-chat-template" } }] },
        },
      },
    });
    expect(next).toHaveProperty("models.providers.vllm.models.length", 1);
    expect(next).not.toHaveProperty("agents.list");
    expect(next).not.toHaveProperty("agents.entries.worker.params.qwenThinkingFormat");
    expect(next).not.toHaveProperty("agents.entries.worker.tools.exec.timeoutSec");
    expect(next).not.toHaveProperty("agents.entries.worker.sandbox.browser.enableNoVnc");
    expect(next).not.toHaveProperty("agents.entries.worker.tts.enabled");
    expect(next).not.toHaveProperty("agents.entries.worker.tts.providers.custom.voice");
  });
});
