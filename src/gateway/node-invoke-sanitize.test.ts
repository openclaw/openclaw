import { describe, expect, it } from "vitest";
import { sanitizeNodeInvokeParamsForForwarding } from "./node-invoke-sanitize.js";

describe.each(["system.run.prepare", "system.run"])("%s execution context", (command) => {
  const context = { senderId: "sender-1", chatId: "chat-1", subagent: true };
  const invoke = (executionContext: unknown, caps = ["system.run.execution-context.v1"]) =>
    sanitizeNodeInvokeParamsForForwarding({
      nodeId: "node-1",
      command,
      caps,
      client: null,
      rawParams: { command: ["echo", "ok"], executionContext },
    });

  it("preserves supported routing hints without changing argv", async () => {
    expect(await invoke(context)).toMatchObject({
      ok: true,
      params: { command: ["echo", "ok"], executionContext: context },
    });
  });

  it("refuses context when a node reconnects without the capability", async () => {
    expect(await invoke(context, [])).toMatchObject({ ok: false });
    expect(await invoke(undefined, [])).toMatchObject({ ok: true });
  });

  it.each([
    null,
    { senderId: 7 },
    { chatId: "" },
    { subagent: false },
    { env: { PATH: "/tmp" } },
    { sessionKey: "agent:main:main" },
  ])("rejects malformed or authority-bearing context %j", async (executionContext) => {
    expect(await invoke(executionContext)).toMatchObject({ ok: false });
  });
});

it("routing context cannot approve a command", async () => {
  expect(
    await sanitizeNodeInvokeParamsForForwarding({
      nodeId: "node-1",
      command: "system.run",
      caps: ["system.run.execution-context.v1"],
      client: null,
      rawParams: { command: ["echo", "ok"], executionContext: { subagent: true }, approved: true },
    }),
  ).toMatchObject({ ok: false, message: "approval override requires params.runId" });
});
