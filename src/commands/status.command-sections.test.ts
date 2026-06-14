1|// Status command section tests cover footer, health, and report section rendering.
2|import { describe, expect, it } from "vitest";
3|import type { HealthSummary } from "./health.js";
4|import {
5|  buildStatusFooterLines,
6|  buildStatusHealthRows,
7|  buildStatusModelSelectionLines,
8|  buildStatusPairingRecoveryLines,
9|  buildStatusPluginCompatibilityLines,
10|  buildStatusSecurityAuditLines,
11|  buildStatusSessionsRows,
12|  buildStatusSystemEventsRows,
13|  buildStatusSystemEventsTrailer,
14|  statusHealthColumns,
15|} from "./status.command-sections.ts";
16|
17|describe("status.command-sections", () => {
18|  it("formats security audit lines with finding caps and follow-up commands", () => {
19|    const lines = buildStatusSecurityAuditLines({
20|      securityAudit: {
21|        summary: { critical: 1, warn: 6, info: 2 },
22|        findings: [
23|          {
24|            severity: "warn",
25|            title: "Warn first",
26|            detail: "warn detail",
27|          },
28|          {
29|            severity: "critical",
30|            title: "Critical first",
31|            detail: "critical\ndetail",
32|            remediation: "fix it",
33|          },
34|          ...Array.from({ length: 5 }, (_, index) => ({
35|            severity: "warn" as const,
36|            title: `Warn ${index + 2}`,
37|            detail: `detail ${index + 2}`,
38|          })),
39|        ],
40|      },
41|      theme: {
42|        error: (value) => `error(${value})`,
43|        warn: (value) => `warn(${value})`,
44|        muted: (value) => `muted(${value})`,
45|      },
46|      shortenText: (value) => value,
47|      formatCliCommand: (value) => `cmd:${value}`,
48|    });
49|
50|    expect(lines[0]).toBe("muted(Summary: error(1 critical) · warn(6 warn) · muted(2 info))");
51|    expect(lines).toContain("  error(CRITICAL) Critical first");
52|    expect(lines).toContain("    critical detail");
53|    expect(lines).toContain("    muted(Fix: fix it)");
54|    expect(lines).toContain("muted(… +1 more)");
55|    expect(lines.at(-2)).toBe("muted(Full report: cmd:openclaw security audit)");
56|    expect(lines.at(-1)).toBe("muted(Deep probe: cmd:openclaw security audit --deep)");
57|  });
58|
59|  it("builds verbose sessions rows and returns no rows for empty sessions", () => {
60|    const verboseRows = buildStatusSessionsRows({
61|      recent: [
62|        {
63|          key: "session-key-1234567890",
64|          kind: "direct",
65|          updatedAt: 1,
66|          age: 5_000,
67|          model: "gpt-5.4",
68|          runtime: "OpenAI Codex",
69|          totalTokens: null,
70|          totalTokensFresh: false,
71|          remainingTokens: null,
72|          percentUsed: null,
73|          contextTokens: null,
74|          configuredModel: "openai/gpt-5.4",
75|          selectedModel: "openai/gpt-5.4",
76|          modelSelectionReason: null,
77|          flags: [],
78|        },
79|        {
80|          key: "agent:main:cron:daily-digest",
81|          kind: "cron",
82|          updatedAt: 2,
83|          age: 7_000,
84|          model: "gpt-5.5",
85|          runtime: "OpenClaw Default",
86|          totalTokens: null,
87|          totalTokensFresh: false,
88|          remainingTokens: null,
89|          percentUsed: null,
90|          contextTokens: null,
91|          configuredModel: "openai/gpt-5.5",
92|          selectedModel: "openai/gpt-5.5",
93|          modelSelectionReason: null,
94|          flags: [],
95|        },
96|      ],
97|      verbose: true,
98|      shortenText: (value) => value.slice(0, 8),
99|      formatTimeAgo: (value) => `${value}ms`,
100|      formatTokensCompact: () => "12k",
101|      formatPromptCacheCompact: () => "cache ok",
102|      muted: (value) => `muted(${value})`,
103|    });
104|
105|    expect(verboseRows).toEqual([
106|      {
107|        Key: "session-",
108|        Kind: "direct",
109|        Age: "5000ms",
110|        Model: "gpt-5.4",
111|        Runtime: "OpenAI Codex",
112|        Tokens: "12k",
113|        Cache: "cache ok",
114|      },
115|      {
116|        Key: "agent:ma",
117|        Kind: "cron",
118|        Age: "7000ms",
119|        Model: "gpt-5.5",
120|        Runtime: "OpenClaw Default",
121|        Tokens: "12k",
122|        Cache: "cache ok",
123|      },
124|    ]);
125|
126|    const emptyRows = buildStatusSessionsRows({
127|      recent: [],
128|      verbose: true,
129|      shortenText: (value) => value,
130|      formatTimeAgo: () => "",
131|      formatTokensCompact: () => "",
132|      formatPromptCacheCompact: () => null,
133|      muted: (value) => `muted(${value})`,
134|    });
135|
136|    expect(emptyRows).toEqual([]);
137|  });
138|
139|  it("shows configured default and selected session model when they differ", () => {
140|    const lines = buildStatusModelSelectionLines({
141|      recent: [
142|        {
143|          key: "agent:main:telegram:chat-1",
144|          kind: "direct",
145|          updatedAt: 1,
146|          age: 5_000,
147|          model: "deepseek-v4-flash",
148|          configuredModel: "zhipu/glm-4.5-air",
149|          selectedModel: "deepseek/deepseek-v4-flash",
150|          modelSelectionReason: "session override",
151|          runtime: "OpenClaw Default",
152|          totalTokens: null,
153|          totalTokensFresh: false,
154|          remainingTokens: null,
155|          percentUsed: null,
156|          contextTokens: null,
157|          flags: [],
158|        },
159|      ],
160|      shortenText: (value) => value,
161|      warn: (value) => `warn(${value})`,
162|      muted: (value) => `muted(${value})`,
163|    });
164|
165|    expect(lines).toEqual([
166|      "warn(Session agent:main:telegram:chat-1 is pinned to deepseek/deepseek-v4-flash; config primary zhipu/glm-4.5-air will apply to new/unpinned sessions.)",
167|      "  Configured default: zhipu/glm-4.5-air",
168|      "  Session selected: deepseek/deepseek-v4-flash",
169|      "  Reason: session override",
170|      "  Clear with: /model zhipu/glm-4.5-air or /reset",
171|      "  Docs: https://docs.openclaw.ai/concepts/models#selection-source-and-fallback-behavior",
172|    ]);
173|  });
174|
175|  it("maps health channel detail lines into status rows", () => {
176|    const rows = buildStatusHealthRows({
177|      health: { durationMs: 42 } as HealthSummary,
178|      formatHealthChannelLines: () => [
179|        "QuietChat: OK · ready",
180|        "WorkChat: failed · auth",
181|        "Forum: not configured",
182|        "Matrix: linked",
183|        "Pager: not linked",
184|      ],
185|      ok: (value) => `ok(${value})`,
186|      warn: (value) => `warn(${value})`,
187|      muted: (value) => `muted(${value})`,
188|    });
189|
190|    expect(rows).toEqual([
191|      { Item: "Gateway", Status: "ok(reachable)", Detail: "42ms" },
192|      { Item: "QuietChat", Status: "ok(OK)", Detail: "OK · ready" },
193|      { Item: "WorkChat", Status: "warn(WARN)", Detail: "failed · auth" },
194|      { Item: "Forum", Status: "muted(OFF)", Detail: "not configured" },
195|      { Item: "Matrix", Status: "ok(LINKED)", Detail: "linked" },
196|      { Item: "Pager", Status: "warn(UNLINKED)", Detail: "not linked" },
197|    ]);
198|  });
199|
200|  it("adds degraded event-loop health to status rows", () => {
201|    const rows = buildStatusHealthRows({
202|      health: {
203|        durationMs: 42,
204|        eventLoop: {
205|          degraded: true,
206|          reasons: ["event_loop_delay"],
207|          intervalMs: 62_000,
208|          delayP99Ms: 61_000,
209|          delayMaxMs: 62_000,
210|          utilization: 1,
211|          cpuCoreRatio: 1,
212|        },
213|      } as HealthSummary,
214|      formatHealthChannelLines: () => [],
215|      ok: (value) => `ok(${value})`,
216|      warn: (value) => `warn(${value})`,
217|      muted: (value) => `muted(${value})`,
218|    });
219|
220|    expect(rows).toEqual([
221|      { Item: "Gateway", Status: "ok(reachable)", Detail: "42ms" },
222|      {
223|        Item: "Event loop",
224|        Status: "warn(WARN)",
225|        Detail: "reasons event_loop_delay · max 62000ms · p99 61000ms · util 1 · cpu 1",
226|      },
227|    ]);
228|  });
229|
230|  it("builds footer lines from update and reachability state", () => {
231|    expect(
232|      buildStatusFooterLines({
233|        updateHint: "upgrade ready",
234|        warn: (value) => `warn(${value})`,
235|        formatCliCommand: (value) => `cmd:${value}`,
236|        nodeOnlyGateway: null,
237|        gatewayReachable: false,
238|      }),
239|    ).toEqual([
240|      "FAQ: https://docs.openclaw.ai/faq",
241|      "Troubleshooting: https://docs.openclaw.ai/troubleshooting",
242|      "",
243|      "warn(upgrade ready)",
244|      "Next steps:",
245|      "  Need to share?      cmd:openclaw status --all",
246|      "  Need to debug live? cmd:openclaw logs --follow",
247|      "  Fix reachability first: cmd:openclaw gateway probe",
248|    ]);
249|  });
250|
251|  it("builds plugin compatibility lines and pairing recovery guidance", () => {
252|    expect(
253|      buildStatusPluginCompatibilityLines({
254|        notices: [
255|          { severity: "warn" as const, message: "legacy" },
256|          { severity: "info" as const, message: "heads-up" },
257|          { severity: "warn" as const, message: "extra" },
258|        ],
259|        limit: 2,
260|        formatNotice: (notice) => notice.message,
261|        warn: (value) => `warn(${value})`,
262|        muted: (value) => `muted(${value})`,
263|      }),
264|    ).toEqual(["  warn(WARN) legacy", "  muted(INFO) heads-up", "muted(  … +1 more)"]);
265|
266|    expect(
267|      buildStatusPairingRecoveryLines({
268|        pairingRecovery: {
269|          requestId: "req-123",
270|          reason: "scope-upgrade",
271|          remediationHint: "Review the requested scopes, then approve the pending upgrade.",
272|        },
273|        warn: (value) => `warn(${value})`,
274|        muted: (value) => `muted(${value})`,
275|        formatCliCommand: (value) => `cmd:${value}`,
276|      }),
277|    ).toEqual([
278|      "warn(Gateway scope upgrade approval required.)",
279|      "muted(Reason: device is asking for more scopes than currently approved.)",
280|      "muted(Hint: Review the requested scopes, then approve the pending upgrade.)",
281|      "muted(Recovery: cmd:openclaw devices approve req-123)",
282|      "muted(Fallback: cmd:openclaw devices approve --latest)",
283|      "muted(Inspect: cmd:openclaw devices list)",
284|    ]);
285|  });
286|
287|  it("builds system event rows and health columns", () => {
288|    expect(
289|      buildStatusSystemEventsRows({
290|        queuedSystemEvents: ["one", "two", "three"],
291|        limit: 2,
292|      }),
293|    ).toEqual([{ Event: "one" }, { Event: "two" }]);
294|    expect(
295|      buildStatusSystemEventsTrailer({
296|        queuedSystemEvents: ["one", "two", "three"],
297|        limit: 2,
298|        muted: (value) => `muted(${value})`,
299|      }),
300|    ).toBe("muted(… +1 more)");
301|    expect(statusHealthColumns).toEqual([
302|      { key: "Item", header: "Item", minWidth: 10 },
303|      { key: "Status", header: "Status", minWidth: 8 },
304|      { key: "Detail", header: "Detail", flex: true, minWidth: 28 },
305|    ]);
306|  });
307|});
308|