import { PassThrough } from "node:stream";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { runRpcLoop } from "./loop.js";

vi.mock("../commands/health.js", () => ({
  getHealthSnapshot: vi.fn(async () => ({ heartbeatSeconds: 42 })),
}));

vi.mock("../commands/status.js", () => ({
  getStatusSummary: vi.fn(async () => ({
    web: { linked: true, authAgeMs: 0 },
    heartbeatSeconds: 60,
    providerSummary: "ok",
    queuedSystemEvents: [],
    sessions: {
      path: "/tmp/sessions.json",
      count: 0,
      defaults: { model: "claude-opus-4-5", contextTokens: 200_000 },
      recent: [],
    },
  })),
}));

vi.mock("../infra/heartbeat-events.js", () => ({
  getLastHeartbeatEvent: vi.fn(() => ({ ts: 1, status: "sent" })),
  onHeartbeatEvent: vi.fn((cb: (p: unknown) => void) => {
    // return stopper
    return () => void cb({});
  }),
}));

vi.mock("../infra/agent-events.js", () => ({
  onAgentEvent: vi.fn((_cb: (p: unknown) => void) => () => {}),
}));

vi.mock("../infra/system-presence.js", () => ({
  enqueueSystemEvent: vi.fn(),
  updateSystemPresence: vi.fn(),
  listSystemPresence: vi.fn(() => [{ text: "hi" }]),
}));

vi.mock("../commands/agent.js", () => ({
  agentCommand: vi.fn(
    async (_opts, runtime: { log: (msg: string) => void }) => {
      // Emit a fake payload log entry the loop will pick up
      runtime.log(JSON.stringify({ payloads: [{ text: "ok" }] }));
    },
  ),
}));

vi.mock("../cli/deps.js", () => ({
  createDefaultDeps: vi.fn(() => ({})),
}));

describe("runRpcLoop", () => {
  let input: PassThrough;
  let output: PassThrough;
  let lines: unknown[];

  beforeEach(() => {
    input = new PassThrough();
    output = new PassThrough();
    lines = [];
    output.on("data", (chunk) => {
      const str = chunk.toString();
      for (const line of str.split("\n").filter(Boolean)) {
        lines.push(JSON.parse(line));
      }
    });
  });

  it("responds to control-request health", async () => {
    const loop = await runRpcLoop({ input, output });
    input.write('{"type":"control-request","id":"1","method":"health"}\n');
    await new Promise((r) => setTimeout(r, 50));
    loop.close();
    expect(
      lines.find((l) => l.type === "control-response" && l.id === "1"),
    ).toMatchObject({
      ok: true,
    });
  });

  it("forwards initial heartbeat event", async () => {
    const loop = await runRpcLoop({ input, output });
    await new Promise((r) => setTimeout(r, 20));
    loop.close();
    expect(lines[0]).toMatchObject({ type: "event", event: "heartbeat" });
  });

  it("handles send via agentCommand", async () => {
    const loop = await runRpcLoop({ input, output });
    input.write('{"type":"send","text":"hi"}\n');
    await new Promise((r) => setTimeout(r, 50));
    loop.close();
    expect(lines.find((l) => l.type === "result" && l.ok)).toBeTruthy();
  });

  it("routes system-event", async () => {
    const loop = await runRpcLoop({ input, output });
    input.write(
      '{"type":"control-request","id":"sys","method":"system-event","params":{"text":"ping"}}\n',
    );
    await new Promise((r) => setTimeout(r, 50));
    loop.close();
    const resp = lines.find((l) => l.id === "sys");
    expect(resp).toMatchObject({ ok: true, type: "control-response" });
  });
});
