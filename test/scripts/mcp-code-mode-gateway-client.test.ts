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

const finalText = "MCP_CODE_MODE_FILE_OK note=fixture-note-alpha unclear=none";
const response = (text = finalText) => ({ output: [{ type: "message", content: [{ text }] }] });
const okResponse = response();
const textContent = (text: string, type = "text") => [{ type, text }];
const message = (role: string, content: unknown, fields = {}) => ({
  message: { role, content, ...fields },
});
const encoded = (value: unknown) => (typeof value === "string" ? value : JSON.stringify(value));
const wireOutput = (output: unknown, call_id: string, fields = {}) => ({
  type: "function_call_output",
  call_id,
  output,
  ...fields,
});

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
  const outputFor = (value: unknown, callId = id) => wireOutput(value, callId);
  const toolResult = (callId: string, text: string, fields = {}) =>
    message("toolResult", textContent(text), { toolCallId: callId, ...fields });

  it("binds only the current fixture exec output and its persisted pair before validation", () => {
    const diagnostics = projectMcpCodeModeDiagnostics(
      [
        record([user]),
        record(
          [
            user,
            call,
            outputFor("fixture-note-alpha", "unrelated"),
            outputFor(JSON.stringify(output)),
          ],
          2,
        ),
      ],
      [
        { message: user },
        message("assistant", [
          {
            type: "toolCall",
            id: `${id}|fc_mock_exec_0123456789`,
            name: "exec",
            arguments: {},
          },
        ]),
        toolResult("unrelated", "fixture-note-alpha"),
        toolResult(`${id}|fc_mock_exec_0123456789`, JSON.stringify(output), {
          isError: true,
          details: output,
        }),
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
          outputFor(
            textContent(
              JSON.stringify({
                status: "completed",
                value: {
                  marker: "MCP_CODE_MODE_FILE_TOOL_RESULT",
                  note: "fixture-note-alpha",
                  privateText,
                  [privateText]: privateText,
                },
              }),
              "input_text",
            ),
          ),
        ]),
      ],
      [toolResult(id, privateText)],
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
            outputFor("fixture-note-alpha"),
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
        record([user, call, outputFor("fixture-note-alpha")], 2),
        record([user], 3),
        record(
          [user, { ...call, call_id: privateId }, outputFor(JSON.stringify(output), privateId)],
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
    const largeRecord = record([user, call, outputFor(nested)]);
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
  const url = "https://qa.example.invalid/v1/responses";
  const fetchResponse = (body: BodyInit, options: Parameters<typeof fetchJson>[2] = {}) =>
    fetchJson(url, undefined, {
      timeoutMs: 25,
      ...options,
      fetchImpl: async () => new Response(body, { status: 200 }),
    });
  it("rejects loose numeric env limits instead of parsing prefixes", () => {
    for (const [name, value] of [
      ["TIMEOUT_MS", "1e3"],
      ["BODY_MAX_BYTES", "1000ms"],
    ]) {
      const key = `OPENCLAW_MCP_CODE_MODE_CLIENT_${name}`;
      expect(() => readMcpCodeModeClientFetchLimits({ [key]: value })).toThrow(
        `invalid ${key}: ${value}`,
      );
    }
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
      fetchResponse(new ReadableStream<Uint8Array>({ start() {} })),
    ).rejects.toMatchObject({
      code: "ETIMEDOUT",
      message: "HTTP request to https://qa.example.invalid/v1/responses timed out after 25ms",
    });
  });

  it("parses successful JSON responses", async () => {
    await expect(fetchResponse('{"ok":true}')).resolves.toEqual({ ok: true });
  });

  it("bounds oversized response bodies", async () => {
    await expect(
      fetchResponse(JSON.stringify({ ok: true, padding: "x".repeat(128) }), {
        maxBodyBytes: 16,
        timeoutMs: 1000,
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
  const nativeExec: Step = { ...exec, args: { input: code } };
  const wait: Step = { name: "wait", id: "fixture-wait", args: { runId: "fixture-run" } };
  const result: Step = { id: "fixture-exec", output: completed };
  const suspended: Step = { id: "fixture-exec", output: waiting };
  const resumed: Step = { id: "fixture-wait", output: completed };
  const inputText = (text: string) => ({ type: "input_text", text });
  const nativeOutput = (status = "Script completed", ...progress: string[]) =>
    [status + "\nWall time 0.1 seconds\nOutput:\n", ...progress, JSON.stringify(value)].map(
      inputText,
    );
  const resultWith = (output: unknown): Step => ({ id: "fixture-exec", output });
  const waitResult = (output: unknown): Step => ({ id: "fixture-wait", output });
  const afterWait = (output: unknown): Step[] => [exec, suspended, wait, waitResult(output)];
  const user = (attempt: string) => message("user", textContent(attempt));
  const transcript = (steps: Step[], attempt = marker) => [
    user(attempt),
    ...steps.map((step) =>
      "name" in step
        ? message("assistant", [
            {
              type: "toolCall",
              id: step.id,
              name: step.name,
              arguments:
                step.name === "wait" && step.args.cell_id
                  ? { arguments: JSON.stringify(step.args) }
                  : step.args,
            },
          ])
        : message("toolResult", textContent(encoded(step.output)), {
            toolCallId: step.id,
            isError: step.isError,
          }),
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
            toolOutput: encoded(step.output),
            toolOutputStructuredError: step.isError,
            body: {
              input: [
                { role: "user", content: textContent(attempt, "input_text") },
                wireOutput(step.output, step.id, { is_error: step.isError }),
              ],
            },
          },
    );
  const rawResult = (
    flags: readonly Record<string, boolean | undefined>[],
    snapshotError: boolean,
  ) => ({
    ...requests([result])[0],
    toolOutputStructuredError: snapshotError,
    body: {
      input: [
        { role: "user", content: marker },
        ...flags.map((flag) => wireOutput(completed, "fixture-exec", flag)),
      ],
    },
  });
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
  const providerResult = (records: unknown[]) =>
    validateMcpCodeModeResult(okResponse, extractMcpCodeModeRequestEvidence(records, marker));
  const rejectProvider = (records: unknown[], error = "no matched successful") =>
    expect(() => providerResult(records)).toThrow(error);

  for (const route of routes) {
    describe(route.name, () => {
      const validate = (steps: Step[]) =>
        validateMcpCodeModeResult(okResponse, route.extract(steps));
      const reject = (steps: Step[], error = "no matched successful") =>
        expect(() => validate(steps)).toThrow(error);
      it.each<[string, Step[], string]>([
        ["immediate", [exec, result], "fixture-exec"],
        ["one wait", afterWait(completed), "fixture-wait"],
        [
          "repeated wait",
          [
            ...afterWait(waiting),
            { ...wait, id: "fixture-wait-2" },
            { id: "fixture-wait-2", output: completed },
          ],
          "fixture-wait-2",
        ],
        [
          "completed wait with explicit matching run",
          afterWait({ ...completed, runId: "fixture-run" }),
          "fixture-wait",
        ],
      ])("accepts %s and reports only matched completion IDs", (_name, steps, completionId) => {
        expect(
          validate([{ name: "exec", id: "unrelated", args: { code: "return 1" } }, ...steps]),
        ).toEqual({
          finalText,
          matchedExecCallIds: ["fixture-exec"],
          matchedCompletionCallIds: [completionId],
        });
      });

      it("accepts the mock provider resultText projection", () => {
        const { note, ...fields } = value;
        expect(
          validate([
            exec,
            resultWith({ status: "completed", value: { ...fields, resultText: note } }),
          ]).matchedExecCallIds,
        ).toEqual(["fixture-exec"]);
      });

      it.each([0, 1, 2])("accepts Codex native completion after %i waits", (waits) => {
        const steps: Step[] = [nativeExec];
        let id = "fixture-exec";
        for (let index = 1; index <= waits; index++) {
          steps.push({
            id,
            output: [
              inputText(
                "Script running with cell ID native-cell\nWall time 0.1 seconds\nOutput:\n",
              ),
            ],
          });
          id = `native-wait-${index}`;
          steps.push({ name: "wait", id, args: { cell_id: "native-cell" } });
        }
        steps.push({
          id,
          output: nativeOutput("Script completed", "non-JSON progress before the final value"),
        });
        expect(validate(steps).matchedCompletionCallIds).toEqual([id]);
      });

      it.each(["Script failed", "Script terminated", "quoted text: Script completed"])(
        "rejects native %s even when a success payload follows",
        (status) => {
          reject([nativeExec, resultWith(nativeOutput(status))]);
        },
      );

      it("accepts the current command and run_id aliases", () => {
        expect(
          validate([
            { ...exec, args: { command: code, code: "" } },
            suspended,
            { ...wait, args: { run_id: "fixture-run" } },
            resumed,
          ]).matchedCompletionCallIds,
        ).toEqual(["fixture-wait"]);
      });

      it.each<[string, Step[]]>([
        ["missing result", [exec]],
        ["unrelated exec", [{ ...exec, args: { code: "return 1" } }, result]],
        ["mismatched result ID", [exec, { ...result, id: "another-call" }]],
        ["error result", [exec, { ...result, isError: true }]],
        ["failed outer status", [exec, resultWith({ ...completed, status: "failed" })]],
        [
          "malformed output",
          [exec, resultWith("MCP_CODE_MODE_FILE_TOOL_RESULT fixture-note-alpha")],
        ],
        ["nested success only", [exec, resultWith({ value: completed })]],
        ["result before call", [result, exec]],
        ["orphan wait", [wait, resumed]],
        ["wrong wait run", [exec, suspended, { ...wait, args: { runId: "other-run" } }, resumed]],
        ["completed wait from another run", afterWait({ ...completed, runId: "other-run" })],
        ["wait before suspension", [exec, wait, suspended, resumed]],
        ["failed wait", [exec, suspended, wait, { ...resumed, isError: true }]],
      ])("rejects %s despite success prose", (_name, steps) => {
        reject(steps);
      });

      it.each([
        { marker: "other" },
        { files: ["mcp/index.d.ts"] },
        { rootHasFixture: false },
        { headerHasLookup: false },
        { note: "wrong-note" },
      ])("rejects incomplete fixture payload %j", (override) => {
        reject([exec, resultWith({ status: "completed", value: { ...value, ...override } })]);
      });

      it.each([
        { name: "call", extra: { ...exec, args: { code: "return 1" } } },
        { name: "result", extra: { ...result, isError: true } },
      ])("rejects conflicting duplicate $name evidence even after success", ({ extra }) => {
        reject([exec, result, extra], "conflicting code-mode call evidence");
      });

      it("rejects divergent code/command aliases", () => {
        reject(
          [{ ...exec, args: { code, command: `${code}\nreturn 0` } }, result],
          "conflicting code-mode source aliases",
        );
      });

      it("rejects fallback pollution in an actual current call", () => {
        for (const polluted of ["MCP.$api()", 'catalog.search("lookup note")']) {
          reject([{ ...exec, args: { code: `${code}\n${polluted}` } }, result], "agent should not");
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
    const output = nativeOutput();
    const records = requests([nativeExec, resultWith(output)]);
    records[1]!.toolOutput = output.map((part) => part.text).join("\n");
    expect(providerResult(records).matchedCompletionCallIds).toEqual(["fixture-exec"]);
    const historical = {
      ...records[1],
      body: {
        input: [
          { type: "custom_tool_call_output", call_id: "fixture-exec", output },
          { role: "user", content: marker },
        ],
      },
    };
    rejectProvider([records[0], historical]);
  });

  it.each([false, true])("checks all same-ID provider outputs (native=%s)", (native) => {
    const output = native ? nativeOutput() : completed;
    const records = requests([native ? nativeExec : exec, { ...result, output }]);
    const input = records[1]!.body!.input;
    const duplicate = wireOutput(output, "fixture-exec", { is_error: undefined });
    input.push(duplicate);
    expect(providerResult(records).matchedCompletionCallIds).toEqual(["fixture-exec"]);
    duplicate.output = native
      ? [{ type: "input_text", text: "Script failed\nOutput:\n" }]
      : { ...completed, status: "failed" };
    for (const outputs of [input, [input[0]!, ...input.slice(1).toReversed()]]) {
      records[1]!.body = { input: outputs };
      rejectProvider(records, "conflicting code-mode call evidence");
    }
  });

  it.each([
    ["snake-case error", [{ is_error: true }]],
    ["camel-case error", [{ isError: true }]],
    ["error then success", [{ is_error: true }, { is_error: false }]],
    ["success then error", [{ is_error: false }, { is_error: true }]],
  ] as const)("retains each raw provider output's %s", (_name, flags) => {
    const expected =
      flags.length === 1 ? "no matched successful" : "conflicting code-mode call evidence";
    rejectProvider([...requests([exec]), rawResult(flags, false)], expected);
  });

  it("uses raw error-flag precedence and snapshot flags only without raw input", () => {
    const request = rawResult([{ is_error: false, isError: true }], true);
    const withCall = (entry: unknown) => [...requests([exec]), entry];
    expect(providerResult(withCall(request)).matchedCompletionCallIds).toEqual(["fixture-exec"]);
    rejectProvider(withCall({ ...request, body: undefined }));
    const fallback = { ...request, body: undefined, toolOutputStructuredError: false };
    expect(providerResult(withCall(fallback)).matchedCompletionCallIds).toEqual(["fixture-exec"]);
  });

  it("does not infer tool calls from prompt blocks or assistant prose", () => {
    const evidence = extractMcpCodeModeTranscriptEvidence(
      [
        message("user", [
          ...textContent(marker),
          { type: "toolCall", name: "exec", id: "fixture-exec", arguments: { code } },
        ]),
        message("assistant", textContent(code)),
        ...transcript([result]).slice(1),
      ],
      marker,
    );
    expect(() => validateMcpCodeModeResult(okResponse, evidence)).toThrow("no matched successful");
  });

  it("rejects a failed final answer even with matched completion evidence", () => {
    expect(() =>
      validateMcpCodeModeResult(
        response("MCP_CODE_MODE_FILE_OK note=fixture-note-alpha but MCP failed"),
        routes[0].extract([exec, result]),
      ),
    ).toThrow("agent reported MCP failure");
  });
});
