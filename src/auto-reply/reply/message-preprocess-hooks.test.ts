import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import {
  clearInternalHooks,
  registerInternalEnrichHook,
  registerInternalHook,
} from "../../hooks/internal-hooks.js";
import type { FinalizedMsgContext } from "../templating.js";
import { emitPreAgentMessageHooks } from "./message-preprocess-hooks.js";
import { stripInboundMetadata } from "./strip-inbound-meta.js";
import { appendUntrustedContext } from "./untrusted-context.js";

function makeCtx(overrides: Partial<FinalizedMsgContext> = {}): FinalizedMsgContext {
  return {
    SessionKey: "agent:main:telegram:chat-1",
    From: "telegram:user:1",
    To: "telegram:chat-1",
    Body: "<media:audio>",
    BodyForAgent: "[Audio] Transcript: hello",
    BodyForCommands: "<media:audio>",
    Transcript: "hello",
    Provider: "telegram",
    Surface: "telegram",
    OriginatingChannel: "telegram",
    OriginatingTo: "telegram:chat-1",
    Timestamp: 1710000000,
    MessageSid: "msg-1",
    GroupChannel: "ops",
    ...overrides,
  } as FinalizedMsgContext;
}

describe("emitPreAgentMessageHooks", () => {
  beforeEach(() => {
    clearInternalHooks();
  });

  it("emits transcribed and preprocessed events when transcript exists", async () => {
    const actions: string[] = [];
    registerInternalHook("message", (event) => {
      actions.push(event.action);
    });

    await emitPreAgentMessageHooks({
      ctx: makeCtx(),
      cfg: {} as OpenClawConfig,
      isFastTestEnv: false,
    });

    expect(actions).toEqual(["transcribed", "preprocessed"]);
  });

  it("emits only preprocessed when transcript is missing", async () => {
    const actions: string[] = [];
    registerInternalHook("message", (event) => {
      actions.push(event.action);
    });

    await emitPreAgentMessageHooks({
      ctx: makeCtx({ Transcript: undefined }),
      cfg: {} as OpenClawConfig,
      isFastTestEnv: false,
    });

    expect(actions).toEqual(["preprocessed"]);
  });

  it("skips hook emission in fast-test mode", async () => {
    const handler = vi.fn();
    registerInternalHook("message", handler);

    await emitPreAgentMessageHooks({
      ctx: makeCtx(),
      cfg: {} as OpenClawConfig,
      isFastTestEnv: true,
    });

    expect(handler).not.toHaveBeenCalled();
  });

  it("skips hook emission without session key", async () => {
    const handler = vi.fn();
    registerInternalHook("message", handler);

    await emitPreAgentMessageHooks({
      ctx: makeCtx({ SessionKey: " " }),
      cfg: {} as OpenClawConfig,
      isFastTestEnv: false,
    });

    expect(handler).not.toHaveBeenCalled();
  });

  it("awaits enrich hooks and appends merged metadata to untrusted context", async () => {
    registerInternalEnrichHook("message", async () => ({
      metadata: {
        source: "vehicle-state",
      },
    }));
    registerInternalEnrichHook("message:enrich", async (event) => ({
      metadata: {
        driving: true,
        body_preview: event.context.bodyForAgent,
      },
    }));

    const ctx = makeCtx();
    await emitPreAgentMessageHooks({
      ctx,
      cfg: {} as OpenClawConfig,
      isFastTestEnv: false,
    });

    expect(ctx.UntrustedContext).toHaveLength(1);
    expect(ctx.UntrustedContext?.[0]).toMatch(/<<<EXTERNAL_UNTRUSTED_CONTENT id="[a-f0-9]{16}">>>/);
    expect(ctx.UntrustedContext?.[0]).toContain("Source: Hook metadata");
    expect(ctx.UntrustedContext?.[0]).toContain("Enriched context (hook-injected metadata):");
    expect(ctx.UntrustedContext?.[0]).toContain('"driving": true');
    expect(ctx.UntrustedContext?.[0]).toContain('"source": "vehicle-state"');
    expect(ctx.UntrustedContext?.[0]).toContain('"body_preview": "[Audio] Transcript: hello"');

    const storedMessage = appendUntrustedContext("User-visible body", ctx.UntrustedContext);
    expect(stripInboundMetadata(storedMessage)).toBe("User-visible body");
  });

  it("does not append untrusted context when enrich hooks return nothing", async () => {
    registerInternalEnrichHook("message:enrich", async () => undefined);

    const ctx = makeCtx();
    await emitPreAgentMessageHooks({
      ctx,
      cfg: {} as OpenClawConfig,
      isFastTestEnv: false,
    });

    expect(ctx.UntrustedContext).toBeUndefined();
  });

  it("continues when an enrich hook throws", async () => {
    registerInternalEnrichHook("message:enrich", async () => {
      throw new Error("boom");
    });

    await expect(
      emitPreAgentMessageHooks({
        ctx: makeCtx(),
        cfg: {} as OpenClawConfig,
        isFastTestEnv: false,
      }),
    ).resolves.not.toThrow();
  });
});
