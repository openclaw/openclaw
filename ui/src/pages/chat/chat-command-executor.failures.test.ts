// @vitest-environment node
import { expect, it, vi } from "vitest";
import { t } from "../../i18n/index.ts";
import { createTestSessionCapability } from "../../lib/sessions/session-capability.test-support.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { sessionMutationGatewayHello } from "../../test-helpers/gateway-methods.ts";
import { executeSlashCommand } from "./chat-command-executor.ts";

const failures = {
  error: {
    value: new Error("request failed", {
      cause: new Error("Authorization: Bearer example-secret-token"),
    }),
    text: "request failed | Authorization: [redacted]",
  },
  string: { value: "connection lost", text: "connection lost" },
  empty: { value: "", text: "" },
  structured: {
    value: { status: 503, code: "UNAVAILABLE" },
    text: "status=503 code=UNAVAILABLE",
  },
};

it.each([
  ["model", "", "model.getFailed", "list", "error"],
  ["model", "example/model", "model.setFailed", "patch", "string"],
  ["think", "", "thinking.getFailed", "list", "error"],
  ["think", "default", "thinking.resetFailed", "patch", "empty"],
  ["think", "high", "thinking.setFailed", "patch", "error"],
  ["verbose", "", "verbose.getFailed", "list", "string"],
  ["verbose", "on", "verbose.setFailed", "patch", "error"],
  ["fast", "", "fast.getFailed", "list", "structured"],
  ["fast", "default", "fast.resetFailed", "patch", "error"],
  ["fast", "on", "fast.setFailed", "patch", "string"],
  ["usage", "", "usage.failed", "list", "error"],
  ["agents", "", "agents.failed", "request", "structured"],
  ["steer", "try again", "steer.requestFailed", "request", "error"],
  ["redirect", "start over", "redirect.requestFailed", "request", "string"],
] as const)(
  "preserves /%s %s failure content and result shape",
  async (command, args, key, boundary, failureKind) => {
    const failure = failures[failureKind];
    const request = vi.fn().mockRejectedValue(failure.value);
    const client = createTestGatewayClient(request);
    const sessionAccessSnapshot = {
      client,
      phase: "connected" as const,
      hello: sessionMutationGatewayHello(),
    };
    const sessions = createTestSessionCapability({
      snapshot: sessionAccessSnapshot,
      subscribe: () => () => undefined,
      subscribeEvents: () => () => undefined,
    });
    const list = vi.spyOn(sessions, "list");
    const patch = vi.spyOn(sessions, "patch").mockRejectedValue(failure.value);
    if (boundary === "list") {
      list.mockRejectedValue(failure.value);
    } else {
      list.mockResolvedValue({
        ts: 0,
        path: "",
        count: 0,
        sessions: [],
        defaults: { modelProvider: null, model: null, contextTokens: null },
      });
    }

    const result = await executeSlashCommand(client, "agent:main:main", command, args, {
      sessions,
      sessionAccessSnapshot,
      chatModelCatalog: [],
    });

    expect(result).toEqual({
      content: t(`chat.commandResults.${key}`, { error: failure.text }),
      failed: true,
    });
    expect(Object.keys(result)).toEqual(["content", "failed"]);
    if (boundary === "list") {
      expect(list).toHaveBeenCalledOnce();
    }
    expect(patch).toHaveBeenCalledTimes(boundary === "patch" ? 1 : 0);
    expect(request).toHaveBeenCalledTimes(boundary === "request" ? 1 : 0);
  },
);
