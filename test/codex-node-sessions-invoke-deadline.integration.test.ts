/**
 * `/codex sessions --search-all` recovery measured against the REAL Gateway invoke deadline.
 *
 * A bounded listing's truncation notice offers `--search-all` as the route back to a page it
 * omitted. That recovery is only real if the exhaustive request can outlive its own deadline on
 * the input this PR measured: a 2.4 GB codex-home, where the exhaustive handler takes 15.6-21.6 s.
 *
 * Real here: the production `listCodexCliSessionsOnNode`, which owns the forwarded `timeoutMs`,
 * and the production `NodeRegistry` pending invocation, which arms an absolute deadline from that
 * value and resolves `TIMEOUT` while cancelling the node request
 * (`src/gateway/node-registry.invoke-stream.ts`). No deadline rule is restated in test code: each
 * route's verdict is whether the registry settled the invocation on its own before the node
 * answered, which `handleInvokeResult` reports by returning `false` for an invocation it no longer
 * holds. The rejection text comes from the production error mapper `node.invoke` itself uses.
 *
 * Stubbed, at the two edges only: the node is not run, so the measured handler duration is
 * replayed with fake timers against a socket that records request frames, and `runtime.nodes.list`
 * answers from the same registry's connected sessions. The one-line pass-through of
 * `runtime.nodes.invoke`'s `timeoutMs` into `node.invoke` (`src/plugins/service-nodes.ts:112`,
 * `src/plugins/cli-gateway-nodes-runtime.ts:55`) is not exercised here; both production
 * implementations were read rather than measured.
 *
 * The listing owner and the scan budget are reached through `extensions/codex/test-api.ts`, the
 * plugin's test boundary, because `extensions/AGENTS.md` requires core tests to consume bundled
 * plugin helpers through a promoted barrel rather than deep-importing `extensions/codex/src/**`.
 */
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadCodexCliSessionNodeListingTestFixture } from "../extensions/codex/test-api.js";
import { NodeRegistry } from "../src/gateway/node-registry.js";
import { makeClient, registerNodeSession } from "../src/gateway/node-registry.test-helpers.js";
import { respondUnavailableOnNodeInvokeErrorWithProvenance } from "../src/gateway/server-methods/nodes.helpers.js";
import type { RespondFn } from "../src/gateway/server-methods/response-types.js";

const CODEX_CLI_SESSIONS_LIST_COMMAND = "codex.cli.sessions.list";

/**
 * The slowest unfiltered `--search-all` run recorded on the 2.4 GB codex-home in this PR's
 * evidence. This is the only number the test supplies; both expectations below are decided by the
 * registry, not by comparing this against a budget.
 */
const MEASURED_EXHAUSTIVE_HANDLER_MS = 21_600;

const SESSION_ID = "019e2007-1f7e-7eb1-a42b-8c01f4b9b5cd";
const PAYLOAD_JSON = JSON.stringify({
  codexHome: "/Users/mariano/.codex",
  scannedFileCount: 2_990,
  sessionFileCount: 2_990,
  sessions: [
    { sessionId: SESSION_ID, cwd: "/repo", updatedAt: "2026-05-13T06:30:00.000Z", messageCount: 2 },
  ],
});

const registries = new Set<NodeRegistry>();

afterEach(() => {
  for (const registry of registries) {
    for (const session of registry.listConnected()) {
      registry.unregister(session.connId);
    }
  }
  registries.clear();
  vi.useRealTimers();
});

