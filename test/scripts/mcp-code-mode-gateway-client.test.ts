// Mcp Code Mode Gateway Client tests cover mcp code mode gateway client script behavior.
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  projectMcpCodeModeDiagnostics,
  readMcpCodeModeDiagnostics,
} from "../../scripts/e2e/lib/mcp-code-mode-diagnostics.ts";
import {
  extractMcpCodeModePlannedTools,
  validateMcpCodeModeResult,
} from "../../scripts/e2e/lib/mcp-code-mode-validation.ts";
import {
  fetchJson,
  readMcpCodeModeClientFetchLimits,
} from "../../scripts/e2e/mcp-code-mode-gateway-client.ts";

const okResponse = {
  output: [
    {
      type: "message",
      content: [
        {
          text: "MCP_CODE_MODE_FILE_OK note=fixture-note-alpha unclear=none",
        },
      ],
    },
  ],
};

const okMentions = {
  apiCall: 0,
  apiFileList: 1,
  apiFileRead: 2,
  mcpNamespace: 1,
  mcpTool: 1,
  toolSearchPollution: 0,
};

describe("MCP code-mode matched failure diagnostics", () => {
  const id = "call_mock_exec_0123456789";
  const user = {
    role: "user",
    content: [{ type: "input_text", text: "mcp code mode api file qa check:" }],
  };
  const call = {
    type: "function_call",
    name: "exec",
    call_id: id,
    arguments: '{"code":"return await MCP.fixture.lookupNote({ id: \'alpha\' });"}',
  };
  const record = (input: unknown[], seq = 1) => ({
    method: "POST",
    path: "/v1/responses",
    seq,
    body: JSON.stringify({ input }),
  });
  const output = { status: "failed", error: "TypeError: result.content is not a function" };

  it("binds only the current fixture exec output and its persisted pair before validation", () => {
    const diagnostics = projectMcpCodeModeDiagnostics(
      [
        record([user]),
        record(
          [
            user,
            call,
            { type: "function_call_output", call_id: "unrelated", output: "fixture-note-alpha" },
            { type: "function_call_output", call_id: id, output: JSON.stringify(output) },
          ],
          2,
        ),
      ],
      [
        { message: user },
        {
          message: {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: `${id}|fc_mock_exec_0123456789`,
                name: "exec",
                arguments: {},
              },
            ],
          },
        },
        {
          message: {
            role: "toolResult",
            toolCallId: "unrelated",
            content: [{ type: "text", text: "fixture-note-alpha" }],
          },
        },
        {
          message: {
            role: "toolResult",
            toolCallId: `${id}|fc_mock_exec_0123456789`,
            isError: true,
            content: [{ type: "text", text: JSON.stringify(output) }],
            details: output,
          },
        },
      ],
    );
    expect(diagnostics).toMatchObject({
      providerTurns: [
        { seq: 1, execCalls: [] },
        {
          seq: 2,
          unrelatedOutputs: 1,
          execCalls: [
            {
              callId: id,
              outputPresent: true,
              output: {
                terms: ["TypeError", "not a function"],
                json: { status: { state: "failed" } },
              },
            },
          ],
        },
      ],
      transcriptPairs: [
        {
          callId: id,
          callPresent: true,
          resultPresent: true,
          isError: true,
          details: { status: { state: "failed" } },
        },
      ],
    });
    expect(JSON.stringify(diagnostics)).not.toContain("fixture-note-alpha");
    expect(() => validateMcpCodeModeResult({ output: [] }, okMentions)).toThrow();
  });

  it("preserves content-array shape without printing credentials, paths, prompts, or unknown keys", () => {
    const privateText =
      "Bearer not-a-real-key https://private.example.invalid /Users/example/private@example.invalid";
    const diagnostics = projectMcpCodeModeDiagnostics(
      [
        record([
          user,
          call,
          {
            type: "function_call_output",
            call_id: id,
            output: [
              {
                type: "input_text",
                text: JSON.stringify({
                  status: "completed",
                  value: {
                    marker: "MCP_CODE_MODE_FILE_TOOL_RESULT",
                    note: "fixture-note-alpha",
                    privateText,
                    [privateText]: privateText,
                  },
                }),
              },
            ],
          },
        ]),
      ],
      [
        {
          message: {
            role: "toolResult",
            toolCallId: id,
            content: [{ type: "text", text: privateText }],
          },
        },
      ],
    );
    const serialized = JSON.stringify(diagnostics);
    expect(serialized).not.toContain(createHash("sha256").update(privateText).digest("hex"));
    expect(serialized).toContain('"kind":"array"');
    expect(serialized).toContain("MCP_CODE_MODE_FILE_TOOL_RESULT");
    expect(serialized).toContain("fixture-note-alpha");
    for (const secret of [
      "Bearer",
      "not-a-real-key",
      "private.example.invalid",
      "/Users/",
      "private@example.invalid",
      "privateText",
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("ignores historical fixture outputs and unrelated user turns", () => {
    expect(
      projectMcpCodeModeDiagnostics(
        [
          record([
            user,
            call,
            { type: "function_call_output", call_id: id, output: "fixture-note-alpha" },
            { role: "user", content: "another task" },
          ]),
          record([{ role: "user", content: "another task" }, call]),
        ],
        [],
      ),
    ).toEqual({
      providerTurns: [],
      transcriptPairs: [],
      transcriptFixtureTurnPresent: false,
      persistedExecWithoutSelectedWireCall: false,
      responsesRecordBodyTruncated: [],
      recordsTruncated: false,
    });
  });

  it("reports a persisted exec without a wire call instead of fabricating a matched pair", () => {
    const diagnostics = projectMcpCodeModeDiagnostics(
      [record([user, { type: "function_call_output", call_id: id, output: "fixture-note-alpha" }])],
      [
        { message: user },
        { message: { role: "assistant", content: [{ type: "toolCall", name: "exec", id }] } },
        { message: { role: "toolResult", toolCallId: id, content: "private-persisted-result" } },
      ],
    );
    expect(diagnostics).toMatchObject({
      persistedExecWithoutSelectedWireCall: true,
      transcriptPairs: [],
      providerTurns: [{ execCalls: [], unrelatedOutputs: 1 }],
    });
    expect(JSON.stringify(diagnostics)).not.toContain("private-persisted-result");
    expect(JSON.stringify(diagnostics)).not.toContain("fixture-note-alpha");
  });

  it("reports producer truncation without reading the preview or attributing it to current QA", () => {
    const body = {
      truncated: true,
      byteLength: 300_000,
      get preview(): never {
        throw new Error("private preview must not be read");
      },
    };
    expect(projectMcpCodeModeDiagnostics([{ ...record([], 7), body }], [])).toMatchObject({
      responsesRecordBodyTruncated: [{ seq: 7, byteLength: 300_000 }],
      providerTurns: [],
      transcriptPairs: [],
      transcriptFixtureTurnPresent: false,
    });
  });

  it("selects the newest same-marker attempt and does not export arbitrary call IDs or their hashes", () => {
    const privateId = "private-call-identity";
    const diagnostics = projectMcpCodeModeDiagnostics(
      [
        record([user], 1),
        record(
          [user, call, { type: "function_call_output", call_id: id, output: "fixture-note-alpha" }],
          2,
        ),
        record([user], 3),
        record(
          [
            user,
            { ...call, call_id: privateId },
            { type: "function_call_output", call_id: privateId, output: JSON.stringify(output) },
          ],
          4,
        ),
      ],
      [],
    );
    expect(diagnostics).toMatchObject({
      providerTurns: [
        { seq: 3 },
        {
          seq: 4,
          execCalls: [
            { callId: "selected-exec-1", output: { terms: ["TypeError", "not a function"] } },
          ],
        },
      ],
    });
    const serialized = JSON.stringify(diagnostics);
    for (const privateValue of [
      privateId,
      createHash("sha256").update(privateId).digest("hex"),
      "fixture-note-alpha",
    ]) {
      expect(serialized).not.toContain(privateValue);
    }
  });

  it("reports malformed and unreadable private logs without printing them or replacing validation", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "mcp-diagnostics-"));
    const file = path.join(dir, "requests.jsonl");
    try {
      await writeFile(file, `private-malformed-record\n${JSON.stringify(record([user]))}\n`);
      const diagnostics = await readMcpCodeModeDiagnostics(file, []);
      expect(diagnostics).toMatchObject({
        requestLog: "read",
        malformed: 1,
        providerTurns: [{ seq: 1 }],
      });
      expect(JSON.stringify(diagnostics)).not.toContain("private-malformed-record");
      await expect(readMcpCodeModeDiagnostics(path.join(dir, "missing"), [])).resolves.toEqual({
        requestLog: "unreadable",
      });
      await writeFile(file, "x".repeat(8 * 1024 * 1024 + 1));
      await expect(readMcpCodeModeDiagnostics(file, [])).resolves.toEqual({
        requestLog: "over-limit",
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("bounds turns and result structure, and reports missing logs without replacing the failure", async () => {
    const nested = { content: Array.from({ length: 100 }, () => ({ text: "x".repeat(40_000) })) };
    const largeRecord = record([
      user,
      call,
      { type: "function_call_output", call_id: id, output: nested },
    ]);
    const records = Array.from({ length: 300 }, () => largeRecord);
    const diagnostics = projectMcpCodeModeDiagnostics(records, []);
    expect(diagnostics).toMatchObject({ recordsTruncated: true, providerTurns: [{}, {}] });
    expect(Buffer.byteLength(JSON.stringify(diagnostics))).toBeLessThanOrEqual(32_768);
    await expect(readMcpCodeModeDiagnostics(undefined, [])).resolves.toEqual({
      requestLog: "not-configured",
    });
  });
});

describe("MCP code-mode gateway Docker client fetch helper", () => {
  it("rejects loose numeric env limits instead of parsing prefixes", () => {
    expect(() =>
      readMcpCodeModeClientFetchLimits({
        OPENCLAW_MCP_CODE_MODE_CLIENT_TIMEOUT_MS: "1e3",
      }),
    ).toThrow("invalid OPENCLAW_MCP_CODE_MODE_CLIENT_TIMEOUT_MS: 1e3");
    expect(() =>
      readMcpCodeModeClientFetchLimits({
        OPENCLAW_MCP_CODE_MODE_CLIENT_BODY_MAX_BYTES: "1000ms",
      }),
    ).toThrow("invalid OPENCLAW_MCP_CODE_MODE_CLIENT_BODY_MAX_BYTES: 1000ms");
    expect(
      readMcpCodeModeClientFetchLimits({
        OPENCLAW_MCP_CODE_MODE_CLIENT_BODY_MAX_BYTES: "4096",
        OPENCLAW_MCP_CODE_MODE_CLIENT_TIMEOUT_MS: "120000",
      }),
    ).toEqual({
      bodyMaxBytes: 4096,
      timeoutMs: 120_000,
    });
  });

  it("aborts requests that never resolve", async () => {
    let signal: AbortSignal | undefined;
    await expect(
      fetchJson("https://qa.example.invalid/v1/responses", undefined, {
        timeoutMs: 25,
        fetchImpl: async (_url, init) => {
          signal = init.signal as AbortSignal | undefined;
          return new Promise<Response>(() => {});
        },
      }),
    ).rejects.toMatchObject({
      code: "ETIMEDOUT",
      message: "HTTP request to https://qa.example.invalid/v1/responses timed out after 25ms",
    });
    expect(signal?.aborted).toBe(true);
  });

  it("times out while reading stalled response bodies", async () => {
    await expect(
      fetchJson("https://qa.example.invalid/v1/responses", undefined, {
        timeoutMs: 25,
        fetchImpl: async () =>
          new Response(new ReadableStream<Uint8Array>({ start() {} }), {
            status: 200,
          }),
      }),
    ).rejects.toMatchObject({
      code: "ETIMEDOUT",
      message: "HTTP request to https://qa.example.invalid/v1/responses timed out after 25ms",
    });
  });

  it("parses successful JSON responses", async () => {
    await expect(
      fetchJson("https://qa.example.invalid/v1/responses", undefined, {
        timeoutMs: 25,
        fetchImpl: async () => new Response('{"ok":true}', { status: 200 }),
      }),
    ).resolves.toEqual({ ok: true });
  });

  it("bounds oversized response bodies", async () => {
    await expect(
      fetchJson("https://qa.example.invalid/v1/responses", undefined, {
        maxBodyBytes: 16,
        timeoutMs: 1000,
        fetchImpl: async () =>
          new Response(JSON.stringify({ ok: true, padding: "x".repeat(128) }), {
            status: 200,
          }),
      }),
    ).rejects.toMatchObject({
      code: "ETOOBIG",
      message: "HTTP response from https://qa.example.invalid/v1/responses exceeded 16 bytes",
    });
  });
});

describe("MCP code-mode gateway Docker client result validation", () => {
  it("accepts final text backed by API file reads and MCP tool calls", () => {
    expect(validateMcpCodeModeResult(okResponse, okMentions)).toBe(
      "MCP_CODE_MODE_FILE_OK note=fixture-note-alpha unclear=none",
    );
  });

  it("rejects hallucinated success text that reports MCP failure", () => {
    expect(() =>
      validateMcpCodeModeResult(
        {
          output: [
            {
              type: "message",
              content: [
                {
                  text: "MCP_CODE_MODE_FILE_OK note=fixture-note-alpha but MCP failed",
                },
              ],
            },
          ],
        },
        okMentions,
      ),
    ).toThrow("agent reported MCP failure");
  });

  it("requires materialized MCP fixture tool evidence", () => {
    expect(() =>
      validateMcpCodeModeResult(okResponse, {
        ...okMentions,
        apiFileList: 0,
      }),
    ).toThrow("session log lacks API.list usage");
    expect(() =>
      validateMcpCodeModeResult(okResponse, {
        ...okMentions,
        mcpTool: 0,
      }),
    ).toThrow("session log lacks MCP.fixture.lookupNote call");
  });

  it("rejects MCP.$api and catalog.search fallback pollution", () => {
    expect(() =>
      validateMcpCodeModeResult(okResponse, {
        ...okMentions,
        apiCall: 1,
      }),
    ).toThrow("agent should not call MCP.$api");
    expect(() =>
      validateMcpCodeModeResult(okResponse, {
        ...okMentions,
        toolSearchPollution: 1,
      }),
    ).toThrow("agent should not use catalog.search");
  });

  it("requires planned exec evidence for the source gateway E2E", () => {
    expect(() =>
      validateMcpCodeModeResult(okResponse, okMentions, {
        plannedTools: ["catalog.search"],
        requireExec: true,
      }),
    ).toThrow("agent did not call code-mode exec");
    expect(() =>
      validateMcpCodeModeResult(okResponse, okMentions, {
        plannedTools: ["exec"],
        requireExec: true,
      }),
    ).not.toThrow();
  });

  it("rejects success and exec mentions without a real assistant tool call", () => {
    const plannedTools = extractMcpCodeModePlannedTools([
      {
        type: "message",
        message: {
          role: "user",
          content: [{ type: "toolCall", name: "exec" }],
        },
      },
      {
        type: "message",
        message: {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "I called exec, API.list, API.read, and MCP.fixture.lookupNote.",
            },
          ],
        },
      },
    ]);

    expect(plannedTools).toEqual([]);
    expect(() =>
      validateMcpCodeModeResult(okResponse, okMentions, {
        plannedTools,
        requireExec: true,
      }),
    ).toThrow("agent did not call code-mode exec");
  });

  it("accepts success backed by a structured assistant exec tool call", () => {
    const plannedTools = extractMcpCodeModePlannedTools([
      {
        type: "message",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "mcp-code-mode-exec",
              name: "exec",
              arguments: {
                code: 'return await MCP.fixture.lookupNote({ id: "alpha" });',
              },
            },
          ],
        },
      },
    ]);

    expect(plannedTools).toEqual(["exec"]);
    const result = validateMcpCodeModeResult(okResponse, okMentions, {
      plannedTools,
      requireExec: true,
    });
    expect(result).toBe("MCP_CODE_MODE_FILE_OK note=fixture-note-alpha unclear=none");
  });
});
