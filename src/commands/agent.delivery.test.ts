import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CliDeps } from "../cli/deps.js";
import type { OpenClawConfig } from "../config/config.js";
import type { SessionEntry } from "../config/sessions.js";
import type { RuntimeEnv } from "../runtime.js";

const mocks = vi.hoisted(() => ({
  deliverOutboundPayloads: vi.fn(async () => []),
  getChannelPlugin: vi.fn(() => ({})),
  resolveOutboundTarget: vi.fn(() => ({ ok: true as const, to: "+15551234567" })),
  emitAgentEvent: vi.fn(),
}));

vi.mock("../channels/plugins/index.js", () => ({
  getChannelPlugin: mocks.getChannelPlugin,
  normalizeChannelId: (value: string) => value,
}));

vi.mock("../infra/outbound/deliver.js", () => ({
  deliverOutboundPayloads: mocks.deliverOutboundPayloads,
}));

vi.mock("../infra/outbound/targets.js", async () => {
  const actual = await vi.importActual<typeof import("../infra/outbound/targets.js")>(
    "../infra/outbound/targets.js",
  );
  return {
    ...actual,
    resolveOutboundTarget: mocks.resolveOutboundTarget,
  };
});

vi.mock("../infra/agent-events.js", () => ({
  emitAgentEvent: mocks.emitAgentEvent,
}));

