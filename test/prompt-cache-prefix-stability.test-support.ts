// One Gateway session through every mid-session trigger: each provider request must extend the
// previous one byte for byte, except at a compaction (explicit, or the provider's own). Triggers
// include a steer into a running tool call, a scheduled job that comes due in the chat, and an
// unrelated chat that overflows its window and compacts while the target runs. Its hidden
// subagent, which later receives a parent turn, must stay append-only too.
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
  hasToolResult as containsToolResult,
  latestInput as lastMessage,
  readWireRequest,
  toolNames,
  withoutTools,
  writeReply,
  type FakeReply as Reply,
  type FakeTransport as Api,
  type WireRequest,
} from "./helpers/fake-model-transports.js";
import { listenProofProvider, useRuntimeProofFixture } from "./runtime-proof.test-support.js";

const TOKEN = "prefix-stability-token";
const TARGET = "agent:main:prefix-stability-target";
const SENDER = "agent:main:prefix-stability-sender";
// An unrelated chat on a small context window: its tool results overflow, then it compacts
// while the target runs.
const OTHER = "agent:other:prefix-stability-other";
// A chat whose first turn is a scheduled job; its next owner turn must list the same tools.
const CRON_FIRST = "agent:main:prefix-stability-cron-first";
// Main adds `message` on that owner turn (13 -> 14 tools); its owner lists one tool set from a
// series' first request. The journey requires the growth, so it fails once the owner lands until
// this entry goes.
const CRON_FIRST_GROWTH = {
  tools: ["message"],
  owner: "https://github.com/openclaw/openclaw/pull/201710",
};
const OVERFLOW_CHUNKS = 24;
const OVERFLOW_CHUNK_CHARS = 8_000;

/** True when `current` is `previous` with each changed message passing `changed`, plus new ones. */
function onlyMessagesChanged(
  previous: WireRequest,
  current: WireRequest,
  changed: (before: string, after: string) => boolean,
): boolean {
  return (
    previous.system === current.system &&
    previous.tools === current.tools &&
    current.messages.length >= previous.messages.length &&
    previous.messages.every(
      (message, index) =>
        current.messages[index] === message || changed(message, current.messages[index]!),
    )
  );
}

type GeminiParts = { parts?: Array<{ functionResponse?: { response?: { output?: unknown } } }> };

/** True when `after` is `before` with only shortened, truncation-marked tool outputs. */
function outputTrimmed(before: string, after: string): boolean {
  const original = JSON.parse(before) as GeminiParts;
  const trimmed = JSON.parse(after) as GeminiParts;
  let changed = false;
  for (const [index, part] of (trimmed.parts ?? []).entries()) {
    const response = part.functionResponse?.response;
    const full = original.parts?.[index]?.functionResponse?.response?.output;
    const output = response?.output;
    // The kept text around the notice must be the original's head and tail. The notice itself
    // can be cut short at the end of the output.
    const notice =
      typeof output === "string"
        ? /\s*\[\.\.\. \d+ more characters truncated(?:[^\]]*\]\s*|[^\]]*$)/.exec(output)
        : null;
    if (
      response &&
      notice &&
      typeof output === "string" &&
      typeof full === "string" &&
      output.length < full.length &&
      full.startsWith(output.slice(0, notice.index)) &&
      full.endsWith(output.slice(notice.index + notice[0].length))
    ) {
      // Restore the known change; everything else in the message must still match.
      response.output = full;
      changed = true;
    }
  }
  return changed && JSON.stringify(trimmed) === before;
}

// Gemini replay also drops the call id of the merged call and of its result; the merged side must
// carry no id, not a different one.
const withoutCallIds = (message: string) =>
  message.replace(/("function(?:Call|Response)":\{.*?),"id":"[^"]*"\}/g, "$1}");

/**
 * True when `current` is `previous` with the text-only assistant message at the first change and
 * the tool-call message after it merged into one message, plus new messages.
 */
