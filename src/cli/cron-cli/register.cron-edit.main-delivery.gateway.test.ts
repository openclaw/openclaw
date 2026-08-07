// Exact-head CLI → ephemeral gateway: main chat delivery must fail closed.
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  connectOk,
  installGatewayTestHooks,
  rpcReq,
  startServerWithClient,
  testState,
} from "../../gateway/test-helpers.js";
import { testConfigRoot } from "../../gateway/test-helpers.runtime-state.js";

installGatewayTestHooks({ scope: "suite" });

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const entry = path.join(repoRoot, "src/entry.ts");

async function runCli(
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return await new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", entry, ...args], {
      cwd: repoRoot,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("close", (code) => {
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

function jobIdFromCronAdd(payload: unknown): string {
  if (!payload || typeof payload !== "object") {
    return "";
  }
  const record = payload as { id?: unknown; job?: { id?: unknown } };
  if (typeof record.id === "string" && record.id.trim()) {
    return record.id.trim();
  }
  if (typeof record.job?.id === "string" && record.job.id.trim()) {
    return record.job.id.trim();
  }
  return "";
}

describe("cron edit main delivery CLI→gateway", () => {
  let started: Awaited<ReturnType<typeof startServerWithClient>> | undefined;
  let tempRoot = "";
  const token = "proof-main-delivery-token";

  beforeAll(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-main-delivery-proof-"));
    process.env.OPENCLAW_SKIP_CRON = "0";
    testState.cronEnabled = true;
    const configPath = path.join(testConfigRoot.value, "openclaw.json");
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(
      configPath,
      `${JSON.stringify({ cron: { enabled: true } }, null, 2)}\n`,
      "utf8",
    );
    started = await startServerWithClient(token);
    await connectOk(started.ws);
  }, 120_000);

  afterAll(async () => {
    if (started) {
      started.ws.close();
      await started.server.close().catch(() => undefined);
      started.envSnapshot.restore();
    }
    if (tempRoot) {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("CLI chat delivery on existing main job fails before update", async () => {
    expect(started).toBeDefined();
    const { ws, port } = started!;
    const url = `ws://127.0.0.1:${port}`;
    const env = {
      ...process.env,
      HOME: tempRoot,
      OPENCLAW_HOME: tempRoot,
      OPENCLAW_STATE_DIR: path.join(tempRoot, ".openclaw"),
      OPENCLAW_CONFIG_PATH: path.join(tempRoot, ".openclaw", "openclaw.json"),
      OPENCLAW_GATEWAY_TOKEN: token,
    };

    const add = await rpcReq(ws, "cron.add", {
      name: "proof-main-delivery",
      enabled: true,
      schedule: { kind: "every", everyMs: 3_600_000 },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      payload: { kind: "systemEvent", text: "tick" },
    });
    expect(add.ok, JSON.stringify(add.error ?? add.payload)).toBe(true);
    const jobId = jobIdFromCronAdd(add.payload);
    expect(jobId.length > 0).toBe(true);

    const edit = await runCli(
      [
        "cron",
        "edit",
        jobId,
        "--channel",
        "telegram",
        "--to",
        "123",
        "--url",
        url,
        "--token",
        token,
      ],
      env,
    );
    console.log(
      [
        "----- cli-edit-main-chat-delivery-reject -----",
        `$ openclaw cron edit ${jobId} --channel telegram --to 123 --url ${url} --token ***`,
        edit.stdout.trim(),
        edit.stderr.trim(),
        `exit=${edit.code}`,
      ].join("\n"),
    );
    expect(edit.code).toBe(1);
    expect(`${edit.stdout}\n${edit.stderr}`).toContain(
      "--channel, --to, --account, and --thread-id require a non-main",
    );

    const get = await rpcReq(ws, "cron.get", { id: jobId });
    expect(get.ok).toBe(true);
    const job = get.payload as { delivery?: unknown };
    expect(job.delivery).toBeUndefined();
    console.log(
      [
        "----- gateway-cron-get-unchanged -----",
        JSON.stringify({ id: jobId, delivery: job.delivery ?? null }, null, 2),
      ].join("\n"),
    );

    // Service-level fail-closed if RPC is used directly (bypass CLI).
    const update = await rpcReq(ws, "cron.update", {
      id: jobId,
      patch: {
        delivery: { mode: "announce", channel: "telegram", to: "123" },
      },
    });
    console.log(
      [
        "----- rpc-cron-update-main-announce-reject -----",
        JSON.stringify({ ok: update.ok, error: update.error }, null, 2),
      ].join("\n"),
    );
    expect(update.ok).toBe(false);
    expect(String(update.error?.message ?? "")).toContain(
      'cron channel delivery config is only supported for sessionTarget="isolated"',
    );

    const completionUpdate = await rpcReq(ws, "cron.update", {
      id: jobId,
      patch: {
        delivery: {
          mode: "announce",
          completionDestination: {
            mode: "webhook",
            to: "https://example.invalid/complete",
          },
        },
      },
    });
    console.log(
      [
        "----- rpc-cron-update-main-completion-reject -----",
        JSON.stringify({ ok: completionUpdate.ok, error: completionUpdate.error }, null, 2),
      ].join("\n"),
    );
    expect(completionUpdate.ok).toBe(false);
    expect(String(completionUpdate.error?.message ?? "")).toContain(
      'cron channel delivery config is only supported for sessionTarget="isolated"',
    );

    // Retarget cleanup: isolated announce → main without delivery patch clears route.
    const isolatedAdd = await rpcReq(ws, "cron.add", {
      name: "proof-retarget-cleanup",
      enabled: true,
      schedule: { kind: "every", everyMs: 3_600_000 },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "hello" },
      delivery: { mode: "announce", channel: "telegram", to: "123" },
    });
    expect(isolatedAdd.ok, JSON.stringify(isolatedAdd.error ?? isolatedAdd.payload)).toBe(true);
    const isolatedId = jobIdFromCronAdd(isolatedAdd.payload);
    expect(isolatedId.length > 0).toBe(true);

    const retarget = await rpcReq(ws, "cron.update", {
      id: isolatedId,
      patch: {
        sessionTarget: "main",
        payload: { kind: "systemEvent", text: "tick" },
      },
    });
    console.log(
      [
        "----- rpc-cron-update-retarget-main-cleanup -----",
        JSON.stringify({ ok: retarget.ok, error: retarget.error }, null, 2),
      ].join("\n"),
    );
    expect(retarget.ok).toBe(true);

    const retargetGet = await rpcReq(ws, "cron.get", { id: isolatedId });
    expect(retargetGet.ok).toBe(true);
    const retargetJob = retargetGet.payload as {
      sessionTarget?: string;
      delivery?: unknown;
    };
    expect(retargetJob.sessionTarget).toBe("main");
    expect(retargetJob.delivery).toBeUndefined();
  }, 120_000);
});
