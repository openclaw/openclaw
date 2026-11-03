import "../../test-utils/prepare-compiled-subprocesses.js";
import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { runEmbeddedAgent } from "../../agents/embedded-agent.js";
import { withGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  captureSessionEventTargetForHost,
  enqueueSessionEventForHost,
} from "./session-event-handoff.js";
import {
  configureEventState,
  openEventToolHost,
  runEventFixture,
} from "./session-event.test-support.js";

// mock-isolation: Only model inference is synthetic; admission, tool policy and exec stay real.
vi.mock("../../agents/embedded-agent-runner/run.js", () => ({ runEmbeddedAgent: vi.fn() }));
const runEmbeddedAgentMock = vi.mocked(runEmbeddedAgent);

// #177510: a background exec completion continues its requester's own work. The requester is
// allowed only through toolsBySender (never a command owner) and the wildcard strips exec.
const OWNER = "100001";
const GUEST = "100002";
const ACCOUNT = "owner-account";
const scope = { agentId: "main", sessionKey: "agent:main:completion-reauthorize" };
const route = { channel: "telegram", to: `telegram:${OWNER}`, accountId: ACCOUNT };

function policy(revoke?: "sender"): Partial<OpenClawConfig> {
  return {
    channels: { telegram: {} },
    tools: {
      profile: "coding",
      codeMode: false,
      toolSearch: false,
      exec: { host: "gateway", mode: "full" },
      toolsBySender: {
        [`id:${OWNER}`]: revoke === "sender" ? { deny: ["exec"] } : {},
        "*": { deny: ["exec", "process", "nodes", "gateway"] },
      },
    },
  };
}

const retired = "agent harness host capability is no longer active";
const rows: Array<{
  label: string;
  requester: string;
  revoke?: "sender";
  after?: true;
  outcome: string;
}> = [
  { label: "owner", requester: OWNER, outcome: "ran" },
  { label: "guest", requester: GUEST, outcome: "absent" },
  {
    label: "sender revoked before admission",
    requester: OWNER,
    revoke: "sender",
    outcome: "absent",
  },
  // Revoking publishes config, which retires the admitted turn's tool host before the call.
  {
    label: "sender revoked after admission",
    requester: OWNER,
    revoke: "sender",
    after: true,
    outcome: retired,
  },
];

it.for(rows)(
  "runs completion-side exec only under the requester's current sender policy: $label",
  async (row, { signal, onTestFinished }) => {
    await runEventFixture("session-event-completion-reauthorize", onTestFinished, async (state) => {
      const config = await configureEventState(state, policy());
      await replaceSessionEntry(scope, {
        sessionId: "completion-reauthorize",
        permissionMode: "full",
        updatedAt: Date.now(),
        chatType: "direct",
        delivery: {
          kind: "external",
          route: { channel: "telegram", accountId: ACCOUNT, target: { to: route.to } },
          context: route,
          origin: { provider: "telegram", chatType: "direct", accountId: ACCOUNT },
        },
      });
      // The host-owned exec caller supplies the requester and conversation it spoke in.
      const target = await withGatewayToolCallerIdentity(
        {
          ...scope,
          requesterOrigin: {
            ...scope,
            messageProvider: "telegram",
            accountId: ACCOUNT,
            chatType: "direct",
            conversationId: OWNER,
            senderId: row.requester,
          },
        },
        () =>
          captureSessionEventTargetForHost(scope.agentId, scope.sessionKey, {
            retainRequesterOwner: true,
          }),
      );
      const revoke = () => setRuntimeConfigSnapshot({ ...config, ...policy(row.revoke) });
      if (row.revoke && !row.after) {
        revoke();
      }
      const marker = path.join(state.workspaceDir, "completion-exec.txt");
      const seen: { offered?: boolean; outcome?: string; senderIsOwner?: boolean } = {};
      runEmbeddedAgentMock.mockReset().mockImplementation(async (params) => {
        const { tools, close } = await openEventToolHost(params, "completion admission", {
          includeShellTools: true,
        });
        const exec = tools.find((tool) => tool.name === "exec");
        seen.offered = Boolean(exec);
        seen.senderIsOwner = params.senderIsOwner;
        if (row.after) {
          revoke();
        }
        seen.outcome = await (
          exec
            ? exec.execute("completion-exec", { command: `printf ran > '${marker}'` }).then(
                () => "ran",
                (error: unknown) => (error instanceof Error ? error.message : String(error)),
              )
            : Promise.resolve("absent")
        ).finally(close);
        return { payloads: [{ text: "Completion observed" }], meta: { durationMs: 1 } };
      });
      const receipt = enqueueSessionEventForHost("Background command finished.", {
        ...scope,
        source: "exec",
        expectedTarget: target,
        abortSignal: signal,
        deliver: false,
        deliveryContext: route,
      });
      await expect(receipt.settled).resolves.toMatchObject({ status: "completed" });
      const ran = await fs.readFile(marker, "utf8").then(
        (text) => text === "ran",
        () => false,
      );
      // A toolsBySender-only requester is not a command owner: the turn never impersonates one.
      expect({ ...seen, ran }).toEqual({
        offered: row.outcome !== "absent",
        outcome: row.outcome,
        senderIsOwner: false,
        ran: row.outcome === "ran",
      });
    });
  },
);
