import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { expect } from "vitest";
import { writeOpenAiResponsesText } from "../../test/helpers/openai-responses-sse.js";
import { createDeferredCore } from "../shared/deferred.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import type { GatewayClient } from "./client.js";
import { writeToolCall } from "./gateway-provider-fixture.test-support.js";
import { productProvider } from "./server.chat-product.test-support.js";

export type GoalAuthorityTrace = (data: Record<string, unknown>) => void;
function spawnReceipt(value: unknown): { runId: string; childSessionKey: string } | undefined {
  if (typeof value === "string") {
    try {
      return spawnReceipt(JSON.parse(value));
    } catch {
      return undefined;
    }
  }
  if (!value || typeof value !== "object") {
    return undefined;
  }
  if (
    "runId" in value &&
    "childSessionKey" in value &&
    typeof value.runId === "string" &&
    typeof value.childSessionKey === "string"
  ) {
    return { runId: value.runId, childSessionKey: value.childSessionKey };
  }
  return Object.values(value)
    .map(spawnReceipt)
    .find((receipt) => receipt !== undefined);
}

export function assistantText(value: unknown): string | undefined {
  const message = asOptionalRecord(value);
  if (message?.role !== "assistant" || !Array.isArray(message.content)) {
    return undefined;
  }
  return message.content
    .map((block) => {
      const part = asOptionalRecord(block);
      return part?.type === "text" && typeof part.text === "string" ? part.text : "";
    })
    .join("");
}

export function transcriptContent(messages: unknown[] | undefined) {
  return messages?.map((value) => {
    const message = asOptionalRecord(value);
    return {
      id: asOptionalRecord(message?.["__openclaw"])?.id,
      role: message?.role,
      content: message?.content,
    };
  });
}

