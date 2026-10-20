import { beforeEach, expect, it, onTestFinished, vi } from "vitest";
import type { MsgContext } from "../auto-reply/templating.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { LinkModelConfig, LinkToolsConfig } from "../config/types.tools.js";
import * as globals from "../globals.js";
import { fetchWithSsrFGuard } from "../infra/net/fetch-guard.js";
import { runCommandWithTimeout } from "../process/exec.js";
import { applyLinkUnderstanding } from "./apply.js";

const mocks = vi.hoisted(() => ({
  fetchWithSsrFGuard: vi.fn(),
  runCommandWithTimeout: vi.fn(),
}));

vi.mock("../infra/net/fetch-guard.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/net/fetch-guard.js")>()),
  fetchWithSsrFGuard: mocks.fetchWithSsrFGuard,
}));

vi.mock("../process/exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../process/exec.js")>()),
  runCommandWithTimeout: mocks.runCommandWithTimeout,
}));

function cfg(
  entry: LinkModelConfig | LinkModelConfig[] = { type: "cli", command: "summarize" },
  options: Omit<LinkToolsConfig, "models"> = {},
): OpenClawConfig {
  const models = Array.isArray(entry) ? entry : [entry];
  return { tools: { links: { enabled: true, ...options, models } } };
}

function fixture(body: string | MsgContext = "see https://example.com/page", config = cfg()) {
  const context: MsgContext = typeof body === "string" ? { Body: body } : body;
  const before = structuredClone(context);
  const controller = new AbortController();
  const run = (signal?: AbortSignal) =>
    applyLinkUnderstanding({ ctx: context, cfg: config, signal });
  return { context, before, controller, run };
}

function captureLogs() {
  const verbose = vi.spyOn(globals, "shouldLogVerbose").mockReturnValue(true);
  const log = vi.spyOn(globals, "logVerbose").mockImplementation(() => {});
  onTestFinished(() => {
    log.mockRestore();
    verbose.mockRestore();
  });
  return log;
}

function mockGuardedFetch(body = "guarded content", finalUrl = "https://example.com/final") {
  const release = vi.fn(async () => {});
  mocks.fetchWithSsrFGuard.mockResolvedValueOnce({
    response: new Response(body),
    finalUrl,
    release,
  });
  return release;
}

function mockCommand(stdout = "summary") {
  mocks.runCommandWithTimeout.mockResolvedValueOnce({ code: 0, stdout });
}

beforeEach(() => {
  mocks.fetchWithSsrFGuard.mockReset();
  mocks.runCommandWithTimeout.mockReset();
});