function cronReplyMerged(previous: WireRequest, current: WireRequest): boolean {
  const at = previous.messages.findIndex((message, index) => current.messages[index] !== message);
  if (at < 0 || previous.system !== current.system || previous.tools !== current.tools) {
    return false;
  }
  const reply = JSON.parse(previous.messages[at]!) as Record<string, unknown>;
  const call = JSON.parse(previous.messages[at + 1] ?? "{}") as Record<string, unknown>;
  const merged = Array.isArray(call.tool_calls)
    ? { ...reply, tool_calls: call.tool_calls }
    : Array.isArray(reply.parts) && Array.isArray(call.parts)
      ? { ...reply, parts: [...reply.parts, ...call.parts] }
      : undefined;
  return (
    /"text":"ok \d+"/.test(previous.messages[at]!) &&
    merged !== undefined &&
    current.messages[at] === withoutCallIds(JSON.stringify(merged)) &&
    previous.messages
      .slice(at + 2)
      .every(
        (message, index) =>
          current.messages[at + 1 + index] === message ||
          (index === 0 && current.messages[at + 1] === withoutCallIds(message)),
      )
  );
}

// The cron reply is written twice: the scheduled turn's own reply, and an automation-result copy
// (src/auto-reply/reply/session-event-automation.ts) that is stored pending
// (context_eligible=0) while the cron run is active, then placed into model context by the next
// request (src/agents/sessions/background-result-placement.ts). On every route the request after
// the next user turn carries the reply twice; Chat Completions and Gemini then merge the copy
// with the following tool-call message.
const CRON_REPLY_TWICE = "https://github.com/openclaw/openclaw/pull/201838";
// Breaks that main still has. Each entry checks the whole request, so its known change cannot hide
// another one. Remove an entry when its owner lands; the journey then fails until it goes.
export const KNOWN_BREAKS: ReadonlyArray<{
  api: Api;
  chat: "target" | "other";
  accepts: (previous: WireRequest, current: WireRequest) => boolean;
  owner: string;
}> = [
  {
    // The pre-request pressure check trims tool results that earlier requests already sent.
    api: "google-generative-ai",
    chat: "other",
    accepts: (previous, current) => onlyMessagesChanged(previous, current, outputTrimmed),
    owner: "https://github.com/openclaw/openclaw/pull/199530",
  },
  { api: "openai-completions", chat: "target", accepts: cronReplyMerged, owner: CRON_REPLY_TWICE },
  {
    api: "google-generative-ai",
    chat: "target",
    accepts: cronReplyMerged,
    owner: CRON_REPLY_TWICE,
  },
];

