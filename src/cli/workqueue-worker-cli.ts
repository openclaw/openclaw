import type { Command } from "commander";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { defaultRuntime } from "../runtime.js";
import { formatDocsLink } from "../terminal/links.js";
import { theme } from "../terminal/theme.js";

const execFileAsync = promisify(execFile);

type WorkqueueItem = {
  id: string;
  queue: string;
  title: string;
  instructions: string;
  priority?: number;
};

type ClawnsoleClaimNextResult =
  | { ok: true; item: WorkqueueItem | null }
  | { ok: false; error?: string; [k: string]: unknown };

type OpenClawAgentResult = {
  runId?: string;
  status?: string;
  summary?: string;
  result?: unknown;
  [k: string]: unknown;
};

function parseJson<T>(raw: string, label: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    throw new Error(`${label}: failed to parse JSON: ${String(err)}\n---\n${raw}`);
  }
}

const splitCsv = (raw: string): string[] =>
  raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

async function sleep(ms: number) {
  if (!Number.isFinite(ms) || ms <= 0) {
    return;
  }
  await new Promise((r) => setTimeout(r, ms));
}

async function runClawnsole(args: string[], opts: { clawnsoleCmd: string }) {
  const res = await execFileAsync(opts.clawnsoleCmd, args, { maxBuffer: 10 * 1024 * 1024 });
  const out = String(res.stdout ?? "").trim();
  if (!out) {
    throw new Error(`clawnsole returned empty output for: ${opts.clawnsoleCmd} ${args.join(" ")}`);
  }
  return out;
}

async function claimNext(params: {
  agentId: string;
  queues: string[];
  leaseMs?: number;
  clawnsoleCmd: string;
}): Promise<ClawnsoleClaimNextResult> {
  const args = [
    "workqueue",
    "claim-next",
    "--agent",
    params.agentId,
    "--queues",
    params.queues.join(","),
  ];
  if (typeof params.leaseMs === "number") {
    args.push("--leaseMs", String(params.leaseMs));
  }
  const out = await runClawnsole(args, { clawnsoleCmd: params.clawnsoleCmd });
  return parseJson(out, "clawnsole claim-next");
}

async function progress(params: {
  itemId: string;
  agentId: string;
  note: string;
  leaseMs?: number;
  clawnsoleCmd: string;
}) {
  const args = [
    "workqueue",
    "progress",
    params.itemId,
    "--agent",
    params.agentId,
    "--note",
    params.note,
  ];
  if (typeof params.leaseMs === "number") {
    args.push("--leaseMs", String(params.leaseMs));
  }
  await runClawnsole(args, { clawnsoleCmd: params.clawnsoleCmd });
}

async function done(params: {
  itemId: string;
  agentId: string;
  resultJson: unknown;
  clawnsoleCmd: string;
}) {
  const args = [
    "workqueue",
    "done",
    params.itemId,
    "--agent",
    params.agentId,
    "--result",
    JSON.stringify(params.resultJson),
  ];
  await runClawnsole(args, { clawnsoleCmd: params.clawnsoleCmd });
}

async function fail(params: {
  itemId: string;
  agentId: string;
  error: string;
  clawnsoleCmd: string;
}) {
  const args = [
    "workqueue",
    "fail",
    params.itemId,
    "--agent",
    params.agentId,
    "--error",
    params.error,
  ];
  await runClawnsole(args, { clawnsoleCmd: params.clawnsoleCmd });
}

async function runOpenClawAgent(params: {
  openclawCmd: string;
  agentId: string;
  sessionId: string;
  message: string;
  gatewayUrl?: string;
  gatewayToken?: string;
  thinking?: string;
  timeoutSeconds?: number;
}): Promise<OpenClawAgentResult> {
  const args = [
    "agent",
    "--agent",
    params.agentId,
    "--session-id",
    params.sessionId,
    "--message",
    params.message,
    "--json",
  ];
  if (params.gatewayUrl) {
    args.push("--url", params.gatewayUrl);
  }
  if (params.gatewayToken) {
    args.push("--token", params.gatewayToken);
  }
  if (params.thinking) {
    args.push("--thinking", params.thinking);
  }
  if (typeof params.timeoutSeconds === "number") {
    args.push("--timeout", String(params.timeoutSeconds));
  }

  const res = await execFileAsync(params.openclawCmd, args, {
    maxBuffer: 50 * 1024 * 1024,
    env: process.env,
  });
  const out = String(res.stdout ?? "").trim();
  if (!out) {
    throw new Error(`openclaw agent returned empty output`);
  }
  return parseJson(out, "openclaw agent");
}

