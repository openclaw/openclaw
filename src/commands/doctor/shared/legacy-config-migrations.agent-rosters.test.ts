import { expect, it } from "vitest";
import { findLegacyConfigIssues } from "../../../config/legacy.js";
import { applyLegacyDoctorMigrations } from "./legacy-config-compat.js";

const migrate = (raw: unknown) =>
  applyLegacyDoctorMigrations(raw, { sourceConfigBeforeMigrations: raw }).next;
const params = (temperature: number, legacy = true) => ({
  temperature,
  ...(legacy ? { qwenThinkingFormat: "chat-template" } : {}),
});
const compat = { thinkingFormat: "qwen-chat-template" };

// Default params must not create the inherited-agent case's model row.
it.each([true, false])("creates Qwen provider ancestors (default params=%s)", (fromDefaults) => {
  const defaults = {
    model: "vllm/Qwen/selected@local",
    params: params(0.2, fromDefaults),
  };
  const local = {
    id: "local",
    params: params(0.4, !fromDefaults),
  };
  const next = migrate({ agents: { defaults, list: [local] } });

  expect(next).toHaveProperty("models.providers.vllm", {
    models: [{ id: "Qwen/selected", name: "Qwen/selected", reasoning: true, compat }],
  });
  expect(next).toHaveProperty("agents.defaults.params", { temperature: 0.2 });
  expect(next).toHaveProperty("agents.entries", { local: { params: { temperature: 0.4 } } });
  expect(next).not.toHaveProperty("agents.list");
});

it.each(["entries", "list"])("migrates only the active %s roster", (shape) => {
  const agent = {
    tools: { exec: { timeoutSec: 45 } },
    sandbox: { browser: { enableNoVnc: false } },
    tts: { enabled: true, providers: { custom: { voice: "operator-voice" } } },
    model: "vllm/qwen-test",
    params: params(0.2),
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
  const vllm = { models: [{ id: "qwen-test", compat }] };
  expect(next).toMatchObject({
    agents: { ownership: "explicit" },
    models: { providers: { vllm } },
  });
  expect(next).toHaveProperty("agents.entries.worker", { model: "vllm/qwen-test", ...worker });
  expect(next).toHaveProperty("models.providers.vllm.models.length", 1);
  expect(next).not.toHaveProperty("agents.list");
});
