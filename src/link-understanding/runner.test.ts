import { beforeEach, expect, it, onTestFinished, vi } from "vitest";
import type { MsgContext } from "../auto-reply/templating.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { LinkModelConfig, LinkToolsConfig } from "../config/types.tools.js";
import * as globals from "../globals.js";
import { applyLinkUnderstanding } from "./apply.js";

const { fetchMock, commandMock } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  commandMock: vi.fn(),
}));
const source = "see https://example.com/page";

vi.mock("../infra/net/fetch-guard.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/net/fetch-guard.js")>()),
  fetchWithSsrFGuard: fetchMock,
}));

vi.mock("../process/exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../process/exec.js")>()),
  runCommandWithTimeout: commandMock,
}));

function cfg(
  entry: LinkModelConfig | LinkModelConfig[] = { type: "cli", command: "summarize" },
  options: Omit<LinkToolsConfig, "models"> = {},
): OpenClawConfig {
  const models = Array.isArray(entry) ? entry : [entry];
  return { tools: { links: { enabled: true, ...options, models } } };
}

function fixture(body: string | MsgContext = source, config = cfg()) {
  const ctx: MsgContext = typeof body === "string" ? { Body: body } : body;
  const before = structuredClone(ctx);
  const controller = new AbortController();
  const run = (signal?: AbortSignal) => applyLinkUnderstanding({ ctx, cfg: config, signal });
  return { ctx, before, controller, run };
}

function captureLogs() {
  vi.spyOn(globals, "shouldLogVerbose").mockReturnValue(true);
  const log = vi.spyOn(globals, "logVerbose").mockImplementation(() => {});
  onTestFinished(() => {
    vi.restoreAllMocks();
  });
  return log;
}

function mockGuardedFetch(body = "page body", resolvedUrl = "https://example.com/final") {
  const release = vi.fn(async () => {});
  fetchMock.mockResolvedValueOnce({ response: new Response(body), finalUrl: resolvedUrl, release });
  return release;
}

function mockCommand(stdout = "summarized page") {
  commandMock.mockResolvedValueOnce({ code: 0, stdout });
}

beforeEach(() => {
  fetchMock.mockReset();
  commandMock.mockReset();
});

it.each([
  ["http://127.0.0.1/test https://ok.test", ["https://ok.test"]],
  ["http://[2001:db8:1234::5efe:127.0.0.1]/secret", []],
  [
    "http://192.168.1.64.nip.io:8888/aws-iam-credentials",
    ["http://192.168.1.64.nip.io:8888/aws-iam-credentials"],
  ],
] as const)("guards fetch-only CLI URLs: %s", async (message, expected) => {
  for (const url of expected) {
    mockGuardedFetch("page body", url);
  }
  const { ctx, run } = fixture(
    message,
    cfg({ command: "curl", args: ["-s", "-L", "{{LinkUrl}}"] }),
  );
  await run();
  expect(fetchMock.mock.calls.map(([request]) => request.url)).toStrictEqual(expected);
  expect(ctx.LinkUnderstanding).toEqual(
    expected.length ? expected.map(() => "page body") : undefined,
  );
  expect(commandMock).not.toHaveBeenCalled();
});

it("applies shared media scope rules to link message context", async () => {
  const match = { channel: "slack", chatType: "channel" as const, keyPrefix: "agent:main:" };
  const { ctx, before, run } = fixture(
    {
      Body: source,
      ChatType: "channel",
      Provider: "discord",
      SessionKey: "agent:main:slack:channel:C123",
      Surface: "slack",
    },
    cfg(undefined, {
      scope: { default: "allow", rules: [{ action: "deny", match }] },
    }),
  );
  await run();

  expect(ctx).toEqual(before);
  expect(fetchMock).not.toHaveBeenCalled();
  expect(commandMock).not.toHaveBeenCalled();
});

