/**
 * Shipped CLI/Gateway proof for #191485: two isolated agents with byte-identical
 * template instructions load their workspaces through the shipped bootstrap
 * loader, run real chat turns through the real Gateway child (the shipped CLI
 * entrypoint), and the mock provider captures the outgoing request bodies.
 *
 * Proves: byte-identical early request prefix across workspaces, relative
 * headings (## AGENTS.md), and distinct per-workspace directory facts starting
 * exactly at the Working directory line, after the shared cacheable prefix.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { createQaLiveLaneGateway } from "../../../../extensions/qa-lab/src/live-transports/shared/live-gateway.runtime.js";
import {
  connectGatewayClient,
  disconnectGatewayClient,
} from "../../../../src/gateway/test-helpers.e2e.js";

const PRIMARY_MODEL = "mock-openai/gpt-5.6-luna";
const ALTERNATE_MODEL = "mock-openai/gpt-5.6-luna-alt";

type GatewayHandle = Awaited<
  ReturnType<ReturnType<typeof createQaLiveLaneGateway>["start"]>
>["gateway"];

const templateInstructions =
  "# Agent Instructions\nYou are the workspace agent. Be helpful and concise.";

async function readJson(baseUrl: string, requestPath: string) {
  const response = await fetch(`${baseUrl}${requestPath}`);
  if (!response.ok) {
    throw new Error(`mock request failed: ${response.status} ${requestPath}`);
  }
  return (await response.json()) as unknown;
}

// A stalled or failed turn must surface the child's own log tail, not a bare
// timeout, so the proof's failure mode stays diagnosable in one run.
async function dumpGatewayTail(gateway: GatewayHandle, reason: string) {
  try {
    const logs = (gateway as unknown as { logs: () => Promise<string> | string }).logs();
    const text = typeof logs === "string" ? logs : await logs;
    const tail = text.split(/\r?\n/u).slice(-40).join("\n");
    console.error(`--- gateway stdout/stderr tail (${reason}) ---`);
    console.error(tail);
  } catch (error) {
    console.error(`gateway log tail unavailable (${reason}):`, error);
  }
  try {
    const tempRoot = (gateway as unknown as { tempRoot: string }).tempRoot;
    const workspace = (gateway as unknown as { workspaceDir: string }).workspaceDir;
    const logsDir = path.join(workspace, "logs");
    const files = await fs.readdir(logsDir);
    for (const name of files.toSorted()) {
      const text = await fs.readFile(path.join(logsDir, name), "utf8");
      console.error(`--- ${tempRoot} file-log tail: ${name} (${reason}) ---`);
      console.error(text.split(/\r?\n/u).slice(-80).join("\n"));
    }
  } catch (error) {
    console.error(`gateway file log tail unavailable (${reason}):`, error);
  }
}

let gatewayOwner: ReturnType<typeof createQaLiveLaneGateway> | undefined;

try {
  gatewayOwner = createQaLiveLaneGateway();
  const { gateway, mock } = await gatewayOwner.start({
    repoRoot: process.cwd(),
    // Repo-CLI mode runs the real scripts/run-node.mjs entrypoint; the qa-lab
    // fixture seeds the fresh state dir directly (no packaged update-repair
    // bootstrap, whose Windows file-symlink staging and repair doctor stall on
    // this machine).
    initializeCurrentRuntimeState: true,
    useRepoCli: true,
    providerMode: "mock-openai",
    primaryModel: PRIMARY_MODEL,
    alternateModel: ALTERNATE_MODEL,
    transport: {
      requiredPluginIds: [],
      createGatewayConfig: () => ({}),
    },
    transportBaseUrl: "http://127.0.0.1",
    controlUiEnabled: false,
    // Repo-CLI mode stages mock API-key auth per listed agent id; the fixture's
    // default roster only covers main/qa, so alice/bob must be listed explicitly.
    mockAuthAgentIds: ["alice", "bob", "qa"],
    mutateConfig: (cfg) => {
      const defaultsWorkspace = cfg.agents?.defaults?.workspace as string;
      // Two agents get distinct workspaces beside the default one; the shipped
      // per-agent workspace resolution (agents.entries.<id>.workspace) owns them.
      return {
        ...cfg,
        agents: {
          ...cfg.agents,
          // Multi-agent rosters require the explicit ownership marker.
          ownership: "explicit",
          entries: {
            ...cfg.agents?.entries,
            alice: {
              workspace: `${defaultsWorkspace}-alice`,
            },
            bob: {
              workspace: `${defaultsWorkspace}-bob`,
            },
          },
        },
      };
    },
  });

  // Discover the child's workspace root, then seed identical template
  // instructions into each agent's distinct workspace directory (resolved by
  // the shipped per-agent workspace resolution) before any turn runs.
  const defaultsWorkspace = (gateway as unknown as { workspaceDir: string }).workspaceDir;
  for (const agent of ["alice", "bob"] as const) {
    const agentWorkspace = `${defaultsWorkspace}-${agent}`;
    await fs.mkdir(agentWorkspace, { recursive: true });
    // Byte-identical instructions in both workspaces: the first prompt diff
    // must come from per-workspace facts (directory line), never from
    // differing user-authored content.
    await fs.writeFile(path.join(agentWorkspace, "AGENTS.md"), templateInstructions);
    await fs.writeFile(path.join(agentWorkspace, "SOUL.md"), "# Soul\nConcise.");
  }

  // Run the RPC client entirely inside the child's state scope: the parent env
  // may still hold a stale client-credential receipt from an older install, and
  // the shipped fix is to scope the client to the same state dir as the child.
  process.env.OPENCLAW_STATE_DIR = (gateway as unknown as { tempRoot: string }).tempRoot
    ? path.join((gateway as unknown as { tempRoot: string }).tempRoot, "state")
    : process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_HOME = path.dirname(path.dirname(process.env.OPENCLAW_STATE_DIR as string));
  // Webchat-mode client with event observation: the working repo-CLI turn shape
  // (test/e2e/qa-lab/runtime/media-talk-gateway.ts). The turn's settlement
  // publishes chat events; waiting on them is what actually observes the run
  // reaching its final state.
  const events: Array<Record<string, unknown>> = [];
  const client = await connectGatewayClient({
    url: gateway.wsUrl,
    token: gateway.token,
    clientName: "webchat-ui",
    mode: "webchat",
    // Webchat-mode handshakes validate origin against the Control UI allowlist;
    // the child binds loopback and its baseUrl origin is the accepted default.
    origin: gateway.baseUrl,
    onEvent: (event) => {
      if (event.event === "chat" && event.payload && typeof event.payload === "object") {
        events.push(structuredClone(event.payload) as Record<string, unknown>);
      }
    },
  });

  const waitForChatFinal = async (runId: unknown, timeoutMs = 180_000) => {
    const runIdText = String(runId);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const finalEvent = events.find(
        (event) => event.runId === runId && (event.state === "final" || event.state === "error"),
      );
      if (finalEvent) {
        if (finalEvent.state === "error") {
          await dumpGatewayTail(gateway, `run ${runIdText} errored`);
          throw new Error(`turn errored: ${JSON.stringify(finalEvent)}`);
        }
        return finalEvent;
      }
      await new Promise((resolve) => {
        setTimeout(resolve, 100);
      });
    }
    await dumpGatewayTail(gateway, `no final chat event for run ${runIdText}`);
    throw new Error(`timed out waiting for final chat event for run ${runIdText}`);
  };

  const sessionA = `agent:alice:proof-${randomUUID()}`;
  const sessionB = `agent:bob:proof-${randomUUID()}`;

  const runTurn = async (sessionKey: string, message: string) => {
    const run = (await client.request(
      "chat.send",
      {
        sessionKey,
        message,
        deliver: false,
        idempotencyKey: randomUUID(),
      },
      { timeoutMs: 60_000 },
    )) as { runId?: string; status?: unknown };
    if (!run.runId) {
      await dumpGatewayTail(gateway, `chat.send returned no runId for ${sessionKey}`);
      throw new Error(`chat.send returned no runId: ${JSON.stringify(run)}`);
    }
    console.log(`turn started for ${sessionKey}: runId=${run.runId}`);
    await waitForChatFinal(run.runId);
    console.log(`turn final for ${sessionKey}`);
    return run;
  };

  await runTurn(sessionA, "Say exactly: ALICE_OK");
  await runTurn(sessionB, "Say exactly: BOB_OK");

  if (!mock) {
    throw new Error("mock provider server is not running");
  }
  const requests = (await readJson(mock.baseUrl, "/debug/requests")) as Array<{
    cursor: number;
    model: string;
    raw: string;
  }>;
  const modelRequests = requests
    .filter((r) => typeof r.model === "string" && /luna/i.test(r.model))
    .toSorted((a, b) => a.cursor - b.cursor)
    .filter((r) => r.raw.includes("ALICE_OK") || r.raw.includes("BOB_OK"));

  if (modelRequests.length < 2) {
    throw new Error(
      `expected at least 2 provider requests, got ${modelRequests.length}; models seen: ` +
        JSON.stringify([...new Set(requests.map((r) => r.model))]),
    );
  }
  const prompts = modelRequests.slice(0, 2).map((request) => {
    // Mock provider speaks the OpenAI Responses API: the system prompt rides
    // in `instructions`, with conversation items in `input`.
    const body = JSON.parse(request.raw) as {
      instructions?: unknown;
      input?: unknown;
    };
    if (typeof body.instructions === "string" && body.instructions.length > 0) {
      return body.instructions;
    }
    const system = (Array.isArray(body.input) ? body.input : []).find(
      (item) =>
        typeof item === "object" &&
        item !== null &&
        "role" in item &&
        (item as { role?: unknown }).role === "system",
    ) as { content?: unknown } | undefined;
    return typeof system?.content === "string" ? system.content : JSON.stringify(request.raw);
  });

  console.log("=== SHIPPED GATEWAY PROOF ===");
  console.log("captured provider requests:", modelRequests.length);
  console.log("prompt A length:", prompts[0]!.length, "| prompt B length:", prompts[1]!.length);
  console.log("prompt A === prompt B:", prompts[0] === prompts[1]);
  console.log("A contains '## AGENTS.md':", prompts[0]!.includes("## AGENTS.md"));
  // Case- and separator-insensitive path containment: escaped prompt bytes may
  // double backslash runs, so collapse any run of backslashes to one slash.
  const containsPath = (prompt: string, workspace: string) => {
    const flat = (value: string) => value.toLowerCase().replace(/\\+/gu, "/");
    return flat(prompt).includes(flat(workspace));
  };
  console.log("defaults workspace (handle):", defaultsWorkspace);
  const aliceWs = `${defaultsWorkspace}-alice`;
  const bobWs = `${defaultsWorkspace}-bob`;
  console.log("A contains alice workspace path:", containsPath(prompts[0]!, aliceWs));
  console.log("B contains bob workspace path:", containsPath(prompts[1]!, bobWs));
  // Shared byte prefix: verify no per-workspace fact leaks before the boundary.
  const boundaryLineA = prompts[0]!.indexOf("Working directory:");
  const boundaryLineB = prompts[1]!.indexOf("Working directory:");
  console.log(
    "byte-identical prefix before 'Working directory:' line:",
    prompts[0]!.slice(0, boundaryLineA) === prompts[1]!.slice(0, boundaryLineB),
  );
  const missingMarkers = [...prompts[0]!.matchAll(/\[MISSING\] Expected at: [^\s\\/:]+/gu)].map(
    (match) => match[0],
  );
  console.log("A missing-file markers:", JSON.stringify(missingMarkers));
  console.log(
    "A contains absolute heading:",
    /## ([A-Za-z]:\\|\/(?!\/)[^\n]*AGENTS)/.test(prompts[0]!),
  );
  const firstDiff = prompts[0]!.split("").findIndex((ch, i) => ch !== prompts[1]!.charAt(i));
  console.log("first differing char index:", firstDiff);
  const ctx = 120;
  console.log("--- A around first diff ---");
  console.log(JSON.stringify(prompts[0]!.slice(Math.max(0, firstDiff - ctx), firstDiff + ctx)));
  console.log("--- B around first diff ---");
  console.log(JSON.stringify(prompts[1]!.slice(Math.max(0, firstDiff - ctx), firstDiff + ctx)));

  await disconnectGatewayClient(client);
} finally {
  if (gatewayOwner) {
    await gatewayOwner.stop();
  }
}