function startNodeFixture() {
  const registry = new NodeRegistry();
  registries.add(registry);
  const frames: string[] = [];
  registerNodeSession(
    registry,
    makeClient("conn-1", "node-1", frames, { commands: [CODEX_CLI_SESSIONS_LIST_COMMAND] }),
    {},
  );
  const runtime = {
    nodes: {
      list: async () => ({
        nodes: registry.listConnected().map((session) => ({
          nodeId: session.nodeId,
          displayName: session.displayName,
          connected: true,
          commands: session.commands,
        })),
      }),
      // Mirrors the production plugin nodes service: forward the requested deadline verbatim and
      // surface a non-ok registry result through node.invoke's own UNAVAILABLE mapper.
      invoke: async (request: Parameters<PluginRuntime["nodes"]["invoke"]>[0]) => {
        const result = await registry.invoke({
          nodeId: request.nodeId,
          command: request.command,
          params: request.params,
          ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
        });
        let failure: string | undefined;
        const respond: RespondFn = (ok, _payload, error) => {
          if (!ok) {
            failure = error?.message;
          }
        };
        if (!respondUnavailableOnNodeInvokeErrorWithProvenance(respond, result)) {
          throw new Error(failure ?? "node invoke failed");
        }
        return result;
      },
    },
  } as unknown as PluginRuntime;
  const readRequest = () => {
    const frame = JSON.parse(frames[0] ?? "{}") as {
      payload?: { id?: string; timeoutMs?: number | null };
    };
    const payload = frame.payload;
    if (!payload?.id) {
      throw new Error("node invoke request frame was not dispatched");
    }
    return { id: payload.id, timeoutMs: payload.timeoutMs };
  };
  const answerNode = (id: string) =>
    registry.handleInvokeResult({
      id,
      nodeId: "node-1",
      connId: "conn-1",
      ok: true,
      payloadJSON: PAYLOAD_JSON,
    });
  return { registry, runtime, readRequest, answerNode };
}

describe("Codex node session listing against the real node invoke deadline", () => {
  it("returns the exhaustive page the truncation notice offers, after the measured handler duration", async () => {
    const { listCodexCliSessionsOnNode, NODE_INVOKE_TIMEOUT_MS } =
      await loadCodexCliSessionNodeListingTestFixture();
    vi.useFakeTimers();
    const { runtime, readRequest, answerNode } = startNodeFixture();

    const listing = listCodexCliSessionsOnNode({
      runtime,
      requestedNode: "node-1",
      searchAll: true,
    });
    // Attach a handler before the clock moves: a deadline this duration outlives rejects while the
    // timers advance, and a rejection first observed by a later `expect` is reported as an
    // unhandled worker error instead of a failed assertion.
    void listing.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(0);
    const request = readRequest();

    await vi.advanceTimersByTimeAsync(MEASURED_EXHAUSTIVE_HANDLER_MS);
    // The registry decides this, not the test: `handleInvokeResult` returns true only while the
    // pending invocation is still held, and false once the deadline settled and released it.
    expect(answerNode(request.id)).toBe(true);

    await expect(listing).resolves.toMatchObject({
      result: { sessions: [{ sessionId: SESSION_ID, cwd: "/repo" }] },
    });

    // Supporting fact, asserted after the behavior: the exhaustive route asks for the budget the
    // Codex session catalog already reserves for a whole-codex-home node scan.
    expect(request.timeoutMs).toBe(NODE_INVOKE_TIMEOUT_MS);
  });

  it("keeps the bounded listing on a budget the same duration exhausts", async () => {
    const { listCodexCliSessionsOnNode, NODE_INVOKE_TIMEOUT_MS } =
      await loadCodexCliSessionNodeListingTestFixture();
    vi.useFakeTimers();
    const { runtime, readRequest, answerNode } = startNodeFixture();

    const listing = listCodexCliSessionsOnNode({ runtime, requestedNode: "node-1" });
    // Attach a handler before the clock moves: this listing rejects while the timers advance, and
    // a rejection first observed by a later `expect` is reported as an unhandled worker error.
    void listing.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(0);
    const request = readRequest();

    await vi.advanceTimersByTimeAsync(MEASURED_EXHAUSTIVE_HANDLER_MS);
    // False because the registry already settled this invocation and released it: the bounded
    // budget was retained rather than widened along with the exhaustive one.
    expect(answerNode(request.id)).toBe(false);

    await expect(listing).rejects.toThrow("TIMEOUT: node invoke timed out");
    expect(request.timeoutMs).toBeLessThan(NODE_INVOKE_TIMEOUT_MS);
  });
});
