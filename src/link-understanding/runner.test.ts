// Link-understanding runner tests cover bounded fetches, command execution, scoping, and template behavior.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MsgContext } from "../auto-reply/templating.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { LinkModelConfig } from "../config/types.tools.js";
import { runCommandWithTimeout } from "../process/exec.js";
import { runLinkUnderstanding } from "./runner.js";

const mocks = vi.hoisted(() => ({
  runCommandWithTimeout: vi.fn(),
}));

vi.mock("../process/exec.js", async () => {
  const actual = await vi.importActual<typeof import("../process/exec.js")>("../process/exec.js");
  return {
    ...actual,
    runCommandWithTimeout: mocks.runCommandWithTimeout,
  };
});

function cfg(entry: LinkModelConfig) {
  return {
    tools: {
      links: {
        enabled: true,
        models: [entry],
      },
    },
  } as OpenClawConfig;
}

function ctx(body: string): MsgContext {
  return { Body: body } as MsgContext;
}

function mockFetchResponse(body = "fetched content", finalUrl = "https://example.com/final") {
  const response = new Response(body, {
    headers: { "Content-Type": "text/plain" },
  });
  Object.defineProperty(response, "url", { value: finalUrl });
  vi.mocked(globalThis.fetch).mockResolvedValueOnce(response);
}

function mockCommand(stdout = "summary") {
  mocks.runCommandWithTimeout.mockResolvedValueOnce({
    code: 0,
    killed: false,
    signal: null,
    stderr: "",
    stdout,
    termination: "exit",
  });
}

describe("runLinkUnderstanding", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
    mocks.runCommandWithTimeout.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetches links before passing bounded content to CLI stdin", async () => {
    mockFetchResponse("page body", "https://example.com/final");
    mockCommand("summarized page");

    const result = await runLinkUnderstanding({
      cfg: cfg({ type: "cli", command: "summarize", args: ["--source", "{{LinkUrl}}"] }),
      ctx: ctx("see https://93.184.216.34/page"),
    });

    expect(result.outputs).toEqual(["summarized page"]);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://93.184.216.34/page",
      expect.objectContaining({
        headers: {
          Accept: "text/*,application/json,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "User-Agent": "OpenClaw-LinkUnderstanding/1.0",
        },
        redirect: "manual",
        signal: expect.any(AbortSignal),
      }),
    );
    expect(runCommandWithTimeout).toHaveBeenCalledWith(["summarize", "--source"], {
      env: {
        OPENCLAW_LINK_FINAL_URL: "https://example.com/final",
        OPENCLAW_LINK_URL: "https://93.184.216.34/page",
      },
      input: "page body",
      timeoutMs: 30000,
    });
  });

  it("returns fetched content directly for configured curl-style fetchers", async () => {
    mockFetchResponse("fetched page body");

    const result = await runLinkUnderstanding({
      cfg: cfg({
        type: "cli",
        command: "curl",
        args: ["-s", "-L", "{{LinkUrl}}"],
      }),
      ctx: ctx("see http://93.184.216.34/public-page"),
    });

    expect(result.outputs).toEqual(["fetched page body"]);
    expect(globalThis.fetch).toHaveBeenCalledOnce();
    expect(runCommandWithTimeout).not.toHaveBeenCalled();
  });

  it("blocks private link targets through the canonical untrusted URL guard", async () => {
    const result = await runLinkUnderstanding({
      cfg: cfg({ type: "cli", command: "summarize" }),
      ctx: ctx("see http://127.0.0.1:8080/admin"),
    });

    expect(result.outputs).toEqual([]);
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(runCommandWithTimeout).not.toHaveBeenCalled();
  });

  it("blocks metadata hostnames through the canonical untrusted URL guard", async () => {
    const result = await runLinkUnderstanding({
      cfg: cfg({ type: "cli", command: "summarize" }),
      ctx: ctx("see http://metadata.google.internal/latest/meta-data/"),
    });

    expect(result.outputs).toEqual([]);
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(runCommandWithTimeout).not.toHaveBeenCalled();
  });

  it("skips links rejected by HTTP status", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(new Response("no", { status: 500 }));

    const result = await runLinkUnderstanding({
      cfg: cfg({ type: "cli", command: "summarize" }),
      ctx: ctx("see https://public.example/redirect-to-metadata"),
    });

    expect(result.outputs).toEqual([]);
    expect(runCommandWithTimeout).not.toHaveBeenCalled();
  });
});