describe("deliverAgentCommandResult", () => {
  beforeEach(() => {
    mocks.deliverOutboundPayloads.mockClear();
    mocks.resolveOutboundTarget.mockClear();
    mocks.emitAgentEvent.mockClear();
  });

  it("prefers explicit accountId for outbound delivery", async () => {
    const cfg = {} as OpenClawConfig;
    const deps = {} as CliDeps;
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
    } as unknown as RuntimeEnv;
    const sessionEntry = {
      lastAccountId: "default",
    } as SessionEntry;
    const result = {
      payloads: [{ text: "hi" }],
      meta: {},
    };

    const { deliverAgentCommandResult } = await import("./agent/delivery.js");
    await deliverAgentCommandResult({
      cfg,
      deps,
      runtime,
      opts: {
        message: "hello",
        deliver: true,
        channel: "whatsapp",
        accountId: "kev",
        to: "+15551234567",
      },
      sessionEntry,
      result,
      payloads: result.payloads,
    });

    expect(mocks.deliverOutboundPayloads).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: "kev" }),
    );
  });

  it("falls back to session accountId for implicit delivery", async () => {
    const cfg = {} as OpenClawConfig;
    const deps = {} as CliDeps;
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
    } as unknown as RuntimeEnv;
    const sessionEntry = {
      lastAccountId: "legacy",
      lastChannel: "whatsapp",
    } as SessionEntry;
    const result = {
      payloads: [{ text: "hi" }],
      meta: {},
    };

    const { deliverAgentCommandResult } = await import("./agent/delivery.js");
    await deliverAgentCommandResult({
      cfg,
      deps,
      runtime,
      opts: {
        message: "hello",
        deliver: true,
        channel: "whatsapp",
      },
      sessionEntry,
      result,
      payloads: result.payloads,
    });

    expect(mocks.deliverOutboundPayloads).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: "legacy" }),
    );
  });

  it("does not infer accountId for explicit delivery targets", async () => {
    const cfg = {} as OpenClawConfig;
    const deps = {} as CliDeps;
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
    } as unknown as RuntimeEnv;
    const sessionEntry = {
      lastAccountId: "legacy",
    } as SessionEntry;
    const result = {
      payloads: [{ text: "hi" }],
      meta: {},
    };

    const { deliverAgentCommandResult } = await import("./agent/delivery.js");
    await deliverAgentCommandResult({
      cfg,
      deps,
      runtime,
      opts: {
        message: "hello",
        deliver: true,
        channel: "whatsapp",
        to: "+15551234567",
        deliveryTargetMode: "explicit",
      },
      sessionEntry,
      result,
      payloads: result.payloads,
    });

    expect(mocks.resolveOutboundTarget).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: undefined, mode: "explicit" }),
    );
    expect(mocks.deliverOutboundPayloads).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: undefined }),
    );
  });

  it("skips session accountId when channel differs", async () => {
    const cfg = {} as OpenClawConfig;
    const deps = {} as CliDeps;
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
    } as unknown as RuntimeEnv;
    const sessionEntry = {
      lastAccountId: "legacy",
      lastChannel: "telegram",
    } as SessionEntry;
    const result = {
      payloads: [{ text: "hi" }],
      meta: {},
    };

    const { deliverAgentCommandResult } = await import("./agent/delivery.js");
    await deliverAgentCommandResult({
      cfg,
      deps,
      runtime,
      opts: {
        message: "hello",
        deliver: true,
        channel: "whatsapp",
      },
      sessionEntry,
      result,
      payloads: result.payloads,
    });

    expect(mocks.resolveOutboundTarget).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: undefined, channel: "whatsapp" }),
    );
  });

  it("uses session last channel when none is provided", async () => {
    const cfg = {} as OpenClawConfig;
    const deps = {} as CliDeps;
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
    } as unknown as RuntimeEnv;
    const sessionEntry = {
      lastChannel: "telegram",
      lastTo: "123",
    } as SessionEntry;
    const result = {
      payloads: [{ text: "hi" }],
      meta: {},
    };

    const { deliverAgentCommandResult } = await import("./agent/delivery.js");
    await deliverAgentCommandResult({
      cfg,
      deps,
      runtime,
      opts: {
        message: "hello",
        deliver: true,
      },
      sessionEntry,
      result,
      payloads: result.payloads,
    });

    expect(mocks.resolveOutboundTarget).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "telegram", to: "123" }),
    );
  });

  it("uses reply overrides for delivery routing", async () => {
    const cfg = {} as OpenClawConfig;
    const deps = {} as CliDeps;
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
    } as unknown as RuntimeEnv;
    const sessionEntry = {
      lastChannel: "telegram",
      lastTo: "123",
      lastAccountId: "legacy",
    } as SessionEntry;
    const result = {
      payloads: [{ text: "hi" }],
      meta: {},
    };

    const { deliverAgentCommandResult } = await import("./agent/delivery.js");
    await deliverAgentCommandResult({
      cfg,
      deps,
      runtime,
      opts: {
        message: "hello",
        deliver: true,
        to: "+15551234567",
        replyTo: "#reports",
        replyChannel: "slack",
        replyAccountId: "ops",
      },
      sessionEntry,
      result,
      payloads: result.payloads,
    });

    expect(mocks.resolveOutboundTarget).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "slack", to: "#reports", accountId: "ops" }),
    );
  });

  it("prefixes nested agent outputs with context", async () => {
    const cfg = {} as OpenClawConfig;
    const deps = {} as CliDeps;
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
    } as unknown as RuntimeEnv;
    const result = {
      payloads: [{ text: "ANNOUNCE_SKIP" }],
      meta: {},
    };

    const { deliverAgentCommandResult } = await import("./agent/delivery.js");
    await deliverAgentCommandResult({
      cfg,
      deps,
      runtime,
      opts: {
        message: "hello",
        deliver: false,
        lane: "nested",
        sessionKey: "agent:main:main",
        runId: "run-announce",
        messageChannel: "webchat",
      },
      sessionEntry: undefined,
      result,
      payloads: result.payloads,
    });

    expect(runtime.log).toHaveBeenCalledTimes(1);
    const line = String(runtime.log.mock.calls[0]?.[0]);
    expect(line).toContain("[agent:nested]");
    expect(line).toContain("session=agent:main:main");
    expect(line).toContain("run=run-announce");
    expect(line).toContain("channel=webchat");
    expect(line).toContain("ANNOUNCE_SKIP");
  });

  it("emits agent events for nested lane with webchat channel", async () => {
    const cfg = {} as OpenClawConfig;
    const deps = {} as CliDeps;
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
    } as unknown as RuntimeEnv;
    const result = {
      payloads: [{ text: "Hello from CLI agent" }],
      meta: {},
    };

    const { deliverAgentCommandResult } = await import("./agent/delivery.js");
    await deliverAgentCommandResult({
      cfg,
      deps,
      runtime,
      opts: {
        message: "hello",
        deliver: false,
        lane: "nested",
        sessionKey: "agent:pmax:main",
        runId: "cli-run-123",
        channel: "webchat",
      },
      sessionEntry: undefined,
      result,
      payloads: result.payloads,
    });

    // Should emit agent event for webchat broadcast
    expect(mocks.emitAgentEvent).toHaveBeenCalledTimes(1);
    expect(mocks.emitAgentEvent).toHaveBeenCalledWith({
      runId: "cli-run-123",
      stream: "assistant",
      sessionKey: "agent:pmax:main",
      data: { text: "Hello from CLI agent" },
    });
  });

  it("does not emit agent events for nested lane with non-webchat channel", async () => {
    const cfg = {} as OpenClawConfig;
    const deps = {} as CliDeps;
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
    } as unknown as RuntimeEnv;
    const result = {
      payloads: [{ text: "Hello" }],
      meta: {},
    };

    const { deliverAgentCommandResult } = await import("./agent/delivery.js");
    await deliverAgentCommandResult({
      cfg,
      deps,
      runtime,
      opts: {
        message: "hello",
        deliver: false,
        lane: "nested",
        sessionKey: "agent:main:main",
        runId: "run-123",
        channel: "telegram",
      },
      sessionEntry: undefined,
      result,
      payloads: result.payloads,
    });

    // Should NOT emit agent event for non-webchat channels
    expect(mocks.emitAgentEvent).not.toHaveBeenCalled();
  });

  it("does not emit agent events without runId or sessionKey", async () => {
    const cfg = {} as OpenClawConfig;
    const deps = {} as CliDeps;
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
    } as unknown as RuntimeEnv;
    const result = {
      payloads: [{ text: "Hello" }],
      meta: {},
    };

    const { deliverAgentCommandResult } = await import("./agent/delivery.js");
    await deliverAgentCommandResult({
      cfg,
      deps,
      runtime,
      opts: {
        message: "hello",
        deliver: false,
        lane: "nested",
        channel: "webchat",
        // No runId or sessionKey
      },
      sessionEntry: undefined,
      result,
      payloads: result.payloads,
    });

    // Should NOT emit agent event without required identifiers
    expect(mocks.emitAgentEvent).not.toHaveBeenCalled();
  });

  it("combines multiple payload texts for webchat broadcast", async () => {
    const cfg = {} as OpenClawConfig;
    const deps = {} as CliDeps;
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
    } as unknown as RuntimeEnv;
    const result = {
      payloads: [{ text: "Line 1" }, { text: "Line 2" }, { text: "Line 3" }],
      meta: {},
    };

    const { deliverAgentCommandResult } = await import("./agent/delivery.js");
    await deliverAgentCommandResult({
      cfg,
      deps,
      runtime,
      opts: {
        message: "hello",
        deliver: false,
        lane: "nested",
        sessionKey: "agent:pmax:main",
        runId: "multi-payload-run",
        channel: "webchat",
      },
      sessionEntry: undefined,
      result,
      payloads: result.payloads,
    });

    expect(mocks.emitAgentEvent).toHaveBeenCalledTimes(1);
    expect(mocks.emitAgentEvent).toHaveBeenCalledWith({
      runId: "multi-payload-run",
      stream: "assistant",
      sessionKey: "agent:pmax:main",
      data: { text: "Line 1\nLine 2\nLine 3" },
    });
  });
});
