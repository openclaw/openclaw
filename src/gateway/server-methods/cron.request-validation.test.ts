import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { CronService } from "../../cron/service.js";
import { createNoopLogger } from "../../cron/service.test-harness.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { cronHandlers } from "./cron.js";
import type { RespondFn } from "./types.js";

describe("cron request validation", () => {
  it.each(["cron.add", "cron.update"] as const)(
    "%s reports the requested stream shape before any mutation",
    async (method) => {
      const job = {
        name: "application errors",
        schedule: { kind: "stream", path: "/workspace/application.log", pattern: "ERROR" },
        task: { prompt: "Report matching errors" },
      };
      const params = method === "cron.add" ? job : { id: "cron-1", patch: job };
      const cron = new CronService({
        scheduler: createTestGatewayScheduler(),
        storePath: "/synthetic/cron-request-validation",
        cronEnabled: false,
        log: createNoopLogger(),
        enqueueSystemEvent: vi.fn(),
        requestHeartbeat: vi.fn(),
        runIsolatedAgentJob: vi.fn().mockRejectedValue(new Error("unexpected run")),
      });
      const add = vi.spyOn(cron, "add").mockRejectedValue(new Error("unexpected mutation"));
      const update = vi.spyOn(cron, "update").mockRejectedValue(new Error("unexpected mutation"));
      const conditionalUpdate = vi
        .spyOn(cron, "updateWithPrecondition")
        .mockRejectedValue(new Error("unexpected mutation"));
      const respond = vi.fn<RespondFn>();
      await expectDefined(
        cronHandlers[method],
        "cron handler",
      )({
        req: { type: "req", id: "invalid-stream", method, params },
        params,
        respond,
        context: createDirectChatContext({ cron }),
        client: null,
        isWebchatConnect: () => false,
      });
      const error = expectDefined(respond.mock.calls[0]?.[2], "validation error");
      expect(error).toMatchObject({ code: "INVALID_REQUEST" });
      expect(error.message).toContain("required property 'command'");
      expect(error.message).toContain("unexpected property 'path'");
      expect(error.message).toContain("unexpected property 'pattern'");
      expect(error.message).toContain("unexpected property 'task'");
      expect(error.message).not.toContain("required property 'at'");
      if (method === "cron.add") {
        expect(error.message).toContain("required property 'sessionTarget'");
        expect(error.message).toContain("required property 'payload'");
      }
      expect(add).not.toHaveBeenCalled();
      expect(update).not.toHaveBeenCalled();
      expect(conditionalUpdate).not.toHaveBeenCalled();
    },
  );
});