it.each(["fetch", "cli"])("redacts %s failures and preserves fallback", async (stage) => {
  const privateText = "synthetic-private-link-content";
  const log = captureLogs();
  if (stage === "fetch") {
    fetchMock.mockRejectedValueOnce(new Error(privateText));
  } else {
    mockGuardedFetch("fallback page body");
    commandMock.mockRejectedValueOnce(new Error(privateText));
  }
  const { ctx, before, run } = fixture(`https://example.com/${privateText}`);
  await run();
  if (stage === "fetch") {
    expect(ctx).toEqual(before);
    expect(commandMock).not.toHaveBeenCalled();
  } else {
    expect(ctx.LinkUnderstanding).toEqual(["fallback page body"]);
  }
  expect(log).toHaveBeenCalled();
  expect(JSON.stringify(log.mock.calls)).not.toContain(privateText);
});

it.each([
  [{ agentText: "prepared", BodyForAgent: "stale" }, "prepared", 15, 15000],
  [{ BodyForAgent: "SDK" }, "SDK", undefined, 9000],
  [{ agentText: "", BodyForAgent: "stale" }, "", undefined, 9000],
  [{}, "transport envelope", undefined, 9000],
] as const)(
  "preserves prepared model text %j",
  async (text, expected, timeoutSeconds, timeoutMs) => {
    const release = mockGuardedFetch();
    const log = captureLogs();
    mockCommand("");
    mockCommand();
    const body = "transport envelope";
    const { ctx, controller, run } = fixture(
      {
        Body: body,
        RawBody: source,
        CommandBody: source,
        ...text,
      },
      cfg(
        [
          { command: "empty", timeoutSeconds: 1 },
          { command: "summarize", timeoutSeconds: 9, args: ["{{LinkUrl}}", "{{Body}}"] },
        ],
        { timeoutSeconds },
      ),
    );
    await run(controller.signal);

    const agentText = expected ? `${expected}\n\nsummarized page` : "summarized page";
    expect(ctx).toMatchObject({
      Body: "transport envelope\n\nsummarized page",
      agentText,
      BodyForAgent: agentText,
      RawBody: source,
      CommandBody: source,
      rawText: source,
      commandText: source,
      LinkUnderstanding: ["summarized page"],
    });
    expect(fetchMock.mock.calls[0]?.[0]).toMatchObject({ mode: "strict", timeoutMs });
    expect(commandMock.mock.calls[1]?.[0]).toEqual(["summarize", body]);
    expect(release).toHaveBeenCalledOnce();
    expect(JSON.stringify(log.mock.calls)).not.toContain(body);
  },
);

it("cancellation overrides successful exit without fallback or context changes", async () => {
  const { ctx, before, controller, run } = fixture(
    "see https://example.com/first and https://example.com/second",
    cfg([{ command: "summarize-a" }, { command: "summarize-b" }]),
  );
  const reason = new Error("reply canceled");
  mockGuardedFetch("first body", "https://example.com/first");
  commandMock.mockImplementationOnce(async () => {
    controller.abort(reason);
    return { code: 0, stdout: "late summary" };
  });
  await expect(run(controller.signal)).rejects.toMatchObject({ name: "AbortError", cause: reason });

  expect(fetchMock).toHaveBeenCalledOnce();
  expect(commandMock).toHaveBeenCalledOnce();
  expect(ctx).toEqual(before);
});

it.each(["before", "during", "fetch"])("handles %s cancellation", async (stage) => {
  const { ctx, before, controller, run } = fixture();
  const reason = new Error("reply canceled");
  if (stage === "before") {
    controller.abort();
    await expect(run(controller.signal)).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(commandMock).not.toHaveBeenCalled();
    expect(ctx).toEqual(before);
    return;
  }
  const cancel = stage === "during";
  const fetchError = Object.assign(new Error("fetch failed"), {
    name: cancel ? "Error" : "AbortError",
  });
  fetchMock.mockImplementationOnce(async () => {
    if (cancel) {
      controller.abort(reason);
    }
    throw fetchError;
  });
  if (cancel) {
    await expect(run(controller.signal)).rejects.toMatchObject({
      name: "AbortError",
      cause: reason,
    });
  } else {
    await expect(run(controller.signal)).rejects.toBe(fetchError);
  }
  expect(commandMock).not.toHaveBeenCalled();
});
