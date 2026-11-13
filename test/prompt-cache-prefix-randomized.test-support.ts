// Randomized session journeys: a seeded sequence of every turn kind against one fake transport.
// Every provider request in the target session must extend the previous request of its lineage
// byte for byte (system, tools, messages; cache markers ignored), except at the allowed rebuild
// points: compaction and a model switch.
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

const TOKEN = "prefix-randomized-token";
const TARGET = "agent:main:prefix-randomized-target";
const SENDER = "agent:main:prefix-randomized-sender";
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
// Allowed rebuild points: compaction, a model or provider switch, and a deliberate tool-policy
// config change (a new tool set is a new prefix; Hermes starts a new session for it).
const REBUILD_KINDS = new Set<TurnKind>(["compaction", "modelSwitch", "toolsChanged"]);

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

type Lineage = { requests: WireRequest[] };

/** First change of `current` against `previous`, or undefined when it extends it. */
function prefixChange(previous: WireRequest, current: WireRequest): string | undefined {
  if (previous.system !== current.system) {
    return "system";
  }
  if (previous.tools !== current.tools) {
    return "tools";
  }
  const message = previous.messages.findIndex(
    (entry, position) => current.messages[position] !== entry,
  );
  return message < 0
    ? undefined
    : `message ${message}: ${previous.messages[message]!.slice(0, 200)} -> ${(current.messages[message] ?? "(removed)").slice(0, 200)}`;
}

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
    const journey = randomJourney(seed);
    const fixture = await createFixture(`openclaw-prefix-random-${api}-${seed}-`, TOKEN, "1");
    // Target requests in order, each tagged with the step that sent it.
    const target: Array<{ step: number; kind: TurnKind; request: WireRequest }> = [];
    const seen: string[] = [];
    let step = -1;
    let ordinal = 0;
    const script = (request: WireRequest, thinkingEnabled: boolean): Reply => {
      const latest = lastMessage(request);
      const toolResult = hasToolResult(latest);
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
        return { text: "child-done" };
      }
      target.push({ step, kind: journey[step] ?? "user", request });
      if (toolResult) {
        return { text: `acknowledged ${target.length}` };
      }
      if (latest.includes("STEP-PARALLEL")) {
        return {
          calls: [
            { tool: "read", args: { path: "notes.txt" } },
            { tool: "exec", args: { command: "echo parallel" } },
          ],
        };
      }
      if (latest.includes("STEP-THINKING-TOOL")) {
        // A model returns signed thinking only when the request enables it.
        return {
          ...(thinkingEnabled ? { thinking: "Reading the notes first." } : {}),
          calls: [{ tool: "read", args: { path: "notes.txt" } }],
        };
      }
      if (latest.includes("STEP-TOOL")) {
        return { tool: "read", args: { path: "notes.txt" } };
      }
      if (latest.includes("STEP-IMAGE-TOOL")) {
        return { tool: "read", args: { path: "pixel.png" } };
      }
      if (latest.includes("STEP-EXEC")) {
        return { tool: "exec", args: { command: "sleep 1; echo exec-finished", background: true } };
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
      const provider = buildFakeProvider(api, origin);
      // A second provider on the same transport for the provider-switch step.
      const alternate = { ...provider, providerId: `${provider.providerId}-alt` };
      const alternateRef = `${alternate.providerId}/${provider.modelRef.split("/").slice(1).join("/")}`;
      const runtime = fakeTransportRuntime(api);
      transportEnv = captureEnv(Object.keys(runtime.env));
      for (const [key, value] of Object.entries(runtime.env)) {
        setTestEnvValue(key, value);
      }
      if (runtime.pluginId) {
        deleteTestEnvValue("OPENCLAW_DISABLE_BUNDLED_PLUGINS");
        deleteTestEnvValue("OPENCLAW_BUNDLED_PLUGINS_DIR");
      }
      await fs.writeFile(path.join(fixture.workspaceDir, "AGENTS.md"), "# Rules\n- Be brief.\n");
      await fs.writeFile(path.join(fixture.workspaceDir, "notes.txt"), "alpha\nbeta\n");
      await fs.writeFile(
        path.join(fixture.workspaceDir, "pixel.png"),
        Buffer.from(PNG_BASE64, "base64"),
      );
      const tools = (webFetch: boolean) => ({
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
          plugins: runtime.pluginId
            ? {
                allow: [runtime.pluginId],
                entries: { [runtime.pluginId]: { enabled: true } },
                slots: { memory: "none" },
              }
            : { enabled: false },
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
        }
        // Each request is compared with the previous request of the same session; the first
        // request of each rebuild step may start a new prefix.
        const unexpected: Array<{ step: number; kind: TurnKind; change: string }> = [];
        for (let index = 1; index < target.length; index++) {
          const previous = target[index - 1]!;
          const current = target[index]!;
          const change = prefixChange(previous.request, current.request);
          const rebuild =
            REBUILD_KINDS.has(current.kind) &&
            target.findIndex((entry) => entry.step === current.step) === index;
          if (change && !rebuild) {
            unexpected.push({ step: current.step, kind: current.kind, change });
          }
        }
        expect(
          JSON.stringify(unexpected, null, 1),
          `seed=${seed} journey=${journey.join(",")}`,
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
