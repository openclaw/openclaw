import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { FailoverError } from "../../agents/failover-error.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import { readGroupParticipationEvidence } from "./group-participation-context.js";
import {
  readGroupParticipationInputs,
  recordGroupParticipationInput,
} from "./group-participation-inputs.js";
import { judgment } from "./group-participation.decision.test-support.js";
import { createGroupReplyFixture } from "./group-participation.reply.test-support.js";
import { replyRunRegistry } from "./reply-run-registry.js";

const models = vi.hoisted(() => ({
  embedded: vi.fn<typeof import("../../agents/embedded-agent.js").runEmbeddedAgent>(),
  cli: vi.fn<typeof import("../../agents/cli-runner.js").runCliAgent>(),
  decision: vi.fn<typeof import("../../decisions/runtime.js").evaluateDecision>(),
}));
vi.mock("../../agents/embedded-agent.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/embedded-agent.js")>()),
  runEmbeddedAgent: models.embedded,
}));
vi.mock("../../agents/cli-runner.js", () => ({ runCliAgent: models.cli }));
vi.mock("../../decisions/runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../decisions/runtime.js")>()),
  evaluateDecision: models.decision,
}));

let fixture: Awaited<ReturnType<typeof createGroupReplyFixture>>;
beforeAll(async () => {
  fixture = await createGroupReplyFixture();
});
afterAll(async () => {
  await fixture.close();
});
beforeEach(() => {
  models.embedded.mockReset();
  models.cli.mockReset();
  models.decision.mockReset();
  fixture.config.agents!.defaults!.experimental = { decisionAssistance: true };
  const registry = createTestRegistry();
  registry.cliBackends.push({
    pluginId: "synthetic-cli",
    source: "test",
    backend: { id: "fixture-cli", config: { command: "synthetic-cli" }, bundleMcp: false },
  });
  setActivePluginRegistry(registry);
});

it.each([undefined, false])(
  "keeps ordinary replies when Decision assistance is %s despite a selected model",
  async (decisionAssistance) => {
    fixture.config.agents!.defaults!.experimental = { decisionAssistance };
    fixture.config.agents!.defaults!.model = { primary: "test-provider/test-model" };
    models.decision.mockImplementation(async (batch) => judgment(batch, { attention: "none" }));
    models.embedded.mockResolvedValue({
      payloads: [{ text: "Ordinary reply with assistance off." }],
      meta: { durationMs: 1 },
    });
    const reply = await fixture.reply(
      "Bob, do you know the port?",
      "assistance-off-source",
      decisionAssistance === false ? "-10104" : "-10105",
    );
    expect(Array.isArray(reply) ? reply : [reply]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ text: "Ordinary reply with assistance off." }),
      ]),
    );
    expect(models.decision).not.toHaveBeenCalled();
    expect(models.embedded).toHaveBeenCalledTimes(1);
    expect(models.cli).not.toHaveBeenCalled();
  },
);

it.each(["opt-out", "model-removal"])(
  "discards an awaited participation decision after %s takes effect",
  async (change) => {
    fixture.config.agents!.defaults!.model = { primary: "test-provider/test-model" };
    setRuntimeConfigSnapshot(fixture.config);
    models.decision.mockImplementation(async (batch, options) => {
      expect(options.admit?.()).toBe(true);
      const next = structuredClone(fixture.config);
      if (change === "opt-out") {
        next.agents!.defaults!.experimental = { decisionAssistance: false };
      } else {
        next.agents!.defaults!.decisionModel = "";
      }
      setRuntimeConfigSnapshot(next, fixture.config);
      expect(options.admit?.()).toBe(false);
      return judgment(batch, { attention: "none" });
    });
    models.embedded.mockResolvedValue({
      payloads: [{ text: "Ordinary reply after config refresh." }],
      meta: { durationMs: 1 },
    });
    try {
      const reply = await fixture.reply(
        "Bob, do you know the port?",
        "config-refresh-source",
        change === "opt-out" ? "-10106" : "-10107",
      );
      expect(Array.isArray(reply) ? reply : [reply]).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ text: "Ordinary reply after config refresh." }),
        ]),
      );
      expect(models.decision).toHaveBeenCalledTimes(1);
      expect(models.embedded).toHaveBeenCalledTimes(1);
    } finally {
      setRuntimeConfigSnapshot(fixture.config);
    }
  },
);

