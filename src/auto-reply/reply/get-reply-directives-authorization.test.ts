import { describe, expect, it } from "vitest";
import { parseInlineDirectives } from "./directive-handling.parse.js";
import { resolveDirectiveAuthorizationRequests } from "./get-reply-directives-authorization.js";

describe("reply directive authorization requests", () => {
  it("keeps each directive's arguments separate", () => {
    const directives = parseInlineDirectives(
      "/model openai/gpt-5.5@work --runtime codex /think low",
    );

    expect(
      resolveDirectiveAuthorizationRequests(directives, {
        modelEffect: {
          kind: "selection",
          modelSelection: {
            provider: "openai",
            model: "gpt-5.5",
            isDefault: false,
          },
          profileOverride: "work",
          runtimeResolution: { kind: "set", runtime: "codex" },
          runtime: "codex",
        },
      }),
    ).toEqual([
      {
        commandName: "think",
        rawArguments: "low",
        values: { level: "low" },
      },
      {
        commandName: "model",
        rawArguments: "openai/gpt-5.5@work --runtime codex",
        values: {
          provider: "openai",
          model: "gpt-5.5",
          profile: "work",
          runtime: "codex",
        },
      },
    ]);
  });

  it("keeps unresolved model selectors out of structured policy values", () => {
    const directives = parseInlineDirectives("/model 3 --runtime codex-app-server");

    expect(resolveDirectiveAuthorizationRequests(directives)).toEqual([
      {
        commandName: "model",
        rawArguments: "3 --runtime codex-app-server",
      },
    ]);
  });

  it("preserves parsed exec and queue controls", () => {
    const directives = parseInlineDirectives(
      "/exec host=GATEWAY security=FULL ask=ALWAYS node=ops " +
        "/queue coalesce debounce:2s cap:5 drop:summary",
    );

    expect(resolveDirectiveAuthorizationRequests(directives)).toEqual([
      {
        commandName: "exec",
        rawArguments: "host=GATEWAY security=FULL ask=ALWAYS node=ops",
        values: {
          host: "gateway",
          security: "full",
          ask: "always",
          node: "ops",
        },
      },
      {
        commandName: "queue",
        rawArguments: "coalesce debounce:2s cap:5 drop:summary",
        values: {
          mode: "collect",
          debounce: 2000,
          cap: 5,
          drop: "summarize",
        },
      },
    ]);
  });

  it("keeps invalid directive spelling only in raw arguments", () => {
    const directives = parseInlineDirectives(
      "/exec host=spaceship security=full /queue collect debounce:nope",
    );

    expect(resolveDirectiveAuthorizationRequests(directives)).toEqual([
      {
        commandName: "exec",
        rawArguments: "host=spaceship security=full",
        values: { security: "full" },
      },
      {
        commandName: "queue",
        rawArguments: "collect debounce:nope",
        values: { mode: "collect" },
      },
    ]);
  });

  it("represents no-argument and reset directives without the whole message", () => {
    expect(resolveDirectiveAuthorizationRequests(parseInlineDirectives("/status"))).toEqual([
      { commandName: "status" },
    ]);
    expect(resolveDirectiveAuthorizationRequests(parseInlineDirectives("/queue reset"))).toEqual([
      {
        commandName: "queue",
        rawArguments: "reset",
        values: { mode: "reset" },
      },
    ]);
  });
});
