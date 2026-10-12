import { performance } from "node:perf_hooks";
import { afterEach, expect, it, vi } from "vitest";
import {
  replaceSessionEntry,
  loadSessionEntry,
  waitForSessionTranscriptProjection,
} from "../../config/sessions/session-accessor.js";
import { replaceTranscriptEvents } from "../../config/sessions/session-accessor.sqlite-transcript-write.test-support.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import * as preparation from "../session-sharing-preparation.js";
import * as artifactReads from "../session-transcript-readers.js";
import { artifactsHandlers } from "./artifacts.js";
import { createHistoryReadContext } from "./chat-history.test-helpers.js";
import { identifiedClient } from "./sessions-read-cache.test-support.js";
import type { RespondFn } from "./types.js";

afterEach(() => vi.restoreAllMocks());

it("reuses admitted session facts for artifacts and observes subsequent visibility changes", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const scope = {
      agentId: "main",
      sessionKey: "agent:main:prepared-artifacts",
      sessionId: "prepared-artifacts",
    };
    const entry = {
      sessionId: scope.sessionId,
      updatedAt: 1,
      visibility: "shared" as const,
      createdActor: { type: "human" as const, source: "profile" as const, id: "owner" },
    };
    await replaceSessionEntry(scope, entry);
    const data = Buffer.alloc(912, "x").toString("base64");
    await replaceTranscriptEvents(scope, [
      { type: "session", version: 3, id: scope.sessionId },
      {
        type: "message",
        id: "artifact",
        parentId: null,
        message: { role: "assistant", content: [{ type: "file", title: "result.txt", data }] },
      },
    ]);
    await waitForSessionTranscriptProjection(scope);
    expect(loadSessionEntry(scope)?.visibility).toBe("shared");
    const context = await createHistoryReadContext();
    const client = identifiedClient("viewer");
    const request = async (
      method: "artifacts.list" | "artifacts.download",
      params: Record<string, unknown> = {},
    ) => {
      const respond = vi.fn<RespondFn>();
      await artifactsHandlers[method]!({
        params: { sessionKey: scope.sessionKey, ...params },
        context,
        client,
        req: { type: "req", id: "prepared-artifacts", method },
        isWebchatConnect: () => false,
        respond,
      });
      return respond.mock.calls[0]!;
    };
    const listed = await request("artifacts.list");
    expect(listed[0]).toBe(true);
    const payload = listed[1] as { artifacts: { id: string; sizeBytes: number }[] };
    expect(payload.artifacts).toHaveLength(1);
    expect(payload.artifacts[0]?.sizeBytes).toBe(912);
    const artifactId = payload.artifacts[0]!.id;
    const prepare = vi.spyOn(preparation, "prepareSessionMutationFacts");
    const samples: Record<string, number[]> = { "artifacts.list": [], "artifacts.download": [] };
    const rounds = process.env.OPENCLAW_DB_WORKER_BENCH === "1" ? 100 : 1;
    for (let round = 0; round < rounds; round++) {
      for (const method of ["artifacts.list", "artifacts.download"] as const) {
        const start = performance.now();
        const result = await request(method, method === "artifacts.download" ? { artifactId } : {});
        samples[method]!.push(performance.now() - start);
        expect(result[0]).toBe(true);
        if (method === "artifacts.download") {
          expect(result[1]).toMatchObject({ data, encoding: "base64" });
        }
      }
    }
    if (rounds > 1) {
      for (const [method, values] of Object.entries(samples)) {
        values.sort((a, b) => a - b);
        console.log(
          JSON.stringify({
            method,
            samples: values.length,
            payloadBytes: 912,
            medianMs: values[Math.floor(values.length / 2)],
            p99Ms: values[Math.ceil(values.length * 0.99) - 1],
          }),
        );
      }
    }
    expect(prepare).not.toHaveBeenCalled();
    const readArtifacts = artifactReads.readSessionArtifacts;
    vi.spyOn(artifactReads, "readSessionArtifacts").mockImplementationOnce(async (...args) => {
      const result = await readArtifacts(...args);
      await replaceSessionEntry(scope, { ...entry, visibility: "draft", updatedAt: 2 });
      return result;
    });
    const revoked = await request("artifacts.download", { artifactId });
    expect(revoked[0]).toBe(false);
    expect(revoked[2]).toMatchObject({ code: "UNAVAILABLE", retryable: true });
    for (const method of ["artifacts.list", "artifacts.download"] as const) {
      const result = await request(method, method === "artifacts.download" ? { artifactId } : {});
      expect(result[0]).toBe(false);
      expect(result[2]).toMatchObject({ details: { type: "artifact_scope_not_found" } });
    }
  });
});