it.each(["opt-out", "model-removal"])(
  "requires a fresh judgment after %s is reversed while a decision is pending",
  async (change) => {
    fixture.config.agents!.defaults!.model = { primary: "test-provider/test-model" };
    setRuntimeConfigSnapshot(fixture.config);
    models.decision.mockImplementationOnce(async (batch) => {
      const next = structuredClone(fixture.config);
      if (change === "opt-out") {
        next.agents!.defaults!.experimental = { decisionAssistance: false };
      } else {
        next.agents!.defaults!.decisionModel = "";
      }
      setRuntimeConfigSnapshot(next, fixture.config);
      setRuntimeConfigSnapshot(fixture.config);
      return judgment(batch, { attention: "none" });
    });
    models.decision.mockImplementation(async (batch) =>
      judgment(batch, { attention: "engagement" }),
    );
    models.embedded.mockResolvedValue({
      payloads: [{ text: "Reply from the fresh invitation judgment." }],
      meta: { durationMs: 1 },
    });
    try {
      const reply = await fixture.reply(
        "Can you explain the port?",
        "config-reversal-source",
        change === "opt-out" ? "-10108" : "-10109",
      );
      expect(Array.isArray(reply) ? reply : [reply]).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ text: "Reply from the fresh invitation judgment." }),
        ]),
      );
      expect(models.decision).toHaveBeenCalledTimes(2);
      expect(models.embedded).toHaveBeenCalledTimes(1);
    } finally {
      setRuntimeConfigSnapshot(fixture.config);
    }
  },
);

it.each(["none", "engagement", "opportunity"] as const)(
  "restores a required reply when consent is withdrawn after %s assessment",
  async (attention) => {
    fixture.config.agents!.defaults!.model = { primary: "test-provider/test-model" };
    setRuntimeConfigSnapshot(fixture.config);
    models.decision.mockImplementation(async (batch) => judgment(batch, { attention }));
    models.embedded.mockResolvedValue({
      payloads: [{ text: "Ordinary reply after late opt-out." }],
      meta: { durationMs: 1 },
    });
    try {
      const reply = await fixture.reply(
        "Bob, which port?",
        `late-opt-out-${attention}`,
        `-10112-${attention}`,
        {
          onRunVerbosityResolved: () => {
            const next = structuredClone(fixture.config);
            next.agents!.defaults!.experimental = { decisionAssistance: false };
            setRuntimeConfigSnapshot(next, fixture.config);
          },
        },
      );
      expect(Array.isArray(reply) ? reply : [reply]).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ text: "Ordinary reply after late opt-out." }),
        ]),
      );
      expect(models.decision).toHaveBeenCalledTimes(1);
      expect(models.embedded).toHaveBeenCalledTimes(1);
      expect(models.embedded.mock.calls[0]?.[0].terminalReplyExpectation).toBe("required");
    } finally {
      setRuntimeConfigSnapshot(fixture.config);
    }
  },
);

it.each(["none", "engagement", "opportunity"] as const)(
  "reassesses %s when accepted group input changes before execution",
  async (attention) => {
    fixture.config.agents!.defaults!.model = { primary: "test-provider/test-model" };
    models.decision.mockImplementationOnce(async (batch) => judgment(batch, { attention }));
    models.decision.mockImplementation(async (batch) => judgment(batch, { attention: "none" }));
    models.embedded.mockResolvedValue({
      payloads: [{ text: "Must not bypass assessment." }],
      meta: { durationMs: 1 },
    });
    const groupId = `-10113-${attention}`;
    const reply = await fixture.reply("Chatter", "observed-source", groupId, {
      onRunVerbosityResolved: () => {
        const operation = replyRunRegistry.get("agent:main:telegram:group:" + groupId);
        if (!operation) {
          throw new Error("The admitted reply owner is missing");
        }
        const source = readGroupParticipationInputs(operation).sources[0];
        if (!source) {
          throw new Error("The admitted group source is missing");
        }
        // Use the accepted-input owner seam before persistence, without another concurrent reply writer.
        recordGroupParticipationInput(operation, {
          userTurnTranscriptRecorder: source.recorder,
          messageId: "accepted-later-source",
          run: { messageProvider: "telegram" },
        });
      },
    });
    expect((Array.isArray(reply) ? reply : [reply]).map((payload) => payload?.text)).toEqual([
      "NO_REPLY",
    ]);
    expect(models.decision).toHaveBeenCalledTimes(2);
    expect(models.embedded).not.toHaveBeenCalled();
  },
);

it("keeps ambient room events on their message-tool path without participation evaluation", async () => {
  fixture.config.agents!.defaults!.model = { primary: "test-provider/test-model" };
  models.decision.mockImplementation(async (batch) =>
    judgment(batch, { attention: "opportunity" }),
  );
  models.embedded.mockResolvedValue({ payloads: [], meta: { durationMs: 1 } });
  await fixture.reply(
    "Alice joined the group.",
    "room-event-source",
    "-10111",
    undefined,
    false,
    undefined,
    "room_event",
  );
  expect(models.decision).not.toHaveBeenCalled();
  expect(models.embedded).toHaveBeenCalledTimes(1);
  const params = models.embedded.mock.calls[0]?.[0];
  expect(params).toMatchObject({
    sourceReplyDeliveryMode: "message_tool_only",
    terminalReplyExpectation: "optional",
  });
  expect(params?.disableMessageTool).not.toBe(true);
  expect(params?.permissionMode).not.toBe("read-only");
});

