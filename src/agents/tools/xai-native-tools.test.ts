/**
 * Tests for xAI native tools: xai_search and xai_code_exec.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createXaiCodeExecTool, createXaiSearchTool } from "./xai-native-tools.js";

// Mock the web-shared module's withTimeout to return undefined
vi.mock("./web-shared.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./web-shared.js")>();
  return {
    ...actual,
    withTimeout: () => undefined,
    readResponseText: async (res: Response) => ({ text: await res.text() }),
  };
});

const makeOkResponse = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

const makeErrorResponse = (status: number, body: string) => new Response(body, { status });

describe("createXaiSearchTool", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
    vi.stubEnv("XAI_API_KEY", "test-xai-key");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("returns null when XAI_API_KEY is not set", () => {
    vi.stubEnv("XAI_API_KEY", "");
    const tool = createXaiSearchTool({ config: {} as never });
    expect(tool).toBeNull();
  });

  it("returns null when search.enabled is false", () => {
    const tool = createXaiSearchTool({
      config: { tools: { xai: { search: { enabled: false } } } } as never,
    });
    expect(tool).toBeNull();
  });

  it("creates a tool with correct name and description", () => {
    const tool = createXaiSearchTool({ config: {} as never });
    expect(tool).not.toBeNull();
    expect(tool!.name).toBe("xai_search");
    expect(tool!.label).toBe("X Search");
    expect(tool!.description).toContain("X (Twitter)");
  });

  it("calls the xAI Responses API with x_search tool type", async () => {
    const responseBody = {
      output: [
        {
          type: "message",
          content: [
            {
              type: "output_text",
              text: "Here are posts about AI from X.",
              annotations: [{ type: "url_citation", url: "https://x.com/post/1" }],
            },
          ],
        },
      ],
    };
    fetchSpy.mockResolvedValueOnce(makeOkResponse(responseBody));

    const tool = createXaiSearchTool({ config: {} as never });
    expect(tool).not.toBeNull();

    const result = await tool!.execute("call-1", { query: "AI trends" }, undefined, undefined);
    expect(result).toBeDefined();

    // Verify fetch was called with correct endpoint and tool type
    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe("https://api.x.ai/v1/responses");
    expect(init?.method).toBe("POST");

    const body = JSON.parse(init?.body as string);
    expect(body.tools).toEqual([{ type: "x_search" }]);
    expect(body.input[0].content).toContain("AI trends");
  });

  it("returns structured result with content and citations", async () => {
    const responseBody = {
      output: [
        {
          type: "message",
          content: [
            {
              type: "output_text",
              text: "Grok summary of X posts.",
              annotations: [{ type: "url_citation", url: "https://x.com/post/42" }],
            },
          ],
        },
      ],
      citations: ["https://x.com/post/42"],
    };
    fetchSpy.mockResolvedValueOnce(makeOkResponse(responseBody));

    const tool = createXaiSearchTool({ config: {} as never });
    const result = await tool!.execute("call-2", { query: "test query" }, undefined, undefined);

    // Result should be an AgentToolResult with content array
    const content = (result as { content?: Array<{ type: string; text?: string }> }).content;
    expect(Array.isArray(content)).toBe(true);
    const text = content?.find((c) => c.type === "text")?.text;
    expect(text).toBeDefined();

    const parsed = JSON.parse(text!);
    expect(parsed.query).toBe("test query");
    expect(parsed.tool).toBe("x_search");
    expect(Array.isArray(parsed.citations)).toBe(true);
    expect(parsed.citations).toContain("https://x.com/post/42");
  });

  it("returns error result on API failure", async () => {
    fetchSpy.mockResolvedValueOnce(makeErrorResponse(429, "Rate limited"));

    const tool = createXaiSearchTool({ config: {} as never });
    await expect(tool!.execute("call-err", { query: "q" }, undefined, undefined)).rejects.toThrow(
      "xAI Responses API error (429)",
    );
  });

  it("uses custom model from config", async () => {
    fetchSpy.mockResolvedValueOnce(
      makeOkResponse({
        output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }],
      }),
    );

    const tool = createXaiSearchTool({
      config: { tools: { xai: { model: "grok-4-fast" } } } as never,
    });
    await tool!.execute("call-model", { query: "q" }, undefined, undefined);

    const body = JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.model).toBe("grok-4-fast");
  });

  it("skips cache when timeSensitive is true and calls API each time", async () => {
    const responseBody = {
      output: [
        {
          type: "message",
          content: [{ type: "output_text", text: "Fresh results." }],
        },
      ],
    };
    fetchSpy
      .mockResolvedValueOnce(makeOkResponse(responseBody))
      .mockResolvedValueOnce(makeOkResponse(responseBody));

    const tool = createXaiSearchTool({ config: {} as never });
    expect(tool).not.toBeNull();

    await tool!.execute(
      "call-1",
      { query: "breaking news", timeSensitive: true },
      undefined,
      undefined,
    );
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    await tool!.execute(
      "call-2",
      { query: "breaking news", timeSensitive: true },
      undefined,
      undefined,
    );
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("uses cache for non-time-sensitive queries (same cacheKey for read and write)", async () => {
    const responseBody = {
      output: [
        {
          type: "message",
          content: [{ type: "output_text", text: "Cached summary." }],
        },
      ],
    };
    fetchSpy.mockResolvedValueOnce(makeOkResponse(responseBody));

    const tool = createXaiSearchTool({ config: {} as never });
    expect(tool).not.toBeNull();

    await tool!.execute("call-1", { query: "stable topic" }, undefined, undefined);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const result2 = await tool!.execute("call-2", { query: "stable topic" }, undefined, undefined);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const content2 = (result2 as { content?: Array<{ type: string; text?: string }> }).content;
    const text2 = content2?.find((c) => c.type === "text")?.text;
    expect(text2).toBeDefined();
    const parsed2 = JSON.parse(text2!);
    expect(parsed2.cached).toBe(true);
  });
});

describe("createXaiCodeExecTool", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
    vi.stubEnv("XAI_API_KEY", "test-xai-key");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("returns null when XAI_API_KEY is not set", () => {
    vi.stubEnv("XAI_API_KEY", "");
    const tool = createXaiCodeExecTool({ config: {} as never });
    expect(tool).toBeNull();
  });

  it("returns null when codeExec.enabled is false", () => {
    const tool = createXaiCodeExecTool({
      config: { tools: { xai: { codeExec: { enabled: false } } } } as never,
    });
    expect(tool).toBeNull();
  });

  it("creates a tool with correct name and description", () => {
    const tool = createXaiCodeExecTool({ config: {} as never });
    expect(tool).not.toBeNull();
    expect(tool!.name).toBe("xai_code_exec");
    expect(tool!.label).toBe("xAI Code Exec");
    expect(tool!.description).toContain("Python");
  });

  it("calls xAI API with code_exec_python tool type", async () => {
    const responseBody = {
      output: [
        { type: "code_exec_result", stdout: "42\n", stderr: "", return_code: 0 },
        {
          type: "message",
          content: [{ type: "output_text", text: "The answer is 42." }],
        },
      ],
    };
    fetchSpy.mockResolvedValueOnce(makeOkResponse(responseBody));

    const tool = createXaiCodeExecTool({ config: {} as never });
    await tool!.execute("call-code", { task: "calculate 6*7" }, undefined, undefined);

    const body = JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.tools).toEqual([{ type: "code_exec_python" }]);
    expect(body.input[0].content).toContain("calculate 6*7");
  });

  it("returns structured result with stdout, returnCode, and summary", async () => {
    const responseBody = {
      output: [
        { type: "code_exec_result", stdout: "Hello, World!\n", stderr: "", return_code: 0 },
        {
          type: "message",
          content: [{ type: "output_text", text: "Printed Hello World." }],
        },
      ],
    };
    fetchSpy.mockResolvedValueOnce(makeOkResponse(responseBody));

    const tool = createXaiCodeExecTool({ config: {} as never });
    const result = await tool!.execute("call-exec", { task: "print hello" }, undefined, undefined);

    const content = (result as { content?: Array<{ type: string; text?: string }> }).content;
    const text = content?.find((c) => c.type === "text")?.text;
    expect(text).toBeDefined();

    const parsed = JSON.parse(text!);
    expect(parsed.returnCode).toBe(0);
    expect(parsed.stdout).toBe("Hello, World!\n");
    expect(parsed.summary).toBe("Printed Hello World.");
    expect(parsed.success).toBe(true);
    expect(parsed.tool).toBe("code_exec_python");
  });

  it("includes hint in prompt when provided", async () => {
    fetchSpy.mockResolvedValueOnce(
      makeOkResponse({
        output: [{ type: "code_exec_result", stdout: "", stderr: "", return_code: 0 }],
      }),
    );

    const tool = createXaiCodeExecTool({ config: {} as never });
    await tool!.execute(
      "call-hint",
      { task: "sort a list", hint: "use Python's built-in sort()" },
      undefined,
      undefined,
    );

    const body = JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.input[0].content).toContain("sort a list");
    expect(body.input[0].content).toContain("use Python's built-in sort()");
  });

  it("treats missing code_exec_result as failure (returnCode non-zero, stderr set)", async () => {
    fetchSpy.mockResolvedValueOnce(
      makeOkResponse({
        output: [{ type: "message", content: [{ type: "output_text", text: "No code result." }] }],
      }),
    );

    const tool = createXaiCodeExecTool({ config: {} as never });
    const result = await tool!.execute("call-missing", { task: "print 1" }, undefined, undefined);

    const content = (result as { content?: Array<{ type: string; text?: string }> }).content;
    const text = content?.find((c) => c.type === "text")?.text;
    expect(text).toBeDefined();

    const parsed = JSON.parse(text!);
    expect(parsed.returnCode).not.toBe(0);
    expect(parsed.success).toBe(false);
    expect(parsed.stderr).toContain("Missing code_exec_result");
  });
});
