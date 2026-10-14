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
  extractMcpCodeModeRequestEvidence,
  extractMcpCodeModeTranscriptEvidence,
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
    expect(() => validateMcpCodeModeResult({ output: [] }, [])).toThrow();
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

describe("MCP code-mode current-attempt completion proof", () => {
  const marker = "mcp code mode api file qa check: current-attempt";
  const code = [
    'const files = await API.list("mcp");',
    'const root = await API.read("mcp/index.d.ts");',
    'const api = await API.read("mcp/fixture.d.ts");',
    'const result = await MCP.fixture.lookupNote({ id: "alpha" });',
    "return { files, root, api, result };",
  ].join("\n");
  const value = {
    marker: "MCP_CODE_MODE_FILE_TOOL_RESULT",
    files: ["mcp/index.d.ts", "mcp/fixture.d.ts"],
    rootHasFixture: true,
    headerHasLookup: true,
    note: "fixture-note-alpha",
  };
  const completed = { status: "completed", value };
  const waiting = { status: "waiting", runId: "fixture-run" };
  type Step =
    | { name: string; id: string; args: Record<string, unknown> }
    | { id: string; output: unknown; isError?: boolean };
  const exec: Step = { name: "exec", id: "fixture-exec", args: { code } };
  const wait: Step = { name: "wait", id: "fixture-wait", args: { runId: "fixture-run" } };
  const result: Step = { id: "fixture-exec", output: completed };
  const user = (attempt: string) => ({
    message: { role: "user", content: [{ type: "text", text: attempt }] },
  });
  const transcript = (steps: Step[], attempt = marker) => [
    user(attempt),
    ...steps.map((step) =>
      "name" in step
        ? {
            message: {
              role: "assistant",
              content: [
                {
                  type: "toolCall",
                  id: step.id,
                  name: step.name,
                  arguments:
                    step.name === "wait" && step.args.cell_id
                      ? { arguments: JSON.stringify(step.args) }
                      : step.args,
                },
              ],
            },
          }
        : {
            message: {
              role: "toolResult",
              toolCallId: step.id,
              isError: step.isError,
              content: [
                {
                  type: "text",
                  text: typeof step.output === "string" ? step.output : JSON.stringify(step.output),
                },
              ],
            },
          },
    ),
  ];
  const requests = (steps: Step[], attempt = marker) =>
    steps.map((step) =>
      "name" in step
        ? {
            prompt: attempt,
            plannedToolName: step.name,
            plannedToolCallId: step.id,
            plannedToolArgs: step.args,
          }
        : {
            prompt: attempt,
            toolOutputCallId: step.id,
            toolOutput: typeof step.output === "string" ? step.output : JSON.stringify(step.output),
            toolOutputStructuredError: step.isError,
            body: {
              input: [
                { role: "user", content: [{ type: "input_text", text: attempt }] },
                {
                  type: "function_call_output",
                  call_id: step.id,
                  output: step.output,
                  is_error: step.isError,
                },
              ],
            },
          },
    );
  const routes = [
    {
      name: "persisted transcript",
      extract: (steps: Step[]) => extractMcpCodeModeTranscriptEvidence(transcript(steps), marker),
    },
    {
      name: "provider snapshots",
      extract: (steps: Step[]) => extractMcpCodeModeRequestEvidence(requests(steps), marker),
    },
  ] as const;

  for (const route of routes) {
    describe(route.name, () => {
      it.each([
        { name: "immediate", steps: [exec, result], completionId: "fixture-exec" },
        {
          name: "one wait",
          steps: [
            exec,
            { id: "fixture-exec", output: waiting },
            wait,
            { id: "fixture-wait", output: completed },
          ],
          completionId: "fixture-wait",
        },
        {
          name: "repeated wait",
          steps: [
            exec,
            { id: "fixture-exec", output: waiting },
            wait,
            { id: "fixture-wait", output: waiting },
            { ...wait, id: "fixture-wait-2" },
            { id: "fixture-wait-2", output: completed },
          ],
          completionId: "fixture-wait-2",
        },
        {
          name: "completed wait with explicit matching run",
          steps: [
            exec,
            { id: "fixture-exec", output: waiting },
            wait,
            { id: "fixture-wait", output: { ...completed, runId: "fixture-run" } },
          ],
          completionId: "fixture-wait",
        },
      ])("accepts $name and reports only matched completion IDs", ({ steps, completionId }) => {
        expect(
          validateMcpCodeModeResult(
            okResponse,
            route.extract([
              { name: "exec", id: "unrelated", args: { code: "return 1" } },
              ...steps,
            ]),
          ),
        ).toEqual({
          finalText: "MCP_CODE_MODE_FILE_OK note=fixture-note-alpha unclear=none",
          matchedExecCallIds: ["fixture-exec"],
          matchedCompletionCallIds: [completionId],
        });
      });

      it("accepts the mock provider resultText projection", () => {
        const { note, ...fields } = value;
        expect(
          validateMcpCodeModeResult(
            okResponse,
            route.extract([
              exec,
              {
                ...result,
                output: { status: "completed", value: { ...fields, resultText: note } },
              },
            ]),
          ).matchedExecCallIds,
        ).toEqual(["fixture-exec"]);
      });

      it.each([0, 1, 2])("accepts Codex native completion after %i waits", (waits) => {
        const steps: Step[] = [{ ...exec, args: { input: code } }];
        let id = "fixture-exec";
        for (let index = 1; index <= waits; index++) {
          steps.push({
            id,
            output: [
              {
                type: "input_text",
                text: "Script running with cell ID native-cell\nWall time 0.1 seconds\nOutput:\n",
              },
            ],
          });
          id = `native-wait-${index}`;
          steps.push({ name: "wait", id, args: { cell_id: "native-cell" } });
        }
        steps.push({
          id,
          output: [
            { type: "input_text", text: "Script completed\nWall time 0.1 seconds\nOutput:\n" },
            { type: "input_text", text: "non-JSON progress before the final value" },
            { type: "input_text", text: JSON.stringify(value) },
          ],
        });
        expect(
          validateMcpCodeModeResult(okResponse, route.extract(steps)).matchedCompletionCallIds,
        ).toEqual([id]);
      });

      it.each(["Script failed", "Script terminated", "quoted text: Script completed"])(
        "rejects native %s even when a success payload follows",
        (status) => {
          expect(() =>
            validateMcpCodeModeResult(
              okResponse,
              route.extract([
                { ...exec, args: { input: code } },
                {
                  id: "fixture-exec",
                  output: [
                    { type: "input_text", text: `${status}\nWall time 0.1 seconds\nOutput:\n` },
                    { type: "input_text", text: JSON.stringify(value) },
                  ],
                },
              ]),
            ),
          ).toThrow("no matched successful");
        },
      );

      it("accepts the current command and run_id aliases", () => {
        expect(
          validateMcpCodeModeResult(
            okResponse,
            route.extract([
              { ...exec, args: { command: code, code: "" } },
              { id: "fixture-exec", output: waiting },
              { ...wait, args: { run_id: "fixture-run" } },
              { id: "fixture-wait", output: completed },
            ]),
          ).matchedCompletionCallIds,
        ).toEqual(["fixture-wait"]);
      });

      it.each([
        { name: "missing result", steps: [exec] },
        { name: "unrelated exec", steps: [{ ...exec, args: { code: "return 1" } }, result] },
        { name: "mismatched result ID", steps: [exec, { ...result, id: "another-call" }] },
        { name: "error result", steps: [exec, { ...result, isError: true }] },
        {
          name: "failed outer status",
          steps: [exec, { ...result, output: { ...completed, status: "failed" } }],
        },
        {
          name: "malformed output",
          steps: [exec, { ...result, output: "MCP_CODE_MODE_FILE_TOOL_RESULT fixture-note-alpha" }],
        },
        { name: "nested success only", steps: [exec, { ...result, output: { value: completed } }] },
        { name: "result before call", steps: [result, exec] },
        { name: "orphan wait", steps: [wait, { id: "fixture-wait", output: completed }] },
        {
          name: "wrong wait run",
          steps: [
            exec,
            { id: "fixture-exec", output: waiting },
            { ...wait, args: { runId: "other-run" } },
            { id: "fixture-wait", output: completed },
          ],
        },
        {
          name: "completed wait from another run",
          steps: [
            exec,
            { id: "fixture-exec", output: waiting },
            wait,
            { id: "fixture-wait", output: { ...completed, runId: "other-run" } },
          ],
        },
        {
          name: "wait before suspension",
          steps: [
            exec,
            wait,
            { id: "fixture-exec", output: waiting },
            { id: "fixture-wait", output: completed },
          ],
        },
        {
          name: "failed wait",
          steps: [
            exec,
            { id: "fixture-exec", output: waiting },
            wait,
            { id: "fixture-wait", output: completed, isError: true },
          ],
        },
      ])("rejects $name despite success prose", ({ steps }) => {
        expect(() => validateMcpCodeModeResult(okResponse, route.extract(steps))).toThrow(
          "no matched successful",
        );
      });

      it.each([
        { marker: "other" },
        { files: ["mcp/index.d.ts"] },
        { rootHasFixture: false },
        { headerHasLookup: false },
        { note: "wrong-note" },
      ])("rejects incomplete fixture payload %j", (override) => {
        expect(() =>
          validateMcpCodeModeResult(
            okResponse,
            route.extract([
              exec,
              { ...result, output: { status: "completed", value: { ...value, ...override } } },
            ]),
          ),
        ).toThrow("no matched successful");
      });

      it.each([
        { name: "call", extra: { ...exec, args: { code: "return 1" } } },
        { name: "result", extra: { ...result, isError: true } },
      ])("rejects conflicting duplicate $name evidence even after success", ({ extra }) => {
        expect(() =>
          validateMcpCodeModeResult(okResponse, route.extract([exec, result, extra])),
        ).toThrow("conflicting code-mode call evidence");
      });

      it("rejects divergent code/command aliases", () => {
        expect(() =>
          validateMcpCodeModeResult(
            okResponse,
            route.extract([{ ...exec, args: { code, command: `${code}\nreturn 0` } }, result]),
          ),
        ).toThrow("conflicting code-mode source aliases");
      });

      it("rejects fallback pollution in an actual current call", () => {
        for (const polluted of ["MCP.$api()", 'catalog.search("lookup note")']) {
          expect(() =>
            validateMcpCodeModeResult(
              okResponse,
              route.extract([{ ...exec, args: { code: `${code}\n${polluted}` } }, result]),
            ),
          ).toThrow("agent should not");
        }
      });
    });
  }

  it("consumes a provider result before the wait planned in that same request", () => {
    const records = [
      ...requests([exec]),
      { ...requests([{ id: "fixture-exec", output: waiting }])[0], ...requests([wait])[0] },
      ...requests([{ id: "fixture-wait", output: completed }]),
    ];
    const evidence = extractMcpCodeModeRequestEvidence(
      records.flatMap((entry) => [entry, entry]),
      marker,
    );
    expect(validateMcpCodeModeResult(okResponse, evidence).matchedCompletionCallIds).toEqual([
      "fixture-wait",
    ]);
  });

  it("does not borrow historical same-fixture results when IDs are reused", () => {
    const oldMarker = "mcp code mode api file qa check: old-attempt";
    for (const evidence of [
      extractMcpCodeModeTranscriptEvidence(
        [...transcript([exec, result], oldMarker), ...transcript([exec])],
        marker,
      ),
      extractMcpCodeModeRequestEvidence(
        [...requests([exec, result], oldMarker), ...requests([exec])],
        marker,
      ),
      extractMcpCodeModeTranscriptEvidence(transcript([exec, result], oldMarker), marker),
      extractMcpCodeModeRequestEvidence(requests([exec, result], oldMarker), marker),
      extractMcpCodeModeRequestEvidence(requests([exec, result], `${marker}-other`), marker),
      extractMcpCodeModeTranscriptEvidence(
        [...transcript([exec, result]), user("another task")],
        marker,
      ),
    ]) {
      expect(() => validateMcpCodeModeResult(okResponse, evidence)).toThrow(
        "no matched successful",
      );
    }
  });

  it("uses current raw provider output rather than flattened or historical native output", () => {
    const nativeOutput = [
      { type: "input_text", text: "Script completed\nWall time 0.1 seconds\nOutput:\n" },
      { type: "input_text", text: JSON.stringify(value) },
    ];
    const records = requests([
      { ...exec, args: { input: code } },
      { ...result, output: nativeOutput },
    ]);
    records[1]!.toolOutput = nativeOutput.map((part) => part.text).join("\n");
    expect(
      validateMcpCodeModeResult(okResponse, extractMcpCodeModeRequestEvidence(records, marker))
        .matchedCompletionCallIds,
    ).toEqual(["fixture-exec"]);
    const historical = {
      ...records[1],
      body: {
        input: [
          { type: "custom_tool_call_output", call_id: "fixture-exec", output: nativeOutput },
          { role: "user", content: marker },
        ],
      },
    };
    expect(() =>
      validateMcpCodeModeResult(
        okResponse,
        extractMcpCodeModeRequestEvidence([records[0], historical], marker),
      ),
    ).toThrow("no matched successful");
  });

  it.each([false, true])("checks all same-ID provider outputs (native=%s)", (native) => {
    const output = native
      ? [
          { type: "input_text", text: "Script completed\nWall time 0.1 seconds\nOutput:\n" },
          { type: "input_text", text: JSON.stringify(value) },
        ]
      : completed;
    const records = requests([
      { ...exec, args: native ? { input: code } : { code } },
      { ...result, output },
    ]);
    const input = records[1]!.body!.input;
    const duplicate = {
      type: "function_call_output",
      call_id: "fixture-exec",
      output,
      is_error: undefined,
    };
    input.push(duplicate);
    expect(
      validateMcpCodeModeResult(okResponse, extractMcpCodeModeRequestEvidence(records, marker))
        .matchedCompletionCallIds,
    ).toEqual(["fixture-exec"]);
    duplicate.output = native
      ? [{ type: "input_text", text: "Script failed\nOutput:\n" }]
      : { ...completed, status: "failed" };
    for (const outputs of [input, [input[0]!, ...input.slice(1).toReversed()]]) {
      records[1]!.body = { input: outputs };
      expect(() =>
        validateMcpCodeModeResult(okResponse, extractMcpCodeModeRequestEvidence(records, marker)),
      ).toThrow("conflicting code-mode call evidence");
    }
  });

  it.each([
    { name: "snake-case error", flags: [{ is_error: true }], expected: "no matched successful" },
    { name: "camel-case error", flags: [{ isError: true }], expected: "no matched successful" },
    {
      name: "error then success",
      flags: [{ is_error: true }, { is_error: false }],
      expected: "conflicting code-mode call evidence",
    },
    {
      name: "success then error",
      flags: [{ is_error: false }, { is_error: true }],
      expected: "conflicting code-mode call evidence",
    },
  ])("retains each raw provider output's $name", ({ flags, expected }) => {
    const records = [
      ...requests([exec]),
      {
        ...requests([result])[0],
        toolOutputStructuredError: false,
        body: {
          input: [
            { role: "user", content: marker },
            ...flags.map((flag) => ({
              type: "function_call_output",
              call_id: "fixture-exec",
              output: completed,
              ...flag,
            })),
          ],
        },
      },
    ];
    expect(() =>
      validateMcpCodeModeResult(okResponse, extractMcpCodeModeRequestEvidence(records, marker)),
    ).toThrow(expected);
  });

  it("uses raw error-flag precedence and snapshot flags only without raw input", () => {
    const request = {
      ...requests([result])[0],
      toolOutputStructuredError: true,
      body: {
        input: [
          { role: "user", content: marker },
          {
            type: "function_call_output",
            call_id: "fixture-exec",
            output: completed,
            is_error: false,
            isError: true,
          },
        ],
      },
    };
    const extract = (entry: unknown) =>
      extractMcpCodeModeRequestEvidence([...requests([exec]), entry], marker);
    expect(
      validateMcpCodeModeResult(okResponse, extract(request)).matchedCompletionCallIds,
    ).toEqual(["fixture-exec"]);
    expect(() =>
      validateMcpCodeModeResult(okResponse, extract({ ...request, body: undefined })),
    ).toThrow("no matched successful");
    expect(
      validateMcpCodeModeResult(
        okResponse,
        extract({ ...request, body: undefined, toolOutputStructuredError: false }),
      ).matchedCompletionCallIds,
    ).toEqual(["fixture-exec"]);
  });

  it("does not infer tool calls from prompt blocks or assistant prose", () => {
    const evidence = extractMcpCodeModeTranscriptEvidence(
      [
        {
          message: {
            role: "user",
            content: [
              { type: "text", text: marker },
              { type: "toolCall", name: "exec", id: "fixture-exec", arguments: { code } },
            ],
          },
        },
        { message: { role: "assistant", content: [{ type: "text", text: code }] } },
        ...transcript([result]).slice(1),
      ],
      marker,
    );
    expect(() => validateMcpCodeModeResult(okResponse, evidence)).toThrow("no matched successful");
  });

  it("rejects a failed final answer even with matched completion evidence", () => {
    expect(() =>
      validateMcpCodeModeResult(
        {
          output: [
            {
              type: "message",
              content: [{ text: "MCP_CODE_MODE_FILE_OK note=fixture-note-alpha but MCP failed" }],
            },
          ],
        },
        routes[0].extract([exec, result]),
      ),
    ).toThrow("agent reported MCP failure");
  });
});
