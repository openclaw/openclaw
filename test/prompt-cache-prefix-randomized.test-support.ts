// Randomized session journeys: a seeded sequence of every turn kind against one fake transport.
// Every provider request in the target session must extend the previous request of its lineage
// byte for byte (system, tools, messages; cache markers ignored), except at the allowed rebuild
// points: compaction and a model switch.
import fs from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { afterEach, beforeEach, expect } from "vitest";
import type { ToolsConfig } from "../src/config/types.tools.js";
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

const TOKEN = "prefix-randomized-token";
// A 1x1 PNG.
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

export const TURN_KINDS = [
  "user",
  "tool",
  "parallelTools",
  "thinkingTool",
  "imageInput",
  "imageToolResult",
  "execWake",
  "subagent",
  "interSession",
  "skillAdded",
  "workspaceEdit",
  "toolsChanged",
  "silent",
  "compaction",
  "modelSwitch",
] as const;
export type TurnKind = (typeof TURN_KINDS)[number];
// Allowed rebuild points: compaction and a model or provider switch. A deliberate tool-policy
// config change may change the tools and the system prompt that lists them (Hermes starts a new
// session for it), but the history must still only grow.
const REBUILD_KINDS = new Set<TurnKind>(["compaction", "modelSwitch"]);

/** First change of the history (messages only) of `current` against `previous`. */
export function historyChange(previous: WireRequest, current: WireRequest): string | undefined {
  return prefixChange(previous, { ...current, system: previous.system, tools: previous.tools });
}