it("keeps explicit native group commands on the ordinary reply path", async () => {
  fixture.config.agents!.defaults!.model = { primary: "test-provider/test-model" };
  models.decision.mockImplementation(async (batch) => judgment(batch, { attention: "none" }));
  models.embedded.mockResolvedValue({
    payloads: [{ text: "The requested summary." }],
    meta: { durationMs: 1 },
  });
  const reply = await fixture.reply(
    "Summarize the deployment port.",
    "native-command-source",
    "-10110",
    undefined,
    false,
    "native",
  );
  expect(Array.isArray(reply) ? reply : [reply]).toEqual(
    expect.arrayContaining([expect.objectContaining({ text: "The requested summary." })]),
  );
  expect(models.decision).not.toHaveBeenCalled();
  expect(models.embedded).toHaveBeenCalledTimes(1);
});

it("keeps a selected generic CLI turn ordinary without a participation decision", async () => {
  fixture.config.agents!.defaults!.model = { primary: "fixture-cli/test-model" };
  models.cli.mockResolvedValue({
    payloads: [{ text: "Ordinary CLI reply." }],
    meta: { durationMs: 1 },
  });
  const reply = await fixture.reply("Bob, do you know the port?", "cli-source", "-10101");
  expect(reply).toMatchObject({ text: "Ordinary CLI reply." });
  expect(models.decision).not.toHaveBeenCalled();
  expect(models.embedded).not.toHaveBeenCalled();
  expect(models.cli).toHaveBeenCalledTimes(1);
  expect(models.cli.mock.calls[0]?.[0]).toMatchObject({ terminalReplyExpectation: "required" });
});

it("preserves ordinary policy when an admitted embedded reply falls back to CLI", async () => {
  fixture.config.agents!.defaults!.model = {
    primary: "test-provider/test-model",
    fallbacks: ["fixture-cli/test-model"],
  };
  models.decision.mockImplementation(async (batch) =>
    judgment(batch, { attention: "opportunity" }),
  );
  models.embedded.mockRejectedValue(
    new FailoverError("Synthetic provider outage", {
      reason: "rate_limit",
      provider: "test-provider",
      model: "test-model",
    }),
  );
  models.cli.mockResolvedValue({
    payloads: [{ text: "Ordinary fallback reply." }],
    meta: { durationMs: 1 },
  });
  const reply = await fixture.reply("Bob, do you know the port?", "cli-fallback-source", "-10102");
  expect(reply).toMatchObject({ text: "Ordinary fallback reply." });
  expect(models.embedded).toHaveBeenCalledTimes(1);
  expect(models.embedded.mock.calls[0]?.[0]).toMatchObject({
    terminalReplyExpectation: "required",
  });
  expect(models.embedded.mock.calls[0]?.[0].permissionMode).not.toBe("read-only");
  expect(models.cli).toHaveBeenCalledTimes(1);
  expect(models.cli.mock.calls[0]?.[0]).toMatchObject({
    terminalReplyExpectation: "required",
    sourceReplyDeliveryMode: "automatic",
  });
});

it("keeps ordinary behavior when the initial Decision Model is unavailable", async () => {
  fixture.config.agents!.defaults!.model = { primary: "test-provider/test-model" };
  models.decision.mockResolvedValue({ status: "unavailable", reason: "overloaded" });
  models.embedded.mockResolvedValue({
    payloads: [{ text: "Ordinary embedded reply." }],
    meta: { durationMs: 1 },
  });
  const reply = await fixture.reply(
    "Bob, do you know the port?",
    "initial-outage-source",
    "-10103",
  );
  expect(Array.isArray(reply) ? reply : [reply]).toEqual(
    expect.arrayContaining([expect.objectContaining({ text: "Ordinary embedded reply." })]),
  );
  expect(models.embedded).toHaveBeenCalledTimes(1);
  expect(models.embedded.mock.calls[0]?.[0]).toMatchObject({
    terminalReplyExpectation: "required",
  });
  expect(models.embedded.mock.calls[0]?.[0].permissionMode).not.toBe("read-only");
  expect(models.cli).not.toHaveBeenCalled();
});

