import "../../test-utils/prepare-compiled-subprocesses.js";
import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import type { RunEmbeddedAgentParams } from "../../agents/embedded-agent-runner/run/params.js";
import { runEmbeddedAgent } from "../../agents/embedded-agent.js";
import { withGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import {
  captureSessionEventTargetForHost,
  enqueueSessionEventForHost,
} from "./session-event-handoff.js";
import {
  configureEventState,
  openEventToolHost,
  runEventFixture,
} from "./session-event.test-support.js";

// mock-isolation: Replace model execution; exercise real event admission and filesystem effects.
vi.mock("../../agents/embedded-agent-runner/run.js", () => ({
  runEmbeddedAgent: vi.fn(),
}));
const runEmbeddedAgentMock = vi.mocked(runEmbeddedAgent);
await Promise.all([
  import("../dispatch.js"),
  import("./get-reply-from-config.runtime.js").then((runtime) =>
    runtime.prewarmConfigDrivenReplyRuntime(),
  ),
]);

it.for([
  { change: "same-session", writes: true },
  { change: "restricted-sender", writes: false },
  { change: "cross-session", writes: false },
  { change: "revoked-before-write", writes: false },
  { change: "explicit-producer-cap", writes: false },
  { change: "nested-restriction", writes: false },
  { change: "cli-same-session", writes: true },
  { change: "cli-mcp-same-session", writes: true },
  { change: "cli-cross-session", writes: false },
  { change: "cli-other-agent", writes: false },
  { change: "cli-other-incarnation", writes: false },
  { change: "cli-explicit-cap", writes: false },
  { change: "cli-inherited-restriction", writes: false },
  { change: "cli-revoked-before-write", writes: false },
] as const)(
  "bounds a same-session background completion's final effects: $change",
  async ({ change, writes }, { signal, onTestFinished }) => {
    await runEventFixture("session-event-scoped-effects", onTestFinished, async (state) => {
      await configureEventState(state, {
        tools: { profile: "coding", codeMode: false, toolSearch: false },
      });
      await fs.mkdir(state.workspaceDir, { recursive: true });
      const filePath = path.join(state.workspaceDir, "completion.txt");
      await fs.writeFile(filePath, "original\n");
      const scope = { agentId: "main", sessionKey: "agent:main:scoped-effects" };
      const setMode = async (permissionMode: SessionEntry["permissionMode"]) =>
        replaceSessionEntry(scope, {
          sessionId: "scoped-effects",
          lifecycleRevision: "same-generation",
          updatedAt: Date.now(),
          sessionStartedAt: Date.now(),
          permissionMode,
        });
      await setMode("full");
      const cliProducer = change.startsWith("cli-");
      const revokedBeforeWrite =
        change === "revoked-before-write" || change === "cli-revoked-before-write";
      const cliSourceScope = {
        agentId: change === "cli-other-agent" ? "other" : scope.agentId,
        sessionKey: change === "cli-cross-session" ? "agent:main:other" : scope.sessionKey,
        sessionId: change === "cli-other-incarnation" ? "old-incarnation" : "scoped-effects",
      };
      const captureCliTarget = () =>
        captureSessionEventTargetForHost(scope.agentId, scope.sessionKey, {
          producerPolicy: {
            toolsAllow: ["read"],
            ...(change === "cli-explicit-cap"
              ? {}
              : {
                  conversationScope: cliSourceScope,
                }),
          },
        });
      const captureCli = () =>
        change === "cli-mcp-same-session" || change === "cli-inherited-restriction"
          ? withGatewayToolCallerIdentity(
              {
                ...scope,
                sessionEventToolsAllow: ["read"],
                sessionEventToolsAllowSessionScoped: cliSourceScope,
                receiptAuthority: () => true,
              },
              captureCliTarget,
            )
          : captureCliTarget();
      // The producer's captured ceiling lists only read; the follow-up may drop it only when the
      // caller marked it as this session's own policy.
      const capture = () =>
        cliProducer
          ? captureCli()
          : withGatewayToolCallerIdentity(
              {
                agentId: "main",
                sessionKey:
                  change === "cross-session" ? "agent:main:other-owner" : scope.sessionKey,
                sessionEventToolsAllow: ["read"],
                ...(change === "restricted-sender"
                  ? {}
                  : {
                      sessionEventToolsAllowSessionScoped: {
                        agentId: scope.agentId,
                        sessionKey: scope.sessionKey,
                        sessionId: "scoped-effects",
                      },
                    }),
                receiptAuthority: () => true,
              },
              () =>
                captureSessionEventTargetForHost(
                  scope.agentId,
                  scope.sessionKey,
                  change === "explicit-producer-cap"
                    ? { producerPolicy: { toolsAllow: ["read"] } }
                    : {},
                ),
            );
      const target =
        change === "nested-restriction" || change === "cli-inherited-restriction"
          ? await withGatewayToolCallerIdentity(
              {
                agentId: "main",
                sessionKey: scope.sessionKey,
                sessionEventToolsAllow: ["read"],
                receiptAuthority: () => true,
              },
              capture,
            )
          : await capture();
      let writeOffered = false;
      let writeRejected = false;
      runEmbeddedAgentMock
        .mockReset()
        .mockImplementation(async (params: RunEmbeddedAgentParams) => {
          const { tools, close } = await openEventToolHost(params, "ordinary reply admission");
          try {
            const write = tools.find((tool) => tool.name === "write");
            writeOffered = write !== undefined;
            if (revokedBeforeWrite) {
              await setMode("read-only");
            }
            if (write) {
              await write.execute("write-completion", { path: filePath, content: "completed\n" });
            }
          } catch (error) {
            expect(String(error)).toMatch(/authority|permission|active|configuration changed/i);
            writeRejected = true;
          } finally {
            close();
          }
          return { payloads: [{ text: "Completion observed" }], meta: { durationMs: 1 } };
        });
      const receipt = enqueueSessionEventForHost("Process the event; record the result.", {
        ...scope,
        source: "exec",
        abortSignal: signal,
        expectedTarget: target,
        deliver: false,
      });
      await expect(receipt.accepted).resolves.toEqual({ ok: true });
      await receipt.settled;
      expect({ writeOffered, writeRejected }).toEqual({
        writeOffered: revokedBeforeWrite || writes,
        writeRejected: revokedBeforeWrite,
      });
      expect(await fs.readFile(filePath, "utf8")).toBe(writes ? "completed\n" : "original\n");
    });
  },
);