export function createGoalAuthorityScenarios(alias: (value: string, label: string) => void) {
  return [false, true].map((revoke) => {
    const name = revoke ? "revoke" : "current";
    const profile = ensureProfileForEmail(`${name}@goal-authority.example.test`);
    alias(profile.id, name + "-selected-profile");
    const nonce = randomUUID();
    return {
      name,
      revoke,
      profile,
      prompt: `GOAL_AUTHORITY_${nonce}`,
      childTask: `CHILD_AUTHORITY_${nonce}`,
      childResult: `CHILD_DONE_${nonce}`,
      parentCalls: 0,
      childCalls: 0,
      failRequest: false,
      failureCalls: 0,
      sessionKey: "",
      childRunId: undefined as string | undefined,
      releaseChild: createDeferredCore(),
      yielded: createDeferredCore(),
      childStarted: createDeferredCore(),
      settlementEntered: createDeferredCore(),
      releaseSettlement: createDeferredCore(),
      providerCancelled: createDeferredCore(),
      finalText: `GOAL_COMPLETE_${nonce}`,
      finalReceived: createDeferredCore(),
    };
  });
}
export function createGoalAuthorityProvider(
  errors: unknown[],
  scenarios: ReturnType<typeof createGoalAuthorityScenarios>,
  confidential: boolean,
  wait: <T>(work: Promise<T>) => Promise<T>,
  fail: (error: unknown) => void,
  trace: GoalAuthorityTrace,
) {
  return productProvider(errors, async (text, response) => {
    const reply = (value: string) =>
      writeOpenAiResponsesText(response, {
        text: value,
        messageId: randomUUID(),
        responseId: randomUUID(),
      });
    try {
      if (text.includes("conversationLabelSource")) {
        reply("Synthetic Goal authority");
        return;
      }
      const scenario =
        scenarios.find((entry) => text.includes(entry.prompt)) ??
        scenarios.find((entry) => text.includes(entry.childTask));
      assert(scenario, "only synthetic Goal conversations may call this provider");
      if (scenario.failRequest) {
        scenario.failureCalls++;
        response.writeHead(400, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            error: {
              type: "invalid_request_error",
              message: "Synthetic authorized provider failure",
            },
          }),
        );
        return;
      }
      if (!text.includes(scenario.prompt) && text.includes(scenario.childTask)) {
        scenario.childCalls++;
        expect(scenario.childCalls).toBe(1);
        scenario.childStarted.resolve();
        await wait(scenario.releaseChild.promise);
        reply(scenario.childResult);
        return;
      }
      scenario.parentCalls++;
      const body = JSON.parse(text) as { input?: Array<{ type?: string; output?: unknown }> };
      const output = body.input?.findLast((item) => item.type === "function_call_output")?.output;
      if (scenario.parentCalls === 1) {
        writeToolCall(response, "create_goal", { objective: scenario.prompt });
      } else if (scenario.parentCalls === 2) {
        expect(JSON.stringify(output)).toContain("created");
        writeToolCall(response, "sessions_spawn", {
          task: scenario.childTask,
          agentId: "main",
          runtime: "subagent",
          context: "isolated",
          cleanup: "keep",
          completionTarget: "parent",
        });
      } else if (scenario.parentCalls === 3) {
        scenario.childRunId = spawnReceipt(output)?.runId;
        assert(scenario.childRunId, "spawn must return its actual child run");
        writeToolCall(response, "sessions_yield", {});
      } else if (scenario.parentCalls === 4) {
        expect(text).toContain(scenario.childResult);
        expect(text).toContain("Active goal:");
        // Hold actual provider I/O only after the committed child return admitted
        // requester completion. Revocation must cancel this retained operator.
        response.once("close", () => {
          if (!response.writableFinished) {
            trace({
              kind: "provider.cancelled",
              scenario: scenario.name,
              writableFinished: response.writableFinished,
            });
            scenario.providerCancelled.resolve();
          }
        });
        trace({
          kind: "provider.retained",
          scenario: scenario.name,
          parentCalls: scenario.parentCalls,
          childCalls: scenario.childCalls,
        });
        scenario.settlementEntered.resolve();
        if (scenario.revoke) {
          await wait(scenario.releaseSettlement.promise);
        }
        trace({
          kind: "provider.final-output.attempt",
          scenario: scenario.name,
          destroyed: response.destroyed,
        });
        if (scenario.revoke && confidential) {
          if (!response.destroyed) {
            reply(scenario.finalText);
          }
          return;
        }
        if (!response.destroyed) {
          writeToolCall(response, "sessions_create", {
            agentId: "sibling",
            label: `Forbidden ${scenario.name}`,
          });
        }
      } else if (scenario.parentCalls === 5) {
        expect(scenario.revoke).toBe(false);
        expect(typeof output === "string" ? JSON.parse(output) : output).toMatchObject({
          status: "forbidden",
        });
        reply("The delegated item is done. The remaining Goal item is unfinished.");
      } else if (scenario.parentCalls === 6) {
        expect(scenario.revoke).toBe(false);
        expect(text).toContain("Advance the active goal");
        writeToolCall(response, "update_goal", { status: "complete" });
      } else if (scenario.parentCalls === 7) {
        expect(scenario.revoke).toBe(false);
        reply(scenario.finalText);
      } else {
        throw new Error("Unexpected Goal authority provider request");
      }
    } catch (error) {
      fail(error);
      throw error;
    }
  });
}
/** Optional, allowlisted execution artifacts; normal CI runs every assertion without tracing. */
export function createGoalAuthorityEvidence(caseId: "role ceiling" | "confidential audience") {
  const tracePath = process.env.OPENCLAW_TEST_EVIDENCE_PATH;
  const sourceTree = process.env.OPENCLAW_TEST_EVIDENCE_TREE;
  const baseTree = process.env.OPENCLAW_TEST_EVIDENCE_BASE;
  if (tracePath && !/^[0-9a-f]{40}$/.test(sourceTree ?? "")) {
    throw new Error("Tracing requires the exact executed source tree");
  }
  const aliases = new Map<string, string>();
  let sequence = 0;
  let traceWriteFailed = false;
  function alias(value: string, label: string) {
    if (!/^[a-z0-9-]{1,48}$/i.test(label)) {
      throw new Error("Non-synthetic alias");
    }
    aliases.set(value, label);
  }
  const digest = (value: unknown) =>
    createHash("sha256")
      .update(typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(value))
      .digest("hex");
  const actors = new Set([
    "administrator",
    "creator",
    "excluded",
    "current",
    "revoke",
    "selected",
    "admin",
  ]);
  const modes = new Set(["creator", "audience", "source", "unrestricted"]);
  const kinds = new Set([
    "proof.scope",
    "rpc.request",
    "rpc.response",
    "websocket.event",
    "provider.retained",
    "provider.cancelled",
    "provider.final-output.attempt",
    "audience.revocation.committed",
    "provider.release.after-audience-revoke",
    "effect.transcript",
    "effect.canonical-transcript",
    "effect.events",
    "audience.restored",
    "effect.authorized",
    "strict.no-transcript-mutation",
  ]);
  const numbers = [
    "parentCalls",
    "childCalls",
    "beforeCount",
    "afterCount",
    "observedAddedMessages",
    "observedTranscriptFinals",
    "observedEventFinals",
    "observedRevokedDisclosureCount",
    "authorizedPublicationCount",
    "finalTextOccurrences",
    "observedFailureNotices",
    "beforeBytes",
    "afterBytes",
    "observedByteChange",
    "bytes",
    "bodyBytes",
    "status",
  ];
  const booleans = [
    "audienceConfigured",
    "rolesUnchangedDuringRevocation",
    "writableFinished",
    "destroyed",
    "ok",
  ];
  const hashes = ["beforeSHA256", "afterSHA256", "SHA256", "bodySHA256"];
  const methods = new Set([
    "users.self",
    "users.setRole",
    "sessions.create",
    "sessions.patch",
    "chat.history",
    "sessions.messages.subscribe",
    "sessions.list",
    "chat.send",
    "chat.inject",
    "health",
    "sessions.describe",
  ]);
  const label = (value: unknown) =>
    typeof value === "string" ? (aliases.get(value) ?? "<unlisted-synthetic-id>") : undefined;
  function record(data: Record<string, unknown>) {
    const kind = typeof data.kind === "string" ? data.kind : "";
    if (!kinds.has(kind)) {
      return { kind: "<unlisted-evidence>", detailsOmitted: true };
    }
    const out: Record<string, unknown> = { kind };
    for (const key of ["actor", "scenario"]) {
      if (typeof data[key] === "string" && actors.has(data[key] as string)) {
        out[key] = data[key];
      }
    }
    for (const key of numbers) {
      if (typeof data[key] === "number" && Number.isFinite(data[key])) {
        out[key] = data[key];
      }
    }
    for (const key of booleans) {
      if (typeof data[key] === "boolean") {
        out[key] = data[key];
      }
    }
    for (const key of hashes) {
      if (typeof data[key] === "string" && /^[0-9a-f]{64}$/.test(data[key] as string)) {
        out[key] = data[key];
      }
    }
    if (data.expected === 0) {
      out.expectedMutationCount = 0;
    }
    const access = data.access as { mode?: string } | undefined;
    if (access?.mode && modes.has(access.mode)) {
      out.accessMode = access.mode;
    }
    if (kind === "proof.scope") {
      out.scope =
        "isolated source Gateway; synthetic identities; scripted provider I/O; no binary upgrade";
    }
    if (kind === "rpc.request" || kind === "rpc.response") {
      const method = String(data.method);
      if (!methods.has(method)) {
        out.method = "<unlisted-rpc>";
        out.detailsOmitted = true;
        return out;
      }
      out.method = method;
      const params = data.params as Record<string, unknown> | undefined;
      if (params) {
        if (params.key || params.sessionKey) {
          out.session = label(params.key ?? params.sessionKey);
        }
        if (typeof params.limit === "number") {
          out.limit = params.limit;
        }
        if (params.expectedSessionId) {
          out.expectedSessionIdPresent = true;
        }
        const a = params.access as { mode?: string; profileIds?: unknown[] } | undefined;
        if (a?.mode && modes.has(a.mode)) {
          out.requestedAccess = { mode: a.mode, audienceCount: a.profileIds?.length ?? 0 };
        }
        if (params.visibility === "shared" || params.visibility === "draft") {
          out.visibility = params.visibility;
        }
      }
      if (data.result !== undefined) {
        out.resultSHA256 = digest(data.result);
        const result = data.result as {
          messages?: unknown[];
          sessions?: unknown[];
          key?: string;
          subscribed?: boolean;
          profile?: { id?: string };
        };
        if (Array.isArray(result?.messages)) {
          out.messageCount = result.messages.length;
        }
        if (Array.isArray(result?.sessions)) {
          out.sessionCount = result.sessions.length;
        }
        if (typeof result?.subscribed === "boolean") {
          out.subscribed = result.subscribed;
        }
        if (result?.key) {
          out.session = label(result.key);
        }
        if (result?.profile?.id) {
          out.profile = label(result.profile.id);
        }
      }
      const error = data.error as { code?: string; message?: string } | undefined;
      if (error) {
        out.error = {
          code:
            typeof error.code === "string" && /^[A-Z_]+$/.test(error.code)
              ? error.code
              : "REDACTED",
          opaqueNotFound: /not found|unavailable/i.test(error.message ?? ""),
          messageSHA256: digest(error.message ?? ""),
        };
      }
    }
    if (kind === "websocket.event") {
      const event = data.event as
        | {
            event?: string;
            payload?: { sessionKey?: string; message?: unknown; deltaText?: unknown };
          }
        | undefined;
      const names = new Set([
        "chat",
        "session.message",
        "sessions.changed",
        "agent",
        "tick",
        "health",
        "session.typing",
        "session.suggestion",
      ]);
      out.event = event?.event && names.has(event.event) ? event.event : "<other-event>";
      if (event?.payload) {
        out.session = label(event.payload.sessionKey);
        if (event.payload.message !== undefined) {
          out.messageSHA256 = digest(event.payload.message);
        }
        if (typeof event.payload.deltaText === "string") {
          out.deltaSHA256 = digest(event.payload.deltaText);
        }
      }
    }
    return out;
  }
  function trace(data: Record<string, unknown>) {
    if (!tracePath) {
      return;
    }
    if (
      data.kind === "websocket.event" &&
      (data.event as { event?: string } | undefined)?.event === "presence"
    ) {
      return;
    }
    try {
      appendFileSync(
        tracePath,
        JSON.stringify({
          sequence: ++sequence,
          atUTC: new Date().toISOString(),
          caseId,
          candidateTree: sourceTree,
          baseTree: baseTree && /^[0-9a-f]{40}$/.test(baseTree) ? baseTree : undefined,
          ...record(data),
        }) + "\n",
      );
    } catch {
      // Artifact failure must not intercept the real RPC, provider or event path.
      traceWriteFailed = true;
    }
  }
  const assertEvidenceComplete = () =>
    assert(!traceWriteFailed, "Execution completed but evidence recording failed");
  function instrument(client: GatewayClient, actor: string) {
    const request = client.request.bind(client);
    client.request = async <T = Record<string, unknown>>(
      ...args: Parameters<GatewayClient["request"]>
    ): Promise<T> => {
      const [method, params] = args;
      trace({ kind: "rpc.request", actor, method, params });
      try {
        const result = await request<T>(...args);
        trace({ kind: "rpc.response", actor, method, ok: true, result });
        return result;
      } catch (error) {
        const x = error as { code?: string; message?: string };
        trace({
          kind: "rpc.response",
          actor,
          method,
          ok: false,
          error: { code: x.code, message: x.message },
        });
        throw error;
      }
    };
    return client;
  }

  return { alias, digest, instrument, trace, assertEvidenceComplete };
}