it("does not classify a textless source as a negative attention judgment", async () => {
  const recorder = createUserTurnTranscriptRecorder({ input: {}, target: () => undefined });
  vi.spyOn(recorder, "resolveMessage").mockResolvedValue({
    role: "user",
    content: [{ type: "image", data: "image-data", mimeType: "image/png" }],
    timestamp: 1,
  });
  expect(
    await readGroupParticipationEvidence({
      agentId: "main",
      target: {
        agentId: "main",
        sessionId: "media-only",
        sessionKey: "agent:main:telegram:group:-10115",
        storePath: fixture.storePath,
      },
      recorder,
      signal: new AbortController().signal,
      timeoutMs: 30_000,
    }),
  ).toBeUndefined();
});

it("uses ordinary generation when newly adopted media cannot be assessed", async () => {
  fixture.config.agents!.defaults!.model = { primary: "test-provider/test-model" };
  models.decision.mockImplementation(async (batch) => judgment(batch, { attention: "none" }));
  models.embedded.mockResolvedValue({
    payloads: [{ text: "Ordinary media reply." }],
    meta: { durationMs: 1 },
  });
  const groupId = "-10114";
  const recorder = createUserTurnTranscriptRecorder({ input: {}, target: () => undefined });
  vi.spyOn(recorder, "resolveMessage").mockResolvedValue({
    role: "user",
    content: [{ type: "image", data: "image-data", mimeType: "image/png" }],
    timestamp: 1,
  });
  const reply = await fixture.reply("Chatter", "before-media", groupId, {
    onRunVerbosityResolved: () => {
      const operation = replyRunRegistry.get("agent:main:telegram:group:" + groupId);
      if (!operation) {
        throw new Error("The admitted reply owner is missing");
      }
      recordGroupParticipationInput(
        operation,
        {
          userTurnTranscriptRecorder: recorder,
          messageId: "adopted-media",
          groupParticipation: {},
          run: { messageProvider: "telegram" },
        },
        "steer",
      );
    },
  });
  expect(Array.isArray(reply) ? reply : [reply]).toEqual(
    expect.arrayContaining([expect.objectContaining({ text: "Ordinary media reply." })]),
  );
  expect(models.decision).toHaveBeenCalledTimes(1);
  expect(models.embedded).toHaveBeenCalledTimes(1);
  expect(models.embedded.mock.calls[0]?.[0].terminalReplyExpectation).toBe("required");
});

it("restores an ordinary required reply for an adopted participation-bypass source", async () => {
  fixture.config.agents!.defaults!.model = { primary: "test-provider/test-model" };
  const groupId = "-10116";
  models.decision.mockImplementation(async (batch) => {
    const operation = replyRunRegistry.get("agent:main:telegram:group:" + groupId);
    if (!operation) {
      throw new Error("The reply owner is missing");
    }
    const source = readGroupParticipationInputs(operation).sources[0];
    if (!source) {
      throw new Error("The source is missing");
    }
    recordGroupParticipationInput(
      operation,
      {
        userTurnTranscriptRecorder: source.recorder,
        messageId: "mentioned-followup",
        run: { messageProvider: "telegram" },
      },
      "steer",
    );
    return judgment(batch, { attention: "none" });
  });
  models.embedded.mockResolvedValue({
    payloads: [{ text: "Required followup reply." }],
    meta: { durationMs: 1 },
  });
  const reply = await fixture.reply("Chatter", "before-mention", groupId);
  expect(Array.isArray(reply) ? reply : [reply]).toEqual(
    expect.arrayContaining([expect.objectContaining({ text: "Required followup reply." })]),
  );
  expect(models.decision).toHaveBeenCalledTimes(1);
  expect(models.embedded).toHaveBeenCalledTimes(1);
  expect(models.embedded.mock.calls[0]?.[0].terminalReplyExpectation).toBe("required");
});

it.each(["deadline", "cancel"] as const)(
  "bounds pending evidence acquisition on %s",
  async (kind) => {
    const recorder = createUserTurnTranscriptRecorder({ input: {}, target: () => undefined });
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(recorder, "resolveMessage").mockImplementation(async () => {
      await blocked;
      return undefined;
    });
    const controller = new AbortController();
    vi.useFakeTimers();
    try {
      const pending = readGroupParticipationEvidence({
        agentId: "main",
        target: {
          agentId: "main",
          sessionId: "blocked-source",
          sessionKey: "agent:main:telegram:group:-10117",
          storePath: fixture.storePath,
        },
        recorder,
        signal: controller.signal,
        timeoutMs: 30_000,
      });
      if (kind === "cancel") {
        const failure = new Error("Turn cancelled");
        const assertion = expect(pending).rejects.toBe(failure);
        controller.abort(failure);
        await assertion;
      } else {
        await vi.advanceTimersByTimeAsync(30_000);
        expect(await pending).toBeUndefined();
        expect(controller.signal.aborted).toBe(false);
      }
    } finally {
      release();
      await blocked;
      vi.useRealTimers();
    }
  },
);
