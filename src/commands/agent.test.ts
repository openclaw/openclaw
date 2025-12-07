import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  beforeEach,
  describe,
  expect,
  it,
  type MockInstance,
  vi,
} from "vitest";
import * as commandReply from "../auto-reply/command-reply.js";
import type { WarelayConfig } from "../config/config.js";
import * as configModule from "../config/config.js";
import type { RuntimeEnv } from "../runtime.js";
import { agentCommand } from "./agent.js";

const runtime: RuntimeEnv = {
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(() => {
    throw new Error("exit");
  }),
};

const runReplySpy = vi.spyOn(commandReply, "runCommandReply");
const configSpy = vi.spyOn(configModule, "loadConfig");

function makeStorePath() {
  return path.join(
    os.tmpdir(),
    `clawdis-agent-test-${Date.now()}-${Math.random()}.json`,
  );
}

function mockConfig(
  storePath: string,
  replyOverrides?: Partial<NonNullable<WarelayConfig["inbound"]>["reply"]>,
) {
  configSpy.mockReturnValue({
    inbound: {
      reply: {
        mode: "command",
        command: ["echo", "{{Body}}"],
        session: {
          store: storePath,
          sendSystemOnce: false,
        },
        ...replyOverrides,
      },
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  runReplySpy.mockResolvedValue({
    payloads: [{ text: "ok" }],
    meta: { durationMs: 5 },
  });
});

describe("agentCommand", () => {
  it("creates a session entry when deriving from --to", async () => {
    const store = makeStorePath();
    mockConfig(store);

    await agentCommand({ message: "hello", to: "+1555" }, runtime);

    const saved = JSON.parse(fs.readFileSync(store, "utf-8")) as Record<
      string,
      { sessionId: string }
    >;
    const entry = Object.values(saved)[0];
    expect(entry.sessionId).toBeTruthy();
  });

  it("persists thinking and verbose overrides", async () => {
    const store = makeStorePath();
    mockConfig(store);

    await agentCommand(
      { message: "hi", to: "+1222", thinking: "high", verbose: "on" },
      runtime,
    );

    const saved = JSON.parse(fs.readFileSync(store, "utf-8")) as Record<
      string,
      { thinkingLevel?: string; verboseLevel?: string }
    >;
    const entry = Object.values(saved)[0];
    expect(entry.thinkingLevel).toBe("high");
    expect(entry.verboseLevel).toBe("on");

    const callArgs = runReplySpy.mock.calls.at(-1)?.[0];
    expect(callArgs?.thinkLevel).toBe("high");
    expect(callArgs?.verboseLevel).toBe("on");
  });

  it("resumes when session-id is provided", async () => {
    const store = makeStorePath();
    fs.mkdirSync(path.dirname(store), { recursive: true });
    fs.writeFileSync(
      store,
      JSON.stringify(
        {
          foo: {
            sessionId: "session-123",
            updatedAt: Date.now(),
            systemSent: true,
          },
        },
        null,
        2,
      ),
    );
    mockConfig(store);

    await agentCommand(
      { message: "resume me", sessionId: "session-123" },
      runtime,
    );

    const callArgs = runReplySpy.mock.calls.at(-1)?.[0];
    expect(callArgs?.isNewSession).toBe(false);
    expect(callArgs?.templatingCtx.SessionId).toBe("session-123");
  });

  it("prints JSON payload when requested", async () => {
    runReplySpy.mockResolvedValue({
      payloads: [{ text: "json-reply", mediaUrl: "http://x.test/a.jpg" }],
      meta: { durationMs: 42 },
    });
    const store = makeStorePath();
    mockConfig(store);

    await agentCommand({ message: "hi", to: "+1999", json: true }, runtime);

    const logged = (runtime.log as MockInstance).mock.calls.at(
      -1,
    )?.[0] as string;
    const parsed = JSON.parse(logged) as {
      payloads: Array<{ text: string; mediaUrl?: string }>;
      meta: { durationMs: number };
    };
    expect(parsed.payloads[0].text).toBe("json-reply");
    expect(parsed.payloads[0].mediaUrl).toBe("http://x.test/a.jpg");
    expect(parsed.meta.durationMs).toBe(42);
  });

  it("builds command body without WhatsApp wrappers", async () => {
    const store = makeStorePath();
    mockConfig(store, {
      mode: "command",
      command: ["echo", "{{Body}}"],
      session: {
        store,
        sendSystemOnce: false,
        sessionIntro: "Intro {{SessionId}}",
      },
      bodyPrefix: "[pfx] ",
    });

    await agentCommand({ message: "ping", to: "+1333" }, runtime);

    const callArgs = runReplySpy.mock.calls.at(-1)?.[0];
    const body = callArgs?.templatingCtx.Body as string;
    expect(body.startsWith("Intro")).toBe(true);
    expect(body).toContain("[pfx] ping");
    expect(body).not.toContain("WhatsApp");
    expect(body).not.toContain("MEDIA:");
  });
});
