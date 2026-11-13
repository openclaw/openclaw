// One Gateway session through every mid-session trigger: each provider request must extend the
// previous one byte for byte, except at the explicit compaction.
import fs from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { afterEach, beforeEach, expect } from "vitest";
import { startGatewayWithClient } from "../src/gateway/test-helpers.e2e.js";
import { waitForGatewayActiveWork } from "../src/infra/gateway-active-work.js";
import { captureEnv, deleteTestEnvValue, setTestEnvValue } from "../src/test-utils/env.js";
import {
  buildFakeProvider,
  fakeTransportRuntime,
  hasToolResult,
  latestInput as lastMessage,
  readWireRequest,
  writeReply,
  type FakeReply as Reply,
  type FakeTransport as Api,
  type WireRequest,
} from "./helpers/fake-model-transports.js";
import { listenProofProvider, useRuntimeProofFixture } from "./runtime-proof.test-support.js";

const TOKEN = "prefix-stability-token";
const TARGET = "agent:main:prefix-stability-target";
const SENDER = "agent:main:prefix-stability-sender";

/** Requests that do not extend the previous request in the same session, with the first change. */
function prefixBreaks(requests: readonly WireRequest[]): Array<{ at: number; change: string }> {
  const breaks: Array<{ at: number; change: string }> = [];
  for (let index = 1; index < requests.length; index++) {
    const previous = requests[index - 1]!;
    const current = requests[index]!;
    const message = previous.messages.findIndex(
      (entry, position) => current.messages[position] !== entry,
    );
    const change =
      previous.system !== current.system
        ? "system"
        : previous.tools !== current.tools
          ? "tools"
          : message >= 0
            ? `message ${message}: ${previous.messages[message]!.slice(0, 160)} -> ${(current.messages[message] ?? "(removed)").slice(0, 160)}`
            : undefined;
    if (change) {
      breaks.push({ at: index, change });
    }
  }
  return breaks;
}