export function registerWorkqueueWorkerCli(program: Command) {
  program
    .command("workqueue-worker")
    .description("Claim workqueue items via clawnsole and execute them via openclaw agent")
    .requiredOption("--agent <id>", "Workqueue agent id")
    .requiredOption("--queues <q1,q2>", "Comma-separated queue list")
    .option("--leaseMs <ms>", "Lease duration in ms (passed to clawnsole)", "900000")
    .option("--idleMs <ms>", "If queue is empty: sleep this long then exit", "0")
    .option(
      "--sessionPrefix <prefix>",
      "Prefix for agent session ids (full session id becomes <prefix><itemId>)",
      "workqueue:",
    )
    .option("--clawnsole <cmd>", "clawnsole command (default: clawnsole)", "clawnsole")
    .option("--openclaw <cmd>", "openclaw command (default: openclaw)", "openclaw")
    .option("--gateway-url <url>", "Gateway URL override (passed through to openclaw agent)")
    .option("--gateway-token <token>", "Gateway token override (passed through to openclaw agent)")
    .option("--thinking <level>", "Thinking level for the worker run")
    .option("--timeoutSeconds <n>", "Agent run timeout (seconds)")
    .option("--dry-run", "Claim + report what would run (no execution / no done/fail)", false)
    .option("--json", "Output machine-readable JSON to stdout", false)
    .addHelpText(
      "after",
      () => `\n${theme.muted("Docs:")} ${formatDocsLink(
        "/cli/workqueue-worker",
        "docs.openclaw.ai/cli/workqueue-worker",
      )}\n`,
    )
    .action(async (opts) => {
      const agentId = String(opts.agent).trim();
      const queues = splitCsv(String(opts.queues));
      if (!queues.length) {
        throw new Error("--queues must include at least one queue");
      }

      const leaseMs = Number.parseInt(String(opts.leaseMs), 10);
      const idleMs = Number.parseInt(String(opts.idleMs), 10);
      const clawnsoleCmd = String(opts.clawnsole).trim();
      const openclawCmd = String(opts.openclaw).trim();
      const sessionPrefix = String(opts.sessionPrefix ?? "");
      const thinking = typeof opts.thinking === "string" ? String(opts.thinking).trim() : undefined;
      const timeoutSeconds =
        typeof opts.timeoutSeconds === "string" && String(opts.timeoutSeconds).trim()
          ? Number.parseInt(String(opts.timeoutSeconds), 10)
          : undefined;

      const claim = await claimNext({ agentId, queues, leaseMs, clawnsoleCmd });

      if (!claim.ok) {
        throw new Error(`clawnsole claim-next failed: ${JSON.stringify(claim)}`);
      }

      if (!claim.item) {
        if (opts.json) {
          defaultRuntime.log(JSON.stringify({ ok: true, action: "noop_empty" }, null, 2));
        } else {
          defaultRuntime.log("workqueue: empty");
        }
        await sleep(idleMs);
        return;
      }

      const item = claim.item;
      const sessionId = `${sessionPrefix}${item.id}`;

      if (opts.dryRun) {
        const payload = {
          ok: true,
          action: "dry_run",
          item,
          wouldRun: {
            openclawCmd,
            args: [
              "agent",
              "--agent",
              agentId,
              "--session-id",
              sessionId,
              "--message",
              "<instructions>",
              "--json",
            ],
          },
        };
        defaultRuntime.log(opts.json ? JSON.stringify(payload, null, 2) : JSON.stringify(payload, null, 2));
        return;
      }

      await progress({
        itemId: item.id,
        agentId,
        note: `worker: executing via openclaw agent (session-id=${sessionId})`,
        leaseMs,
        clawnsoleCmd,
      });

      try {
        const result = await runOpenClawAgent({
          openclawCmd,
          agentId,
          sessionId,
          message: item.instructions,
          gatewayUrl: opts.gatewayUrl as string | undefined,
          gatewayToken: opts.gatewayToken as string | undefined,
          thinking,
          timeoutSeconds,
        });

        await done({ itemId: item.id, agentId, resultJson: result, clawnsoleCmd });

        if (opts.json) {
          defaultRuntime.log(JSON.stringify({ ok: true, action: "done", itemId: item.id, result }, null, 2));
        }
      } catch (err) {
        const msg = String(err);
        await fail({ itemId: item.id, agentId, error: msg.slice(0, 4000), clawnsoleCmd });
        throw err;
      }
    });
}