/** Requests that do not extend the previous request in the same session, with the first change. */
function prefixBreaks(
  requests: readonly WireRequest[],
  isKnown: (previous: WireRequest, current: WireRequest) => boolean = () => false,
): Array<{ at: number; change: string }> {
  const breaks: Array<{ at: number; change: string }> = [];
  for (let index = 1; index < requests.length; index++) {
    const previous = requests[index - 1]!;
    const current = requests[index]!;
    if (isKnown(previous, current)) {
      continue;
    }
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
    // Cron stays on: a scheduled job runs into the target chat when it comes due.
    const fixture = await createFixture(`openclaw-prefix-stability-${api}-`, TOKEN, "0");
    const targetRequests: WireRequest[] = [];
    // The hidden subagent: its spawn task turn has no inter-session provenance, later turns do.
    const childRequests: WireRequest[] = [];
    // The journey step that was active when each target request arrived, for failure reports.
    const targetSteps: string[] = [];
    let step = "first turn";
    const slowSteps = new Set<string>();
    const otherRequests: WireRequest[] = [];
    const cronFirstRequests: WireRequest[] = [];
    let childKey: string | undefined;
    const seen: string[] = [];
    let ordinal = 0;
    // Sessions the journey does not expect; every request must belong to a known chat.
    const unclassified: string[] = [];
    const script = (request: WireRequest): Reply => {
      const latest = lastMessage(request);
      const hasToolResult = containsToolResult(latest);
      // The request's own session leads its system prompt; later text can name the child. Only a
      // compaction summary request has none.
      const session = /session=([^\s"\\|]+)/.exec(request.text)?.[1];
      if (!session) {
        return { text: "Summary: the session ran the probe journey." };
      }
      if (session === OTHER) {
        otherRequests.push(request);
        const chunk = Number(/overflow-chunk-(\d+)/.exec(latest)?.[1] ?? 0);
        if (
          hasToolResult ? chunk > 0 && chunk < OVERFLOW_CHUNKS : latest.includes("STEP-OVERFLOW")
        ) {
          return {
            tool: "exec",
            args: { command: `yes overflow-chunk-${chunk + 1} | head -c ${OVERFLOW_CHUNK_CHARS}` },
          };
        }
        return { text: `other ${otherRequests.length}` };
      }
      if (session === CRON_FIRST) {
        cronFirstRequests.push(request);
        return { text: "ok" };
      }
      if (session === SENDER) {
        return hasToolResult || !latest.includes("forward a ping")
          ? { text: "REPLY_SKIP" }
          : {
              tool: "sessions_send",
              args: { sessionKey: TARGET, message: "INTER-SESSION ping", timeoutSeconds: 0 },
            };
      }
      const child = session.startsWith("agent:main:subagent:") ? session : undefined;
      if (child) {
        childKey ??= child;
        if (child === childKey) {
          childRequests.push(request);
        }
        return { text: "child-done" };
      }
      if (session !== TARGET) {
        unclassified.push(session);
        return { text: "child-done" };
      }
      targetRequests.push(request);
      targetSteps.push(step);
      if (hasToolResult) {
        return { text: "acknowledged" };
      }
      if (latest.includes("STEP-CHILD-FOLLOWUP") && childKey) {
        return {
          tool: "sessions_send",
          args: { sessionKey: childKey, message: "CHILD-FOLLOWUP ping", timeoutSeconds: 0 },
        };
      }
      // Matched anywhere in the request: a late transcript entry must not hide the step.
      const slow = [...request.text.matchAll(/STEP-SLOW [a-z ]+/g)]
        .map(([match]) => match)
        .find((match) => !slowSteps.has(match));
      if (slow) {
        // A foreground tool call keeps the run active until the journey releases it.
        const gate = path.join(fixture.workspaceDir, `release-${slowSteps.size}`);
        slowSteps.add(slow);
        return {
          tool: "exec",
          args: { command: `until [ -f '${gate}' ]; do sleep 0.1; done; echo slow-finished` },
        };
      }
      if (latest.includes("STEP-EXEC")) {
        return {
          tool: "exec",
          args: { command: "sleep 1; echo exec-finished", background: true },
        };
      }
      if (latest.includes("STEP-PROVIDER-COMPACT")) {
        return { text: `ok ${targetRequests.length}`, compaction: true };
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
        const json = JSON.parse(body) as Record<string, unknown>;
        const wire = readWireRequest(api, json);
        const reply = script(wire);
        const session = /session=(\S+)/.exec(wire.text)?.[1] ?? "?";
        seen.push(
          `${session} bytes=${body.length} last=${lastMessage(wire).slice(-300)} -> ${JSON.stringify(reply)}`,
        );
        writeReply(api, response, reply, ++ordinal, {
          inputTokens: Math.ceil(body.length / 4),
          listed: toolNames(wire.tools),
          ...(typeof json.model === "string" ? { model: json.model } : {}),
        });
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
          diagnostics: { cacheTrace: { enabled: true } },
          plugins: runtime.pluginId
            ? {
                allow: [runtime.pluginId],
                entries: { [runtime.pluginId]: { enabled: true } },
                slots: { memory: "none" },
              }
            : { enabled: false },
          tools: {
            // The default surface: Tool Search on.
            codeMode: { enabled: false },
            exec: { host: "gateway", security: "full", ask: "off", notifyOnExit: true },
          },
        },
      );
      // The unrelated chat belongs to an exec-only agent on a small window, so a few large
      // tool results reach the pressure check.
      cfg.agents!.ownership = "explicit";
      cfg.agents!.entries!.other = {
        model: { primary: provider.smallModelRef },
        tools: { allow: ["exec"] },
      };
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
      const start = (sessionKey: string, message: string) =>
        client.request<{ runId?: string }>("chat.send", {
          sessionKey,
          message,
          deliver: false,
          idempotencyKey: `prefix-stability-${api}-${++ordinal}`,
        });
      const wait = async (label: string, started: { runId?: string }) => {
        const waited = await client.request(
          "agent.wait",
          { runId: started.runId, timeoutMs: 60_000 },
          { timeoutMs: 65_000 },
        );
        seen.push(`send ${label}: ${JSON.stringify(started)} ${JSON.stringify(waited)}`);
      };
      const send = async (sessionKey: string, message: string) => {
        await wait(`${sessionKey} ${message}`, await start(sessionKey, message));
        await settle();
      };
      const reached = async (predicate: () => boolean) => {
        const deadline = Date.now() + 60_000;
        while (!predicate()) {
          expect(Date.now(), seen.join("\n")).toBeLessThan(deadline);
          await new Promise((resolve) => {
            setTimeout(resolve, 100);
          });
        }
      };
      const until = async (predicate: () => boolean) => {
        await reached(predicate);
        await settle();
      };
      const sentToTarget = (marker: string) => targetRequests.some((r) => r.text.includes(marker));

      try {
        await send(TARGET, "TARGET first user turn");
        // Exec completion wakes the session with a host system turn.
        await send(TARGET, "STEP-EXEC run the probe in the background");
        await until(() => targetRequests.some((r) => lastMessage(r).includes("exec-finished")));
        // A subagent settles back into the session.
        await send(TARGET, "STEP-SPAWN start a child");
        await until(() => targetRequests.some((r) => lastMessage(r).includes("child-done")));
        // The parent sends a later turn into its hidden subagent.
        await send(TARGET, "STEP-CHILD-FOLLOWUP ping the child");
        await until(() => childRequests.some((r) => lastMessage(r).includes("CHILD-FOLLOWUP")));
        // Inter-session input from another session.
        await send(SENDER, "forward a ping to the target");
        await until(() => targetRequests.some((r) => lastMessage(r).includes("INTER-SESSION")));
        // A user message steers into the run while its tool call is still running.
        step = "steer";
        const steered = await start(TARGET, "STEP-SLOW steer target");
        await reached(() => sentToTarget("STEP-SLOW steer target"));
        await start(TARGET, "STEER-INPUT arrives mid tool call");
        // The run offers a queued steer to the active turn asynchronously, and the Gateway exposes
        // no signal for that offer (the pending input looks the same before and after). Hold the
        // tool for 3 s, which covered every local run; a release on acceptance alone lost the race.
        await new Promise((resolve) => {
          setTimeout(resolve, 3_000);
        });
        await fs.writeFile(path.join(fixture.workspaceDir, "release-0"), "");
        await wait("steer", steered);
        await until(() => sentToTarget("STEER-INPUT"));
        // The steered input joins the same run, right after the tool result it waited for.
        expect(
          targetRequests.some((r) => /slow-finished[\s\S]*STEER-INPUT/.test(lastMessage(r))),
        ).toBe(true);
        step = "cron";
        const cronJob = {
          agentId: "main",
          name: "prefix-stability cron",
          enabled: true,
          schedule: { kind: "at", at: new Date(Date.now() + 3_000).toISOString() },
          // Keep the run record for the wait below; the job is removed afterwards.
          deleteAfterRun: false,
          sessionTarget: `session:${TARGET}`,
          wakeMode: "now",
          payload: { kind: "agentTurn", message: "CRON-TICK scheduled turn" },
          delivery: { mode: "none" },
        };
        if (api === "bedrock-converse-stream") {
          // Intended behavior: a scheduled job needs a stored inference account, and a provider
          // that authenticates through the AWS SDK has none, so cron.add refuses it.
          await expect(client.request("cron.add", cronJob)).rejects.toThrow(
            /requires a stored inference account/,
          );
        } else {
          // A scheduled job comes due and runs in the target chat (`cron.run` would skip the
          // trigger).
          const cronDeadline = Date.now() + 60_000;
          const job = await client.request<{ id: string }>("cron.add", cronJob);
          await reached(() => sentToTarget("CRON-TICK"));
          // The scheduled run settles (its result reaches the chat) before the next step.
          for (let runs: { entries: unknown[] } = { entries: [] }; runs.entries.length === 0;) {
            expect(Date.now(), seen.join("\n")).toBeLessThan(cronDeadline);
            await new Promise((resolve) => {
              setTimeout(resolve, 200);
            });
            runs = await client.request("cron.runs", { id: job.id, limit: 1 });
          }
          await settle();
          await client.request("cron.remove", { id: job.id });
          step = "cron-first chat";
          const first = await client.request<{ id: string }>("cron.add", {
            ...cronJob,
            sessionTarget: `session:${CRON_FIRST}`,
            schedule: { kind: "at", at: new Date(Date.now() + 3_000).toISOString() },
          });
          await reached(() => cronFirstRequests.length > 0);
          await settle();
          await client.request("cron.remove", { id: first.id });
          await send(CRON_FIRST, "OWNER turn after a scheduled first turn");
          const owner = cronFirstRequests.at(-1)!;
          expect(owner.text).toContain("OWNER turn after a scheduled first turn");
          // Whole declarations in order; only the known growth, which must still occur, may differ.
          const names = cronFirstRequests.map((request) => toolNames(request.tools).join(","));
          expect(
            toolNames(cronFirstRequests[0]!.tools).filter((name) =>
              CRON_FIRST_GROWTH.tools.includes(name),
            ),
            names[0],
          ).toEqual([]);
          expect(toolNames(owner.tools), names.at(-1)).toEqual(
            expect.arrayContaining(CRON_FIRST_GROWTH.tools),
          );
          const cronFirstBreaks = prefixBreaks(
            cronFirstRequests.map((request) =>
              request === owner ? withoutTools(request, CRON_FIRST_GROWTH.tools) : request,
            ),
          );
          expect(cronFirstBreaks, JSON.stringify(cronFirstBreaks, null, 2)).toEqual([]);
        }
        // An unrelated chat on a small window: its tool results fill the window inside one run,
        // and the pressure check before the next request acts.
        step = "other chat overflow";
        await send(OTHER, "OTHER first turn");
        const overflowStartAt = otherRequests.length;
        await send(OTHER, "STEP-OVERFLOW read large output");
        const overflowEndAt = otherRequests.length;
        // The unrelated chat compacts while the target is mid tool call.
        step = "other chat compacts during a target run";
        const busy = await start(TARGET, "STEP-SLOW while another chat compacts");
        await reached(() => sentToTarget("STEP-SLOW while another chat compacts"));
        const busyAt = targetRequests.length;
        await client.request("sessions.compact", { key: OTHER }, { timeoutMs: 65_000 });
        // The target tool call is still held open.
        expect(targetRequests.length).toBe(busyAt);
        await fs.writeFile(path.join(fixture.workspaceDir, "release-1"), "");
        await wait("busy", busy);
        await settle();
        const otherCompactionAt = otherRequests.length;
        await send(OTHER, "OTHER after compaction");
        // A skill appears and a workspace bootstrap file changes mid-session.
        step = "skill and workspace edit";
        const skillDir = path.join(fixture.workspaceDir, "skills", "probe-skill");
        await fs.mkdir(skillDir, { recursive: true });
        await fs.writeFile(
          path.join(skillDir, "SKILL.md"),
          "---\nname: probe-skill\ndescription: Probe skill added mid-session.\n---\n\nReply probe.\n",
        );
        await send(TARGET, "TARGET after skill");
        await fs.appendFile(path.join(fixture.workspaceDir, "AGENTS.md"), "- Prefer bullets.\n");
        await send(TARGET, "TARGET after workspace edit");
        // The provider compacts on its own (Responses server-side compaction): its checkpoint
        // replaces the history it summarized from the next request on, an allowed rebuild point.
        const providerCompactionAt =
          api === "openai-responses"
            ? await (async () => {
                await send(TARGET, "STEP-PROVIDER-COMPACT continue");
                const at = targetRequests.length;
                await send(TARGET, "TARGET after provider compaction");
                return at;
              })()
            : undefined;
        // Explicit compaction is the one allowed rebuild point in this journey.
        step = "explicit compaction";
        await client.request("sessions.compact", { key: TARGET }, { timeoutMs: 65_000 });
        await settle();
        const compactionAt = targetRequests.length;
        await send(TARGET, "TARGET after compaction");
        expect(targetRequests.length).toBeGreaterThan(compactionAt);
        // The unrelated chat rebuilds only at its compactions: the one its pressure check ran
        // inside the overflow run, and the explicit one. A silent rewrite of a tool result
        // it already sent would show as another break.
        const matched = new Set<(typeof KNOWN_BREAKS)[number]>();
        const isKnown =
          (chat: "target" | "other") => (previous: WireRequest, current: WireRequest) => {
            const known = KNOWN_BREAKS.find(
              (entry) =>
                entry.api === api && entry.chat === chat && entry.accepts(previous, current),
            );
            if (known) {
              matched.add(known);
            }
            return known !== undefined;
          };
        const allOtherBreaks = prefixBreaks(otherRequests);
        const otherMessage = JSON.stringify(allOtherBreaks, null, 2);
        const inOverflow = ({ at }: { at: number }) => at > overflowStartAt && at < overflowEndAt;
        // The pressure check acted inside the overflow run.
        expect(allOtherBreaks.some(inOverflow), otherMessage).toBe(true);
        const otherBreaks = prefixBreaks(otherRequests, isKnown("other"));
        expect(
          otherBreaks.map(({ at }) => at),
          otherMessage,
        ).toEqual([
          ...otherBreaks
            .filter(inOverflow)
            .slice(0, 1)
            .map(({ at }) => at),
          otherCompactionAt,
        ]);
        for (const { at } of otherBreaks) {
          // The summary leads the rebuilt history (after the instructions item on Responses).
          expect(otherRequests[at]!.messages.slice(0, 2).join("\n"), otherMessage).toContain(
            "compacted into the following summary",
          );
        }
        expect(unclassified).toEqual([]);
        expect(childRequests.length).toBeGreaterThan(1);
        const childBreaks = prefixBreaks(childRequests);
        expect(childBreaks, JSON.stringify(childBreaks, null, 2)).toEqual([]);
        const breaks = prefixBreaks(targetRequests, isKnown("target")).map(({ at, change }) => ({
          at,
          step: targetSteps[at],
          change,
        }));
        expect(
          breaks.map(({ at }) => at),
          JSON.stringify(breaks, null, 2),
        ).toEqual(
          providerCompactionAt === undefined
            ? [compactionAt]
            : [providerCompactionAt, compactionAt],
        );
        // A known break that no longer occurs has landed: remove its entry.
        expect(
          KNOWN_BREAKS.filter((known) => known.api === api && !matched.has(known)).map(
            ({ chat, owner }) => `${chat}: ${owner}`,
          ),
        ).toEqual([]);
        if (providerCompactionAt !== undefined) {
          // The cache observer attributes the provider checkpoint to compaction, not to drift.
          const trace = await fs.readFile(
            path.join(fixture.stateDir, "logs", "cache-trace.jsonl"),
            "utf8",
          );
          const attributed = trace
            .split("\n")
            .filter(Boolean)
            .map(
              (line) =>
                JSON.parse(line) as {
                  stage?: string;
                  sessionKey?: string;
                  options?: { changes?: Array<{ detail?: string }> | null };
                },
            )
            .filter(
              (event) =>
                event.stage === "cache:result" &&
                event.sessionKey === TARGET &&
                event.options?.changes?.some(
                  ({ detail }) =>
                    detail === "provider compaction checkpoint replaced earlier history",
                ),
            );
          expect(attributed).toHaveLength(1);
        }
      } catch (error) {
        throw new Error(`${String(error)}\n${seen.join("\n")}`, { cause: error });
      }
    } finally {
      await fixture.close(gateway, server, true);
      transportEnv?.restore();
    }
  };
}