/** One Gateway process per route: gateway state is process-wide, so each route has its own file. */
export function usePrefixStabilityJourney() {
  const createFixture = useRuntimeProofFixture(afterEach);
  // The wire check below reports every break; the in-process assertion would stop at the first.
  let assertSetting: string | undefined;
  beforeEach(() => {
    assertSetting = process.env.OPENCLAW_PROMPT_CACHE_ASSERT;
    process.env.OPENCLAW_PROMPT_CACHE_ASSERT = "0";
  });
  afterEach(() => {
    process.env.OPENCLAW_PROMPT_CACHE_ASSERT = assertSetting;
  });
  return async (api: Api) => {
    const fixture = await createFixture(`openclaw-prefix-stability-${api}-`, TOKEN, "1");
    const targetRequests: WireRequest[] = [];
    const seen: string[] = [];
    let ordinal = 0;
    const script = (request: WireRequest): Reply => {
      const latest = lastMessage(request);
      const toolResult = hasToolResult(latest);
      if (request.tools === "[]") {
        return { text: "Summary: the session ran the probe journey." };
      }
      if (request.text.includes(`session=${SENDER}`)) {
        return toolResult || !latest.includes("forward a ping")
          ? { text: "REPLY_SKIP" }
          : {
              tool: "sessions_send",
              args: { sessionKey: TARGET, message: "INTER-SESSION ping", timeoutSeconds: 0 },
            };
      }
      if (!request.text.includes(`session=${TARGET}`)) {
        return { text: "child-done" };
      }
      targetRequests.push(request);
      if (toolResult) {
        return { text: "acknowledged" };
      }
      if (latest.includes("STEP-EXEC")) {
        return {
          tool: "exec",
          args: { command: "sleep 1; echo exec-finished", background: true },
        };
      }
      if (latest.includes("STEP-SILENT")) {
        return { text: "NO_REPLY" };
      }
      if (latest.includes("STEP-SPAWN")) {
        return {
          tool: "sessions_spawn",
          args: { task: "CHILD-TASK reply child-done", expectsCompletionMessage: true },
        };
      }
      return { text: `ok ${targetRequests.length}` };
    };
    const server = createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        const wire = readWireRequest(api, JSON.parse(body) as Record<string, unknown>);
        const reply = script(wire);
        const session = /session=(\S+)/.exec(wire.text)?.[1] ?? "?";
        seen.push(`${session} last=${lastMessage(wire).slice(-300)} -> ${JSON.stringify(reply)}`);
        writeReply(api, response, reply, ++ordinal);
      });
    });
    let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
    let transportEnv: ReturnType<typeof captureEnv> | undefined;
    try {
      const provider = buildFakeProvider(api, await listenProofProvider(server));
      const runtime = fakeTransportRuntime(api);
      transportEnv = captureEnv(Object.keys(runtime.env));
      for (const [key, value] of Object.entries(runtime.env)) {
        setTestEnvValue(key, value);
      }
      if (runtime.pluginId) {
        // The owning bundled plugin registers this transport.
        deleteTestEnvValue("OPENCLAW_DISABLE_BUNDLED_PLUGINS");
        deleteTestEnvValue("OPENCLAW_BUNDLED_PLUGINS_DIR");
      }
      await fs.writeFile(path.join(fixture.workspaceDir, "AGENTS.md"), "# Rules\n- Be brief.\n");
      const cfg = fixture.config(
        provider,
        {
          compaction: {
            mode: "default",
            keepRecentTokens: 1,
            recentTurnsPreserve: 0,
            memoryFlush: { enabled: false },
          },
        },
        {
          plugins: runtime.pluginId
            ? {
                allow: [runtime.pluginId],
                entries: { [runtime.pluginId]: { enabled: true } },
                slots: { memory: "none" },
              }
            : { enabled: false },
          tools: {
            codeMode: { enabled: false },
            toolSearch: false,
            exec: { host: "gateway", security: "full", ask: "off", notifyOnExit: true },
          },
        },
      );
      gateway = await startGatewayWithClient({
        cfg,
        configPath: fixture.configPath,
        token: TOKEN,
        clientDisplayName: "prefix-stability",
      });
      const client = gateway.client;
      // Background work (exec wakes, child completions) settles once requests stop arriving.
      const settle = async () => {
        await waitForGatewayActiveWork(20_000);
        let count = -1;
        for (let rounds = 0; count !== seen.length && rounds < 20; rounds++) {
          count = seen.length;
          await new Promise((resolve) => {
            setTimeout(resolve, 1_500);
          });
        }
      };
      const send = async (sessionKey: string, message: string) => {
        const started = await client.request<{ runId?: string }>("chat.send", {
          sessionKey,
          message,
          deliver: false,
          idempotencyKey: `prefix-stability-${api}-${++ordinal}`,
        });
        const waited = await client.request(
          "agent.wait",
          { runId: started.runId, timeoutMs: 60_000 },
          { timeoutMs: 65_000 },
        );
        seen.push(
          `send ${sessionKey} ${message}: ${JSON.stringify(started)} ${JSON.stringify(waited)}`,
        );
        await settle();
      };
      const until = async (predicate: () => boolean) => {
        const deadline = Date.now() + 60_000;
        while (!predicate()) {
          expect(Date.now(), seen.join("\n")).toBeLessThan(deadline);
          await new Promise((resolve) => {
            setTimeout(resolve, 100);
          });
        }
        await settle();
      };

      try {
        await send(TARGET, "TARGET first user turn");
        // Exec completion wakes the session with a host system turn.
        await send(TARGET, "STEP-EXEC run the probe in the background");
        await until(() => targetRequests.some((r) => lastMessage(r).includes("exec-finished")));
        // A subagent settles back into the session.
        await send(TARGET, "STEP-SPAWN start a child");
        await until(() => targetRequests.some((r) => lastMessage(r).includes("child-done")));
        // Inter-session input from another session.
        await send(SENDER, "forward a ping to the target");
        await until(() => targetRequests.some((r) => lastMessage(r).includes("INTER-SESSION")));
        // A skill appears and a workspace bootstrap file changes mid-session.
        const skillDir = path.join(fixture.workspaceDir, "skills", "probe-skill");
        await fs.mkdir(skillDir, { recursive: true });
        await fs.writeFile(
          path.join(skillDir, "SKILL.md"),
          "---\nname: probe-skill\ndescription: Probe skill added mid-session.\n---\n\nReply probe.\n",
        );
        await send(TARGET, "TARGET after skill");
        await fs.appendFile(path.join(fixture.workspaceDir, "AGENTS.md"), "- Prefer bullets.\n");
        // A silent reply to a turn that also carried the workspace update, then the next turn.
        await send(TARGET, "STEP-SILENT after workspace edit");
        await send(TARGET, "TARGET after silent turn");
        // Explicit compaction is the one allowed rebuild point in this journey.
        await client.request("sessions.compact", { key: TARGET }, { timeoutMs: 65_000 });
        await settle();
        const compactionAt = targetRequests.length;
        await send(TARGET, "TARGET after compaction");
        expect(targetRequests.length).toBeGreaterThan(compactionAt);
        const breaks = prefixBreaks(targetRequests);
        expect(
          breaks.map(({ at }) => at),
          JSON.stringify(breaks, null, 2),
        ).toEqual([compactionAt]);
      } catch (error) {
        throw new Error(`${String(error)}\n${seen.join("\n")}`, { cause: error });
      }
    } finally {
      await fixture.close(gateway, server, true);
      transportEnv?.restore();
    }
  };
}
