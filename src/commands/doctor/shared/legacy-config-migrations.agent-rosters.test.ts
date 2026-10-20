import { describe, expect, it } from "vitest";
import { findLegacyConfigIssues } from "../../../config/legacy.js";
import { applyLegacyDoctorMigrations } from "./legacy-config-compat.js";

const migrate = (raw: unknown) =>
  applyLegacyDoctorMigrations(raw, { sourceConfigBeforeMigrations: raw }).next;

describe("per-agent legacy migrations after roster normalization", () => {
  // Keep the migration sources independent: default params must not create the
  // model row that the inherited-agent case claims to exercise.
  it.each(["defaults", "inherited agent"])(
    "creates absent provider ancestors for Qwen params from %s",
    (source) => {
      const legacyParams = { qwenThinkingFormat: "chat-template" };
      const defaults = {
        model: "vllm/Qwen/selected@local",
        params: { temperature: 0.2, ...(source === "defaults" ? legacyParams : {}) },
      };
      const local = {
        id: "local",
        params: { temperature: 0.4, ...(source === "inherited agent" ? legacyParams : {}) },
      };
      const next = migrate({ agents: { defaults, list: [local] } });

      expect(next).toHaveProperty("models.providers.vllm", {
        models: [
          {
            id: "Qwen/selected",
            name: "Qwen/selected",
            reasoning: true,
            compat: { thinkingFormat: "qwen-chat-template" },
          },
        ],
      });
      expect(next).toHaveProperty("agents.defaults.params", { temperature: 0.2 });
      expect(next).toHaveProperty("agents.entries", { local: { params: { temperature: 0.4 } } });
      expect(next).not.toHaveProperty("agents.list");
    },
  );

  it.each(["entries", "list"])("migrates only the active %s roster", (shape) => {
    const agent = {
      tools: { exec: { timeoutSec: 45 } },
      sandbox: { browser: { enableNoVnc: false } },
      tts: { enabled: true, providers: { custom: { voice: "operator-voice" } } },
      model: "vllm/qwen-test",
      params: { qwenThinkingFormat: "chat-template", temperature: 0.2 },
    };
    const old = {
      id: "old",
      model: "vllm/discarded",
      params: { qwenThinkingFormat: "chat-template" },
    };
    const raw = {
      agents: {
        ownership: "explicit",
        ...(shape === "entries"
          ? { entries: { worker: agent }, list: [old] }
          : { list: [{ id: "worker", ...agent }] }),
      },
    };
    const issues = findLegacyConfigIssues(raw);
    for (const message of ["Final layout aliases", "tts.enabled", "qwenThinkingFormat"]) {
      expect(issues).toContainEqual(
        expect.objectContaining({ message: expect.stringContaining(message) }),
      );
    }

    const next = migrate(raw);

    const worker = {
      tools: { exec: { timeoutSeconds: 45 } },
      sandbox: { browser: { noVncEnabled: false } },
      tts: { auto: "always", providers: { custom: { speakerVoice: "operator-voice" } } },
      params: { temperature: 0.2 },
    };
    const vllm = {
      models: [{ id: "qwen-test", compat: { thinkingFormat: "qwen-chat-template" } }],
    };
    expect(next).toMatchObject({
      agents: { ownership: "explicit", entries: { worker } },
      models: { providers: { vllm } },
    });
    expect(next).toHaveProperty("models.providers.vllm.models.length", 1);
    expect(next).not.toHaveProperty("agents.list");
    for (const key of [
      "params.qwenThinkingFormat",
      "tools.exec.timeoutSec",
      "sandbox.browser.enableNoVnc",
      "tts.enabled",
      "tts.providers.custom.voice",
    ]) {
      expect(next).not.toHaveProperty(`agents.entries.worker.${key}`);
    }
  });
});