it("applies shared media scope rules to link message context", async () => {
  const match = { channel: "slack", chatType: "channel" as const, keyPrefix: "agent:main:" };
  const { context, before, run } = fixture(
    {
      Body: "see https://example.com/page",
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

  expect(context).toEqual(before);
  expect(fetchWithSsrFGuard).not.toHaveBeenCalled();
  expect(runCommandWithTimeout).not.toHaveBeenCalled();
});

it("fetches links through the SSRF guard before passing content to CLI stdin", async () => {
  const body = "synthetic private link context https://example.com/page";
  const log = captureLogs();
  const release = mockGuardedFetch("page body", "https://example.com/final");
  mockCommand("summarized page");

  const args = ["--source", "{{LinkUrl}}", "--context", "{{Body}}"];
  const config = cfg({ type: "cli", command: "summarize", args });
  const { context, controller, run } = fixture(body, config);
  await run(controller.signal);

  expect(context.LinkUnderstanding).toEqual(["summarized page"]);
  expect(fetchWithSsrFGuard).toHaveBeenCalledWith(
    expect.objectContaining({
      auditContext: "link-understanding",
      mode: "strict",
      url: "https://example.com/page",
      signal: controller.signal,
    }),
  );
  expect(runCommandWithTimeout).toHaveBeenCalledWith(["summarize", "--source", "--context", body], {
    env: {
      OPENCLAW_LINK_FINAL_URL: "https://example.com/final",
      OPENCLAW_LINK_URL: "https://example.com/page",
    },
    input: "page body",
    signal: controller.signal,
    killProcessTree: true,
    timeoutMs: 30000,
  });
  expect(release).toHaveBeenCalledOnce();
  expect(JSON.stringify(log.mock.calls)).not.toContain(body);
});

it.each(["fetch", "cli"])(
  "keeps %s failures content-free without changing fallback",
  async (stage) => {
    const privateText = "synthetic-private-link-content";
    const log = captureLogs();
    if (stage === "fetch") {
      mocks.fetchWithSsrFGuard.mockRejectedValueOnce(new Error(privateText));
    } else {
      mockGuardedFetch("fallback page body");
      mocks.runCommandWithTimeout.mockRejectedValueOnce(new Error(privateText));
    }
    const { context, before, run } = fixture({
      Body: "transport envelope",
      agentText: "prepared transcript",
      BodyForAgent: "SDK transcript",
      CommandBody: `https://example.com/${privateText}`,
    });
    await run();
    if (stage === "fetch") {
      expect(context).toEqual(before);
      expect(runCommandWithTimeout).not.toHaveBeenCalled();
    } else {
      expect(context.LinkUnderstanding).toEqual(["fallback page body"]);
    }
    expect(log).toHaveBeenCalled();
    expect(JSON.stringify(log.mock.calls)).not.toContain(privateText);
  },
);

it.each([
  [{ agentText: "prepared", BodyForAgent: "stale" }, "prepared"],
  [{ BodyForAgent: "SDK" }, "SDK"],
  [{ agentText: "", BodyForAgent: "stale" }, ""],
  [{}, "transport envelope"],
] as const)("preserves prepared model text %j", async (text, expected) => {
  mockGuardedFetch("page body");
  mockCommand("summarized page");
  const { context, run } = fixture({
    Body: "transport envelope",
    RawBody: "see https://example.com/page",
    CommandBody: "see https://example.com/page",
    ...text,
  });
  await run();

  const agentText = expected ? `${expected}\n\nsummarized page` : "summarized page";
  expect(context).toMatchObject({
    Body: "transport envelope\n\nsummarized page",
    agentText,
    BodyForAgent: agentText,
    RawBody: "see https://example.com/page",
    CommandBody: "see https://example.com/page",
    rawText: "see https://example.com/page",
    commandText: "see https://example.com/page",
    LinkUnderstanding: ["summarized page"],
  });
});

it("does not run configured curl fetchers against attacker-controlled URLs", async () => {
  mockGuardedFetch("guarded page body");
  const args = ["-s", "-L", "{{LinkUrl}}"];
  const config = cfg({ type: "cli", command: "curl", args });
  const { context, run } = fixture(
    "see http://192.168.1.64.nip.io:8888/aws-iam-credentials",
    config,
  );
  await run();

  expect(context.LinkUnderstanding).toEqual(["guarded page body"]);
  expect(fetchWithSsrFGuard).toHaveBeenCalledOnce();
  expect(runCommandWithTimeout).not.toHaveBeenCalled();
});

it.each([
  [15, 15000],
  [undefined, 9000],
] as const)("fetch timeout: global=%s, resolved=%s ms", async (timeoutSeconds, timeoutMs) => {
  mockGuardedFetch("page body", "https://example.com/final");
  mockCommand("summarized page");

  const { run } = fixture(
    undefined,
    cfg(
      [
        { command: "fast", timeoutSeconds: 1 },
        { command: "slow", timeoutSeconds: 9 },
      ],
      { timeoutSeconds },
    ),
  );
  await run();

  expect(fetchWithSsrFGuard).toHaveBeenCalledWith(
    expect.objectContaining({
      timeoutMs,
      url: "https://example.com/page",
    }),
  );
});

it("skips pre-aborted work without changing inbound context", async () => {
  const { context, before, controller, run } = fixture();
  controller.abort();
  await expect(run(controller.signal)).resolves.toBeUndefined();

  expect(fetchWithSsrFGuard).not.toHaveBeenCalled();
  expect(runCommandWithTimeout).not.toHaveBeenCalled();
  expect(context).toEqual(before);
});

it("passes the signal to each CLI entry during ordinary fallback", async () => {
  mockGuardedFetch("page body", "https://example.com/final");
  mockCommand("");
  mockCommand("second summary");

  const config = cfg([{ command: "summarize-a" }, { command: "summarize-b" }]);
  const { context, controller, run } = fixture(undefined, config);
  await run(controller.signal);

  expect(context.LinkUnderstanding).toEqual(["second summary"]);
  for (const [index, command] of ["summarize-a", "summarize-b"].entries()) {
    expect(runCommandWithTimeout).toHaveBeenNthCalledWith(
      index + 1,
      [command],
      expect.objectContaining({ signal: controller.signal }),
    );
  }
});

it("cancellation overrides successful exit without fallback or context changes", async () => {
  const { context, before, controller, run } = fixture(
    "see https://example.com/first and https://example.com/second",
    cfg([{ command: "summarize-a" }, { command: "summarize-b" }]),
  );
  const reason = new Error("reply canceled");
  mockGuardedFetch("first body", "https://example.com/first");
  mocks.runCommandWithTimeout.mockImplementationOnce(async () => {
    controller.abort(reason);
    return { code: 0, stdout: "late summary" };
  });
  await expect(run(controller.signal)).rejects.toMatchObject({ name: "AbortError", cause: reason });

  expect(fetchWithSsrFGuard).toHaveBeenCalledOnce();
  expect(runCommandWithTimeout).toHaveBeenCalledOnce();
  expect(context).toEqual(before);
});

it.each([false, true])("propagates fetch aborts with caller cancellation=%s", async (cancel) => {
  const { controller, run } = fixture();
  const reason = new Error("reply canceled");
  const fetchError = Object.assign(new Error("fetch failed"), {
    name: cancel ? "Error" : "AbortError",
  });
  mocks.fetchWithSsrFGuard.mockImplementationOnce(async () => {
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
  expect(runCommandWithTimeout).not.toHaveBeenCalled();
});
