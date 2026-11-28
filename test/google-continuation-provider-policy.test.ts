import { hash } from "node:crypto";
import type { AssistantMessage } from "openclaw/plugin-sdk/llm";
import { withServer } from "openclaw/plugin-sdk/test-env";
import { afterEach, assert, expect, it, vi } from "vitest";
import { buildGoogleProvider } from "../extensions/google/api.js";
import { modelRequestBodyState } from "../packages/ai/src/transports/model-request-body.js";
import {
  wrapStreamFnWithProviderPromptState,
  type ProviderPromptState,
} from "../src/agents/embedded-agent-runner/provider-prompt-state.js";
import { makeProviderModelFixture } from "../src/agents/test-helpers/provider-model-fixture.js";

afterEach(() => vi.unstubAllEnvs());

it.each([
  { name: "changed final generation settings", changeSettings: true },
  { name: "a token hidden from final policy", omitToken: true },
  { name: "abort after final policy", abortPolicy: true },
  { name: "the final UTF-8 size after token insertion", oversizeReplay: true },
  ...["continuationToken", "continuation_token"].flatMap((injectedKey) =>
    [undefined, null, "synthetic-injected-token"].map((injectedValue) => ({
      name: `policy-injected ${injectedKey}=${String(injectedValue)}`,
      injectedKey,
      injectedValue,
    })),
  ),
])(
  "binds registered Google continuation to $name and records actual wire bytes",
  async (testCase) => {
    vi.stubEnv("OPENCLAW_DEBUG_PROXY_ENABLED", "0");
    const policyToken = "synthetic-receipt-🦞";
    const wires: string[] = [];
    const state: ProviderPromptState = {};
    const controller = new AbortController();
    let temperature = 0.25;
    const policy = vi.fn(async (payload: unknown) => {
      assert(payload && typeof payload === "object" && !Array.isArray(payload));
      const replacement: Record<string, unknown> = {
        ...payload,
        generationConfig: { temperature },
      };
      if ("omitToken" in testCase) {
        delete replacement.continuationToken;
      }
      if ("injectedKey" in testCase) {
        replacement[testCase.injectedKey] = testCase.injectedValue;
      }
      if ("oversizeReplay" in testCase) {
        replacement.contents = [];
        const prefix = JSON.stringify(replacement);
        const bytes =
          20_000_000 -
          10 -
          Buffer.byteLength(prefix) -
          Buffer.byteLength('{"role":"user","parts":[{"text":""}]}');
        replacement.contents = [
          {
            role: "user",
            parts: [{ text: "é".repeat(Math.floor(bytes / 2)) + "x".repeat(bytes % 2) }],
          },
        ];
        expect(Buffer.byteLength(JSON.stringify(replacement))).toBe(20_000_000 - 10);
      }
      if ("abortPolicy" in testCase) {
        controller.abort(false);
      }
      return replacement;
    });
    await withServer(
      (request, response) => {
        const chunks: Buffer[] = [];
        request.on("data", (chunk: Buffer) => {
          chunks.push(Buffer.from(chunk));
        });
        request.on("end", () => {
          wires.push(Buffer.concat(chunks).toString("utf8"));
          response.writeHead(200, { "content-type": "text/event-stream" });
          response.end(
            `data: ${JSON.stringify({
              candidates: [
                {
                  finishReason: "CONTINUATION",
                  continuationToken: policyToken,
                  content: { parts: [{ text: "partial response" }] },
                },
              ],
            })}\n\n`,
          );
        });
      },
      async (origin) => {
        const model = makeProviderModelFixture({
          api: "google-generative-ai",
          provider: "clawrouter",
          id: "gemini-3.5-flash",
          baseUrl: `${origin}/v1/native/google-gemini/v1beta`,
        });
        const registered = buildGoogleProvider().createStreamFn?.({
          provider: model.provider,
          modelId: model.id,
          model,
        });
        assert(registered);
        const streamFn = wrapStreamFnWithProviderPromptState({
          streamFn: registered,
          state,
          effectiveContextTokenBudget: 128_000,
          transformPayload: policy,
        });
        const observedBytes: number[] = [];
        const invoke = async (googleContinuation?: AssistantMessage["providerReplay"]) => {
          const options = {
            apiKey: "synthetic-router-key",
            headers: { Authorization: "Bearer synthetic-router-key" },
            googleContinuation,
            signal: controller.signal,
          };
          modelRequestBodyState(options).onBytes = (bytes) => observedBytes.push(bytes);
          const stream = await streamFn(
            model,
            {
              messages: [{ role: "user", content: "synthetic request", timestamp: 0 }],
            },
            options,
          );
          return stream.result();
        };
        const first = await invoke();
        if ("injectedKey" in testCase || "abortPolicy" in testCase) {
          expect(first.providerReplay).toBeUndefined();
          expect(first.stopReason).toBe("abortPolicy" in testCase ? "aborted" : "error");
          expect(wires).toEqual([]);
          expect(observedBytes).toEqual([]);
          expect(policy).toHaveBeenCalledTimes(1);
          if ("abortPolicy" in testCase) {
            expect(controller.signal.reason).toBe(false);
          }
          return;
        }
        expect(first.providerReplay?.id).toBe(policyToken);
        const replay = await invoke(first.providerReplay);
        if ("oversizeReplay" in testCase) {
          expect(replay.stopReason).toBe("error");
          expect(replay.errorMessage).toContain(
            "Google request body must be smaller than 20000000 bytes",
          );
          expect(replay.providerReplay).toBeUndefined();
          expect(wires).toHaveLength(1);
          expect(observedBytes).toEqual([20_000_000 - 10]);
          expect(policy).toHaveBeenCalledTimes(2);
          return;
        }
        expect(replay.providerReplay?.id).toBe(policyToken);
        expect(wires).toHaveLength(2);
        expect(JSON.parse(wires[1]!)).toMatchObject({
          generationConfig: { temperature: 0.25 },
          continuationToken: policyToken,
        });
        expect(state.lastAttempt).toMatchObject({
          digest: hash("sha256", wires[1]!),
          byteWeight: Buffer.byteLength(wires[1]!),
          wire: { requestBytes: Buffer.byteLength(wires[1]!) },
        });
        expect(observedBytes).toEqual(wires.map((wire) => Buffer.byteLength(wire)));
        expect(policy).toHaveBeenCalledTimes(2);
        if ("changeSettings" in testCase) {
          temperature = 0.75;
          const rejected = await invoke(first.providerReplay);
          expect(rejected.stopReason).toBe("error");
          expect(rejected.providerReplay).toBeUndefined();
          expect(wires).toHaveLength(2);
          expect(policy).toHaveBeenCalledTimes(3);
        }
      },
    );
  },
);
