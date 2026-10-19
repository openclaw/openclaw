import { beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
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

function ctx(body = "see https://example.com/page"): MsgContext {
  return { Body: body };
}

function apply(context = ctx(), config = cfg(), signal?: AbortSignal) {
  return applyLinkUnderstanding({ ctx: context, cfg: config, signal });
}

async function withLogs(run: (log: MockInstance<typeof globals.logVerbose>) => Promise<void>) {
  const verbose = vi.spyOn(globals, "shouldLogVerbose").mockReturnValue(true);
  const log = vi.spyOn(globals, "logVerbose").mockImplementation(() => {});
  try {
    await run(log);
  } finally {
    log.mockRestore();
    verbose.mockRestore();
  }
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

const commandResult = { code: 0, killed: false, signal: null, stderr: "", termination: "exit" };
function mockCommand(stdout = "summary") {
  mocks.runCommandWithTimeout.mockResolvedValueOnce({ ...commandResult, stdout });
}

describe("applyLinkUnderstanding", () => {
  beforeEach(() => {
    mocks.fetchWithSsrFGuard.mockReset();
    mocks.runCommandWithTimeout.mockReset();
  });

  it("applies shared media scope rules to link message context", async () => {
    const context: MsgContext = {
      Body: "see https://example.com/page",
      ChatType: "channel",
      Provider: "discord",
      SessionKey: "agent:main:slack:channel:C123",
      Surface: "slack",
    };
    const before = structuredClone(context);
    const match = { channel: "slack", chatType: "channel" as const, keyPrefix: "agent:main:" };
    await apply(
      context,
      cfg(undefined, {
        scope: { default: "allow", rules: [{ action: "deny", match }] },
      }),
    );

    expect(context).toEqual(before);
    expect(fetchWithSsrFGuard).not.toHaveBeenCalled();
    expect(runCommandWithTimeout).not.toHaveBeenCalled();
  });

  it("fetches links through the SSRF guard before passing content to CLI stdin", async () => {
    const body = "synthetic private link context https://example.com/page";
    await withLogs(async (log) => {
      const controller = new AbortController();
      const release = mockGuardedFetch("page body", "https://example.com/final");
      mockCommand("summarized page");

      const context = ctx(body);
      await apply(
        context,
        cfg({
          type: "cli",
          command: "summarize",
          args: ["--source", "{{LinkUrl}}", "--context", "{{Body}}"],
        }),
        controller.signal,
      );

      expect(context.LinkUnderstanding).toEqual(["summarized page"]);
      expect(fetchWithSsrFGuard).toHaveBeenCalledWith(
        expect.objectContaining({
          auditContext: "link-understanding",
          mode: "strict",
          url: "https://example.com/page",
          signal: controller.signal,
        }),
      );
      expect(runCommandWithTimeout).toHaveBeenCalledWith(
        ["summarize", "--source", "--context", body],
        {
          env: {
            OPENCLAW_LINK_FINAL_URL: "https://example.com/final",
            OPENCLAW_LINK_URL: "https://example.com/page",
          },
          input: "page body",
          signal: controller.signal,
          killProcessTree: true,
          timeoutMs: 30000,
        },
      );
      expect(release).toHaveBeenCalledOnce();
      expect(JSON.stringify(log.mock.calls)).not.toContain(body);
    });
  });

  it.each(["fetch", "cli"])(
    "keeps %s failures content-free without changing fallback",
    async (stage) => {
      const privateText = "synthetic-private-link-content";
      await withLogs(async (log) => {
        if (stage === "fetch") {
          mocks.fetchWithSsrFGuard.mockRejectedValueOnce(new Error(privateText));
        } else {
          mockGuardedFetch("fallback page body");
          mocks.runCommandWithTimeout.mockRejectedValueOnce(new Error(privateText));
        }
        const context: MsgContext = {
          Body: "transport envelope",
          agentText: "prepared transcript",
          BodyForAgent: "SDK transcript",
          CommandBody: `https://example.com/${privateText}`,
        };
        const before = structuredClone(context);
        await apply(context);
        if (stage === "fetch") {
          expect(context).toEqual(before);
          expect(runCommandWithTimeout).not.toHaveBeenCalled();
        } else {
          expect(context.LinkUnderstanding).toEqual(["fallback page body"]);
        }
        expect(log).toHaveBeenCalled();
        expect(JSON.stringify(log.mock.calls)).not.toContain(privateText);
      });
    },
  );

  it.each([
    {
      agentText: "prepared transcript",
      BodyForAgent: "stale alias",
      expected: "prepared transcript",
    },
    { BodyForAgent: "SDK transcript", expected: "SDK transcript" },
    { agentText: "", BodyForAgent: "stale alias", expected: "" },
    { expected: "transport envelope" },
  ])(
    "preserves the prepared model text $expected through link enrichment",
    async ({ expected, ...text }) => {
      mockGuardedFetch("page body");
      mockCommand("summarized page");
      const context: MsgContext = {
        Body: "transport envelope",
        RawBody: "see https://example.com/page",
        CommandBody: "see https://example.com/page",
        ...text,
      };

      await apply(context);

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
    },
  );

  it("does not run configured curl fetchers against attacker-controlled URLs", async () => {
    mockGuardedFetch("guarded page body");

    const context = ctx("see http://192.168.1.64.nip.io:8888/aws-iam-credentials");
    await apply(
      context,
      cfg({
        type: "cli",
        command: "curl",
        args: ["-s", "-L", "{{LinkUrl}}"],
      }),
    );

    expect(context.LinkUnderstanding).toEqual(["guarded page body"]);
    expect(fetchWithSsrFGuard).toHaveBeenCalledOnce();
    expect(runCommandWithTimeout).not.toHaveBeenCalled();
  });

  it.each([
    [15, 15000],
    [undefined, 9000],
  ] as const)(
    "resolves global timeout %s to %s ms, otherwise using the largest model timeout",
    async (timeoutSeconds, timeoutMs) => {
      mockGuardedFetch("page body", "https://example.com/final");
      mockCommand("summarized page");

      await apply(
        ctx(),
        cfg(
          [
            { type: "cli", command: "summarize-fast", timeoutSeconds: 1 },
            { type: "cli", command: "summarize-slow", timeoutSeconds: 9 },
          ],
          { timeoutSeconds },
        ),
      );

      expect(fetchWithSsrFGuard).toHaveBeenCalledWith(
        expect.objectContaining({
          timeoutMs,
          url: "https://example.com/page",
        }),
      );
    },
  );

  it("skips pre-aborted work without changing inbound context", async () => {
    const controller = new AbortController();
    controller.abort();
    const context = ctx();
    const original = { ...context };

    await expect(apply(context, cfg(), controller.signal)).resolves.toBeUndefined();

    expect(fetchWithSsrFGuard).not.toHaveBeenCalled();
    expect(runCommandWithTimeout).not.toHaveBeenCalled();
    expect(context).toEqual(original);
  });

  it("passes the signal to each CLI entry during ordinary fallback", async () => {
    const controller = new AbortController();
    mockGuardedFetch("page body", "https://example.com/final");
    mockCommand("");
    mockCommand("second summary");

    const context = ctx();
    const config = cfg([{ command: "summarize-a" }, { command: "summarize-b" }]);
    await apply(context, config, controller.signal);

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
    const controller = new AbortController();
    const reason = new Error("reply canceled");
    mockGuardedFetch("first body", "https://example.com/first");
    mocks.runCommandWithTimeout.mockImplementationOnce(async () => {
      controller.abort(reason);
      return { ...commandResult, stdout: "late summary" };
    });
    const context = ctx("see https://example.com/first and https://example.com/second");
    const original = { ...context };

    await expect(
      apply(
        context,
        cfg([{ command: "summarize-a" }, { command: "summarize-b" }]),
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: "AbortError", cause: reason });

    expect(fetchWithSsrFGuard).toHaveBeenCalledOnce();
    expect(runCommandWithTimeout).toHaveBeenCalledOnce();
    expect(context).toEqual(original);
  });

  it("rethrows a guarded fetch AbortError without starting the CLI", async () => {
    const abortError = Object.assign(new Error("This operation was aborted"), {
      name: "AbortError",
    });
    mocks.fetchWithSsrFGuard.mockRejectedValueOnce(abortError);

    await expect(apply(ctx(), cfg(), new AbortController().signal)).rejects.toBe(abortError);
    expect(runCommandWithTimeout).not.toHaveBeenCalled();
  });

  it("gives caller cancellation precedence over an ordinary fetch error", async () => {
    const controller = new AbortController();
    const reason = new Error("reply canceled");
    mocks.fetchWithSsrFGuard.mockImplementationOnce(async () => {
      controller.abort(reason);
      throw new Error("connect ECONNREFUSED");
    });

    await expect(apply(ctx(), cfg(), controller.signal)).rejects.toMatchObject({
      name: "AbortError",
      cause: reason,
    });
    expect(runCommandWithTimeout).not.toHaveBeenCalled();
  });
});