/** Deterministic PRNG (mulberry32), so a failing seed reproduces exactly. */
function prng(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** A seeded journey of `length` turns that uses every turn kind at least once. */
export function randomJourney(seed: number, length = TURN_KINDS.length + 6): TurnKind[] {
  const random = prng(seed);
  const kinds: TurnKind[] = [...TURN_KINDS];
  while (kinds.length < length) {
    kinds.push(TURN_KINDS[Math.floor(random() * TURN_KINDS.length)]!);
  }
  for (let index = kinds.length - 1; index > 0; index--) {
    const swap = Math.floor(random() * (index + 1));
    [kinds[index], kinds[swap]] = [kinds[swap]!, kinds[index]!];
  }
  // A journey starts and ends with an ordinary turn so every rebuild is followed by a request.
  return ["user", ...kinds, "user"];
}

// The Advisor plugin forks the running session after each tool call (Peanutto runs it). A fork's
// request ends with fork-only items (a placeholder for a running tool, the review question), and
// everything before them is the parent's own history.
const ADVISOR_REVIEW = "You are an advisor reading this conversation";
const FORK_ONLY = new RegExp(`${ADVISOR_REVIEW}|This tool call is still running`);

/** First difference between a fork and the parent's next request, over what the fork shares. */
function forkChange(fork: WireRequest, parent: WireRequest): string | undefined {
  if (fork.system !== parent.system || fork.tools !== parent.tools) {
    return `fork ${prefixChange(parent, { ...fork, messages: parent.messages })}`;
  }
  const shared = fork.messages.findIndex((message) => FORK_ONLY.test(message));
  const end = shared < 0 ? fork.messages.length : shared;
  for (let index = 0; index < end; index++) {
    const own = fork.messages[index]!;
    const theirs = parent.messages[index] ?? "(missing)";
    if (own !== theirs) {
      let at = 0;
      while (own[at] === theirs[at]) {
        at++;
      }
      const around = (text: string) => text.slice(Math.max(0, at - 120), at + 160);
      return `fork message ${index} @${at}: ${around(own)} -> parent ${around(theirs)}`;
    }
  }
  return undefined;
}

/** First change of `current` against `previous`, or undefined when it extends it. */
function prefixChange(previous: WireRequest, current: WireRequest): string | undefined {
  if (previous.system !== current.system) {
    let at = 0;
    while (previous.system[at] === current.system[at]) {
      at++;
    }
    return `system @${at}: ${previous.system.slice(Math.max(0, at - 80), at + 120)} -> ${current.system.slice(Math.max(0, at - 80), at + 120)}`;
  }
  if (previous.tools !== current.tools) {
    // Gemini groups its declarations under `functionDeclarations`.
    const byName = (tools: string) =>
      new Map(
        (JSON.parse(tools) as Array<Record<string, unknown>>)
          .flatMap((tool) =>
            Array.isArray(tool.functionDeclarations)
              ? (tool.functionDeclarations as Array<Record<string, unknown>>)
              : [tool],
          )
          .map((tool) => [toolName(tool), JSON.stringify(tool)]),
      );
    const before = byName(previous.tools);
    const after = byName(current.tools);
    const added = [...after.keys()].filter((name) => !before.has(name));
    const removed = [...before.keys()].filter((name) => !after.has(name));
    const changed = [...after.keys()].filter(
      (name) => before.has(name) && before.get(name) !== after.get(name),
    );
    const order = added.length + removed.length + changed.length === 0 ? " (order)" : "";
    return `tools added=${added.join(",")} removed=${removed.join(",")} changed=${changed.join(",")}${order}`;
  }
  const message = previous.messages.findIndex(
    (entry, position) => current.messages[position] !== entry,
  );
  if (message < 0) {
    return undefined;
  }
  // Show the start of both messages (their kind) and the bytes around the first difference.
  const own = previous.messages[message]!;
  const theirs = current.messages[message] ?? "(removed)";
  let at = 0;
  while (own[at] === theirs[at]) {
    at++;
  }
  const around = (text: string) => text.slice(Math.max(0, at - 80), at + 120);
  return `message ${message}: ${own.slice(0, 120)} -> ${theirs.slice(0, 120)} @${at}: ${around(own)} -> ${around(theirs)}`;
}

// Tools that main still adds mid-session. The request must equal its predecessor once only these
// tools are taken out, so the known change cannot hide another one. Remove an entry when its owner
// lands; the suite then fails until it goes.
const KNOWN_TOOL_ADDITIONS: ReadonlyArray<{ tools: readonly string[]; owner: string }> = [
  {
    // After a switch to a second provider, turns started by a subagent completion or an
    // inter-session message list two more tools than user turns do.
    tools: ["skills_read", "skills_search"],
    owner: "https://github.com/openclaw/openclaw/pull/201710",
  },
];

const toolName = (tool: Record<string, unknown>) =>
  String(
    tool.name ??
      (tool.function as { name?: unknown } | undefined)?.name ??
      (tool.toolSpec as { name?: unknown } | undefined)?.name,
  );

/** `request` without the named tools (Gemini nests them under `functionDeclarations`). */
function withoutTools(request: WireRequest, names: readonly string[]): WireRequest {
  const keep = (tool: Record<string, unknown>) => !names.includes(toolName(tool));
  const tools = (JSON.parse(request.tools) as Array<Record<string, unknown>>).filter(keep);
  for (const tool of tools) {
    // A fresh parse, so changing it in place is safe; the key keeps its position.
    if (Array.isArray(tool.functionDeclarations)) {
      tool.functionDeclarations = (
        tool.functionDeclarations as Array<Record<string, unknown>>
      ).filter(keep);
    }
  }
  return { ...request, tools: JSON.stringify(tools) };
}

/** First change of `current` against `previous` that no known tool addition explains. */
export function unknownChange(previous: WireRequest, current: WireRequest): string | undefined {
  let change = prefixChange(previous, current);
  for (const known of KNOWN_TOOL_ADDITIONS) {
    const rest = prefixChange(previous, withoutTools(current, known.tools));
    if (change?.startsWith("tools ") && !rest?.startsWith("tools ")) {
      // Only the known tools changed the list; any other change still fails.
      change = rest;
    }
  }
  return change;
}

// Accepted on main (closed https://github.com/openclaw/openclaw/pull/201654: no production impact
// on our hosts): a silent reply is dropped from replay, so the user turns around it merge into one
// message. Bedrock merges every adjacent user pair. Chat Completions keeps a Gateway turn with a
// runtime-context block apart and merges only user turns without that carrier: here the
// "System prompt update" notes after a skill or workspace edit, exec-wake and other host system
// turns, and the inter-session and subagent-completion inputs.
const SILENT_MERGE_APIS = new Set<Api>(["bedrock-converse-stream", "openai-completions"]);

/**
 * True when `current` differs from `previous` only by that merge: the first changed message is a
 * user message whose content blocks start with the old ones, the extra blocks are the following
 * old user messages, and every later message is unchanged.
 */
function isSilentTurnMerge(previous: WireRequest, current: WireRequest): boolean {
  if (previous.system !== current.system || previous.tools !== current.tools) {
    return false;
  }
  const at = previous.messages.findIndex((entry, index) => current.messages[index] !== entry);
  const blocks = (message: string | undefined) => {
    const parsed = message ? (JSON.parse(message) as { role?: unknown; content?: unknown }) : {};
    return parsed.role === "user" && Array.isArray(parsed.content)
      ? parsed.content.map((block) => JSON.stringify(block))
      : undefined;
  };
  const before = blocks(previous.messages[at]);
  const after = blocks(current.messages[at]);
  if (!before || !after || after.length <= before.length) {
    return false;
  }
  if (before.some((block, index) => after[index] !== block)) {
    return false;
  }
  let extra = after.slice(before.length);
  let next = at + 1;
  while (extra.length > 0) {
    const merged = blocks(previous.messages[next]);
    if (!merged || merged.some((block, index) => extra[index] !== block)) {
      // The rest of the extra blocks belong to the new turn; nothing older may follow.
      return next === previous.messages.length;
    }
    extra = extra.slice(merged.length);
    next++;
  }
  return previous.messages
    .slice(next)
    .every((entry, index) => current.messages[at + 1 + index] === entry);
}

// What each tool and image step must deliver to the provider, so a step that silently degrades
// (a failed read, a dropped image) fails even when the prefix stays append-only.
const readResult = (input: string) =>
  hasToolResult(input) && input.includes("alpha") && input.includes("beta");
const IMAGE_BLOCK = /"type":"image"|image_url|input_image|inlineData|"image":\{/;
const THINKING = "Reading the notes first.";
const STEP_EVIDENCE: Partial<Record<TurnKind, (requests: WireRequest[], api: Api) => boolean>> = {
  tool: (requests) => requests.some((r) => readResult(lastMessage(r))),
  // On Anthropic the signed thinking of the tool call must reach the continuation request, which
  // also proves that the request enabled thinking.
  thinkingTool: (requests, api) =>
    requests.some(
      (r) =>
        readResult(lastMessage(r)) &&
        (api !== "anthropic-messages" ||
          r.messages.some(
            (m) => m.includes(`"thinking":"${THINKING}"`) && /"signature":"sig_\d+"/.test(m),
          )),
    ),
  parallelTools: (requests) =>
    requests.some((r) => readResult(lastMessage(r)) && lastMessage(r).includes("parallel")),
  imageInput: (requests) => requests.some((r) => IMAGE_BLOCK.test(lastMessage(r))),
  imageToolResult: (requests) => requests.some((r) => IMAGE_BLOCK.test(lastMessage(r))),
};

export function usePrefixRandomizedJourney() {
  const createFixture = useRuntimeProofFixture(afterEach);
  let assertSetting: string | undefined;
  beforeEach(() => {
    // The wire check reports every break; the in-process assertion would stop at the first.
    assertSetting = process.env.OPENCLAW_PROMPT_CACHE_ASSERT;
    process.env.OPENCLAW_PROMPT_CACHE_ASSERT = "0";
  });
  afterEach(() => {
    process.env.OPENCLAW_PROMPT_CACHE_ASSERT = assertSetting;
  });
  return async (api: Api, seed: number) => {
    const journey = process.env.OPENCLAW_PREFIX_RANDOM_JOURNEY
      ? (process.env.OPENCLAW_PREFIX_RANDOM_JOURNEY.split(",") as TurnKind[])
      : randomJourney(seed);
    const fixture = await createFixture(`openclaw-prefix-random-${api}-${seed}-`, TOKEN, "1");
    // Seeds in one file share a process, and the subagent registry keeps runs in memory by
    // session key past the Gateway that wrote them. Shared keys made the next seed's first turn
    // load a retained child from the previous state dir and fail ("Retained subagent payload is
    // unavailable"), so each seed gets its own sessions.
    const TARGET = `agent:main:prefix-randomized-target-${seed}`;
    const SENDER = `agent:main:prefix-randomized-sender-${seed}`;
    // Target requests in order, each tagged with the step that sent it.
    const target: Array<{ step: number; kind: TurnKind; request: WireRequest; fork?: boolean }> =
      [];
    const seen: string[] = [];
    const children = new Map<string, Array<{ step: number; request: WireRequest }>>();
    let step = -1;
    let ordinal = 0;
    const script = (request: WireRequest, thinkingEnabled: boolean): Reply => {
      const latest = lastMessage(request);
      const toolResult = hasToolResult(latest);
      if (latest.includes(ADVISOR_REVIEW)) {
        if (request.text.includes(`session=${TARGET}`)) {
          target.push({ step, kind: journey[step] ?? "user", request, fork: true });
        }
        return { text: "NO_CHANGE" };
      }
      if (request.tools === "[]") {
        return { text: "Summary: the session ran a randomized journey." };
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
        // A spawned child: each of its requests must extend the child's previous one.
        const child = /session=(agent:\S+?)[\s"\\]/.exec(request.text)?.[1];
        if (child) {
          children.set(child, [...(children.get(child) ?? []), { step, request }]);
        }
        return { text: "child-done" };
      }
      target.push({ step, kind: journey[step] ?? "user", request });
      if (toolResult) {
        return { text: `acknowledged ${target.length}` };
      }
      // The newest step marker: a silent reply is not replayed on main, so the turn after it
      // also carries the earlier turn's marker.
      const marker = [...latest.matchAll(/STEP-[A-Z-]+/g)].at(-1)?.[0];
      if (marker === "STEP-PARALLEL") {
        return {
          calls: [
            { tool: "read", args: { path: "notes.txt" } },
            { tool: "exec", args: { command: "echo parallel" } },
          ],
        };
      }
      if (marker === "STEP-THINKING-TOOL") {
        // A model returns signed thinking only when the request enables it.
        return {
          ...(thinkingEnabled ? { thinking: THINKING } : {}),
          calls: [{ tool: "read", args: { path: "notes.txt" } }],
        };
      }
      if (marker === "STEP-TOOL") {
        return { tool: "read", args: { path: "notes.txt" } };
      }
      if (marker === "STEP-IMAGE-TOOL") {
        return { tool: "read", args: { path: "pixel.png" } };
      }
      if (marker === "STEP-EXEC") {
        return { tool: "exec", args: { command: "sleep 1; echo exec-finished", background: true } };
      }
      if (marker === "STEP-SILENT") {
        return { text: "NO_REPLY" };
      }
      if (marker === "STEP-SPAWN") {
        return {
          tool: "sessions_spawn",
          args: { task: "CHILD-TASK reply child-done", expectsCompletionMessage: true },
        };
      }
      return { text: `ok ${target.length}` };
    };
    const server = createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        const parsed = JSON.parse(body) as Record<string, unknown>;
        const wire = readWireRequest(api, parsed);
        const thinking = parsed.thinking as { type?: string } | undefined;
        const reply = script(wire, Boolean(thinking?.type && thinking.type !== "disabled"));
        const session = /session=(\S+)/.exec(wire.text)?.[1] ?? "?";
        seen.push(`${session} last=${lastMessage(wire).slice(-200)} -> ${JSON.stringify(reply)}`);
        writeReply(api, response, reply, ++ordinal);
      });
    });
    let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
    let transportEnv: ReturnType<typeof captureEnv> | undefined;
    try {
      const origin = await listenProofProvider(server);
      const provider = buildFakeProvider(api, origin, { reasoning: true });
      // A second provider on the same transport for the provider-switch step.
      const alternate = { ...provider, providerId: `${provider.providerId}-alt` };
      const alternateRef = `${alternate.providerId}/${provider.modelRef.split("/").slice(1).join("/")}`;
      const runtime = fakeTransportRuntime(api);
      transportEnv = captureEnv(Object.keys(runtime.env));
      for (const [key, value] of Object.entries(runtime.env)) {
        setTestEnvValue(key, value);
      }
      // Bundled plugins load for the transport plugin and the Advisor.
      deleteTestEnvValue("OPENCLAW_DISABLE_BUNDLED_PLUGINS");
      deleteTestEnvValue("OPENCLAW_BUNDLED_PLUGINS_DIR");
      await fs.writeFile(path.join(fixture.workspaceDir, "AGENTS.md"), "# Rules\n- Be brief.\n");
      await fs.writeFile(path.join(fixture.workspaceDir, "notes.txt"), "alpha\nbeta\n");
      await fs.writeFile(
        path.join(fixture.workspaceDir, "pixel.png"),
        Buffer.from(PNG_BASE64, "base64"),
      );
      const tools = (webFetch: boolean): ToolsConfig => ({
        codeMode: { enabled: false },
        toolSearch: false,
        exec: { host: "gateway", security: "full", ask: "off", notifyOnExit: true },
        ...(webFetch ? {} : { deny: ["web_fetch"] }),
      });
      const cfg = fixture.config(
        provider,
        {
          thinkingDefault: "low",
          compaction: {
            mode: "default",
            keepRecentTokens: 1,
            recentTurnsPreserve: 0,
            memoryFlush: { enabled: false },
          },
        },
        {
          plugins: {
            allow: ["advisor", ...(runtime.pluginId ? [runtime.pluginId] : [])],
            entries: {
              advisor: { enabled: true, config: { everyToolCalls: 1, everyMinutes: 0 } },
              ...(runtime.pluginId ? { [runtime.pluginId]: { enabled: true } } : {}),
            },
            slots: { memory: "none" },
          },
          tools: tools(false),
        },
      );
      cfg.models!.providers![alternate.providerId] = alternate.config;
      const writeTools = async (webFetch: boolean) => {
        const current = JSON.parse(await fs.readFile(fixture.configPath, "utf8")) as Record<
          string,
          unknown
        >;
        await fs.writeFile(
          fixture.configPath,
          JSON.stringify({ ...current, tools: tools(webFetch) }, null, 2),
        );
      };
      gateway = await startGatewayWithClient({
        cfg,
        configPath: fixture.configPath,
        token: TOKEN,
        clientDisplayName: "prefix-randomized",
      });
      const client = gateway.client;
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
      const send = async (sessionKey: string, message: string, attachments?: unknown[]) => {
        const started = await client.request<{ runId?: string }>("chat.send", {
          sessionKey,
          message,
          deliver: false,
          idempotencyKey: `prefix-random-${api}-${seed}-${++ordinal}`,
          ...(attachments ? { attachments } : {}),
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
      let toolsWidened = false;
      let switched = false;
      try {
        for (step = 0; step < journey.length; step++) {
          const kind = journey[step]!;
          const before = target.length;
          switch (kind) {
            case "user":
              await send(TARGET, `TARGET turn ${step}`);
              break;
            case "tool":
              await send(TARGET, `STEP-TOOL ${step}`);
              break;
            case "parallelTools":
              await send(TARGET, `STEP-PARALLEL ${step}`);
              break;
            case "thinkingTool":
              await send(TARGET, `STEP-THINKING-TOOL ${step}`);
              break;
            case "imageInput":
              await send(TARGET, `TARGET image ${step}`, [
                { type: "image", mimeType: "image/png", content: PNG_BASE64 },
              ]);
              break;
            case "imageToolResult":
              await send(TARGET, `STEP-IMAGE-TOOL ${step}`);
              break;
            case "execWake":
              await send(TARGET, `STEP-EXEC ${step}`);
              await until(() =>
                target.slice(before).some((r) => lastMessage(r.request).includes("exec-finished")),
              );
              break;
            case "subagent":
              await send(TARGET, `STEP-SPAWN ${step}`);
              await until(() =>
                target.slice(before).some((r) => lastMessage(r.request).includes("child-done")),
              );
              break;
            case "interSession":
              await send(SENDER, `forward a ping ${step}`);
              await until(() =>
                target.slice(before).some((r) => lastMessage(r.request).includes("INTER-SESSION")),
              );
              break;
            case "skillAdded": {
              const skillDir = path.join(fixture.workspaceDir, "skills", `probe-skill-${step}`);
              await fs.mkdir(skillDir, { recursive: true });
              await fs.writeFile(
                path.join(skillDir, "SKILL.md"),
                `---\nname: probe-skill-${step}\ndescription: Probe skill added mid-session.\n---\n\nReply probe.\n`,
              );
              await send(TARGET, `TARGET after skill ${step}`);
              break;
            }
            case "workspaceEdit":
              await fs.appendFile(
                path.join(fixture.workspaceDir, "AGENTS.md"),
                `- Rule added at step ${step}.\n`,
              );
              await send(TARGET, `TARGET after workspace edit ${step}`);
              break;
            case "toolsChanged":
              toolsWidened = !toolsWidened;
              await writeTools(toolsWidened);
              // The Gateway reloads config from disk.
              await new Promise((resolve) => {
                setTimeout(resolve, 3_000);
              });
              await send(TARGET, `TARGET after tools change ${step}`);
              // The new tool policy reaches the provider.
              expect(
                target
                  .slice(before)
                  .filter((entry) => !entry.fork)
                  .map((entry) => entry.request.tools.includes('"web_fetch"')),
                `step ${step} toolsChanged`,
              ).toEqual([toolsWidened]);
              break;
            case "silent":
              await send(TARGET, `STEP-SILENT ${step}`);
              break;
            case "compaction":
              await client.request("sessions.compact", { key: TARGET }, { timeoutMs: 65_000 });
              await settle();
              await send(TARGET, `TARGET after compaction ${step}`);
              break;
            case "modelSwitch":
              switched = !switched;
              await client.request("sessions.patch", {
                key: TARGET,
                model: switched ? alternateRef : provider.modelRef,
              });
              await send(TARGET, `TARGET after model switch ${step}`);
              break;
          }
          const evidence = STEP_EVIDENCE[kind];
          if (evidence) {
            expect(
              evidence(
                target.slice(before).map((entry) => entry.request),
                api,
              ),
              `step ${step} ${kind} did not reach the provider\n${seen.join("\n")}`,
            ).toBe(true);
          }
        }
        // Each request is compared with the previous request of the same session; the first
        // request of each rebuild step may start a new prefix.
        const unexpected: Array<{ step: number; kind: TurnKind; change: string }> = [];
        // A fork is a side lineage: the parent chain skips it, and the fork must share the
        // parent's bytes up to its own items.
        const parents = target.filter((entry) => !entry.fork);
        for (let index = 1; index < parents.length; index++) {
          const previous = parents[index - 1]!;
          const current = parents[index]!;
          const firstOfStep = parents.findIndex((entry) => entry.step === current.step) === index;
          const change =
            current.kind === "toolsChanged" && firstOfStep
              ? historyChange(previous.request, current.request)
              : unknownChange(previous.request, current.request);
          const rebuild = REBUILD_KINDS.has(current.kind) && firstOfStep;
          const silentMerge =
            SILENT_MERGE_APIS.has(api) &&
            journey.slice(0, current.step).includes("silent") &&
            isSilentTurnMerge(previous.request, current.request);
          if (change && !rebuild && !silentMerge) {
            unexpected.push({ step: current.step, kind: current.kind, change });
          }
        }
        for (const [child, requests] of children) {
          for (let index = 1; index < requests.length; index++) {
            const change = prefixChange(requests[index - 1]!.request, requests[index]!.request);
            if (change) {
              unexpected.push({
                step: requests[index]!.step,
                kind: "subagent",
                change: `child ${child}: ${change}`,
              });
            }
          }
        }
        for (const [index, fork] of target.entries()) {
          const parent = fork.fork
            ? target.slice(index + 1).find((entry) => !entry.fork)
            : undefined;
          const change = parent ? forkChange(fork.request, parent.request) : undefined;
          if (change) {
            unexpected.push({ step: fork.step, kind: fork.kind, change });
          }
        }
        process.stdout.write(
          `[prefix-random] ${api} seed=${seed} requests=${target.length} forks=${target.filter((entry) => entry.fork).length} children=${[...children.values()].map((requests) => requests.length).join(",")}\n`,
        );
        expect(
          JSON.stringify(unexpected, null, 1),
          `seed=${seed} journey=${journey.join(",")} breaks=${JSON.stringify(unexpected)}`,
        ).toBe("[]");
      } catch (error) {
        throw new Error(`${String(error)}\n${seen.join("\n")}`, { cause: error });
      }
    } finally {
      await fixture.close(gateway, server, true);
      transportEnv?.restore();
    }
  };
}
