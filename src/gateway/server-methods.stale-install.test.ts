import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AgentDatabaseAdmissionError,
  createAgentDatabaseInspectionRefusal,
} from "../state/agent-database-admission.js";
import { handleGatewayRequest } from "./server-methods.js";
import { moduleNotFoundError } from "./stale-install.test-support.js";

async function dispatchThrowingHandler(error: Error, respond = vi.fn()) {
  await handleGatewayRequest({
    req: { type: "req", id: "stale-install", method: "test.stale-install" },
    respond,
    client: null,
    isWebchatConnect: () => false,
    context: { getRuntimeConfig: () => ({}) } as never,
    extraHandlers: {
      "test.stale-install": async () => {
        throw error;
      },
    },
  });
  return respond;
}

function expectUnavailable(respond: ReturnType<typeof vi.fn>, error: object) {
  expect(respond).toHaveBeenCalledWith(
    false,
    undefined,
    expect.objectContaining({ code: "UNAVAILABLE", ...error }),
  );
}

describe("gateway stale install errors", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each(["ERR_MODULE_NOT_FOUND", "ENOENT"])(
    "turns an own runtime %s into restart guidance",
    async (code) => {
      vi.stubEnv("OPENCLAW_PROFILE", "sd1");
      const missingChunk = fileURLToPath(
        new URL("../../dist/missing-own-chunk.js", import.meta.url),
      );
      const error =
        code === "ENOENT"
          ? Object.assign(new Error(`ENOENT: no such file or directory, open '${missingChunk}'`), {
              code,
              path: missingChunk,
              syscall: "open",
            })
          : moduleNotFoundError(missingChunk);
      const respond = await dispatchThrowingHandler(error);

      expectUnavailable(respond, {
        retryable: false,
        message: expect.stringContaining("openclaw --profile sd1 gateway restart"),
        details: {
          code: "STALE_INSTALL",
          restartCommand: "openclaw --profile sd1 gateway restart",
        },
      });
    },
  );

  it("does not rewrite a missing module outside the OpenClaw install", async () => {
    const outsideInstall = path.join(path.parse(process.cwd()).root, "outside-openclaw/missing.js");
    const error = moduleNotFoundError(outsideInstall);
    const respond = vi.fn();

    await expect(dispatchThrowingHandler(error, respond)).rejects.toBe(error);
    expect(respond).not.toHaveBeenCalled();
  });
});

it("returns a thrown pending admission as a retryable RPC response", async () => {
  const refusal = createAgentDatabaseInspectionRefusal({
    agentId: "worker",
    paths: ["/isolated/worker.sqlite"],
    reason: "Inspection continues in the background.",
    pending: true,
  });
  const respond = await dispatchThrowingHandler(new AgentDatabaseAdmissionError(refusal));
  expectUnavailable(respond, { details: refusal, retryable: true, retryAfterMs: 250 });
});
