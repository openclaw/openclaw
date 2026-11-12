import { mkdirSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import * as nativeModule from "../plugins/native-module-require.js";
import { createPluginRuntime } from "../plugins/runtime/index.js";
import * as sdkAlias from "../plugins/sdk-alias.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createChatFixture, sendChatAndWait } from "./gateway-chat-fixture.test-support.js";
import { writeToolCall } from "./gateway-provider-fixture.test-support.js";
import { kernelGatewayTestStateOptions } from "./test-helpers.env.js";

const documents = [
  {
    title: "Document A",
    text: "The river restoration project planted native willows along the north bank.",
  },
  {
    title: "Document B",
    text: "The river restoration project planted native reeds along the south bank.",
  },
];
const question = "Compare the restoration activities in the supplied documents.";
const request = {
  question,
  engine: "portable",
  sources: { documents, web: false },
  budget: { modelCalls: 8 },
};

it.each([true, false])(
  "keeps explicit research selection and job policy with enabled=%s",
  { timeout: 240_000 },
  async (enabled) => {
    await withOpenClawTestState(kernelGatewayTestStateOptions("research-explicit"), async () => {
      const phase = process.env.OPENCLAW_RESEARCH_PROOF_PHASE ?? "head";
      const proof = path.resolve(
        ".openclaw/tmp/research-explicit/product-test",
        `${phase}${enabled ? "" : "-disabled"}`,
      );
      await fs.mkdir(proof, { recursive: true });
      const actions: Array<{ name: string; args: Record<string, unknown> }> = [];
      const receipts: string[] = [];
      const turns: Array<{ name: string; start: number; end: number }> = [];
      const negativeSelections: boolean[] = [];
      const fixture = createChatFixture("research-explicit", {
        configure(config, model) {
          const skillDir = path.join(config.agents!.defaults!.workspace!, "skills/literal-fixture");
          mkdirSync(skillDir, { recursive: true });
          writeFileSync(
            path.join(skillDir, "SKILL.md"),
            "---\nname: literal-fixture\ndescription: Synthetic selection fixture\nuser-invocable: true\ndisable-model-invocation: true\n---\nReturn FIXTURE_SELECTED.\n",
          );
          return {
            ...config,
            agents: {
              ownership: "explicit",
              entries: {
                main: {},
                denied: { skills: ["literal-fixture"] },
                notool: { tools: { deny: ["deep_research"] } },
              },
              defaults: {
                ...config.agents?.defaults,
                utilityModel: "",
                model: { primary: `openai/${model.modelId}` },
              },
            },
            models: {
              mode: "replace",
              providers: {
                openai: {
                  ...model.config,
                  agentRuntime: { id: "openclaw" },
                  request: { allowPrivateNetwork: true },
                },
              },
            },
            commands: { text: true },
            tools: { profile: "full", codeMode: { enabled: false }, toolSearch: false },
            plugins: {
              slots: { memory: "none" },
              allow: ["openai", "deep-research"],
              load: {
                paths: [
                  path.resolve("extensions/openai"),
                  path.resolve("extensions/deep-research"),
                ],
              },
              entries: { "deep-research": { enabled } },
            },
          };
        },
        async respond(raw, _session, response) {
          const body = JSON.parse(raw) as {
            input?: Array<{ role?: string; type?: string; output?: string; content?: unknown }>;
          };
          const text = JSON.stringify(body);
          if (text.includes("Plan research for the request below.")) {
            return JSON.stringify({ questions: [question] });
          }
          if (text.includes("Extract atomic findings for")) {
            return JSON.stringify({
              findings: documents.map((document, index) => ({
                statement: document.text,
                evidence: [{ sourceId: `S${index + 1}`, quote: document.text }],
              })),
              gaps: [],
              queries: [],
            });
          }
          if (text.includes("Independently audit each finding")) {
            return JSON.stringify({
              verdicts: documents.map((_, index) => ({
                index,
                verdict: "supported",
                reason: "Synthetic quote support",
              })),
              unanswered: [],
            });
          }
          const input = body.input ?? [];
          const user = JSON.stringify(input.filter((item) => item.role === "user"));
          if (!user.includes("Use the following explicitly referenced skills")) {
            return "NOT_SELECTED";
          }
          if (user.includes("- literal-fixture")) {
            return "FIXTURE_SELECTED";
          }
          const outputs = input.filter((item) => item.type === "function_call_output");
          let name: string;
          let args: Record<string, unknown>;
          if (!outputs.length) {
            const skillPath = user.match(/SKILL.md: ([^)]+)\)/)?.[1];
            expect(skillPath).toBeDefined();
            name = "read";
            args = { path: skillPath };
          } else if (outputs.length === 1) {
            expect(outputs[0]?.output).toContain("# Deep Research");
            expect(outputs[0]?.output).toContain("exhausted budget into a claim of completion");
            if (!text.includes('"name":"deep_research"')) {
              return "TOOL_UNAVAILABLE";
            }
            name = "deep_research";
            args = { action: "start", idempotencyKey: "research-explicit-document-job", request };
          } else {
            const output = outputs.at(-1)?.output ?? "";
            receipts.push(output);
            const jobId = output.match(/"jobId"\s*:\s*"([^"]+)"/)?.[1];
            expect(jobId).toBeDefined();
            if (outputs.length === 2) {
              name = "deep_research";
              args = { action: "result", jobId };
            } else {
              return "RETAINED_JOB_RESULT";
            }
          }
          actions.push({ name, args });
          writeToolCall(response, name, args);
          return undefined;
        },
      });
      // Keep the real plugin runtime in the fixture module graph, as its owner requires.
      const resolveRuntime = vi.spyOn(sdkAlias, "resolvePluginRuntimeModulePathWithDiagnostics");
      const nativeLoad = nativeModule.tryNativeRequireModule;
      vi.spyOn(nativeModule, "tryNativeRequireModule").mockImplementation((modulePath, options) =>
        modulePath === resolveRuntime.mock.results.at(-1)?.value?.resolvedPath
          ? { ok: true, moduleExport: { createPluginRuntime } }
          : nativeLoad(modulePath, options),
      );
      try {
        await fixture.start();
        const turn = async (name: string, message: string, agent = "main") => {
          const start = fixture.requests.length;
          await sendChatAndWait(
            fixture.client,
            `agent:${agent}:research-${name}`,
            message,
            120_000,
          );
          turns.push({ name, start, end: fixture.requests.length });
        };
        for (const [index, message] of [
          "What is research?",
          "Explain the phrase Deep Research.",
          String.raw`Explain \$deep-research without running it.`,
          "Explain `$deep-research` without running it.",
          "Example:\n```text\n$deep-research\n```",
          "Explain `$literal-fixture` without invoking it.",
        ].entries()) {
          const start = fixture.requests.length;
          await turn(`literal-${index}`, message);
          negativeSelections.push(
            fixture.requests
              .slice(start)
              .some((raw) => raw.includes("Use the following explicitly referenced skills")),
          );
        }
        expect(actions).toEqual([]);
        const input = `${question} No web; at most 8 model calls.\n${documents.map((document) => `${document.title}: ${document.text}`).join("\n")}`;
        for (const [index, invocation] of [
          "$deep-research",
          "/skill deep-research",
          "/deep_research",
        ].entries()) {
          await turn(`selected-${index}`, `${invocation} ${input}`);
        }
        expect(negativeSelections).toEqual([false, false, false, false, false, false]);
        expect(fixture.errors).toEqual([]);
        if (enabled) {
          expect(actions.map((action) => action.name)).toEqual(
            Array.from({ length: 3 }, () => ["read", "deep_research", "deep_research"]).flat(),
          );
          expect(JSON.parse(receipts.at(-1)!)).toMatchObject({
            state: "completed",
            result: {
              status: "completed",
              sources: documents.map(({ title, text }) => ({
                title,
                text,
                extraction: "supplied-text-v1",
              })),
              usage: { modelCalls: 3, searches: 0, fetches: 0 },
              route: { runtime: "isolated-agent-runtime" },
            },
          });
          const before = actions.length;
          await turn("denied", `$deep-research ${input}`, "denied");
          expect(actions).toHaveLength(before);
          await turn("notool", `$deep-research ${input}`, "notool");
          expect(actions.slice(before).map((action) => action.name)).toEqual(["read"]);
        } else {
          expect(actions).toEqual([]);
        }
      } finally {
        await fs.writeFile(
          path.join(proof, "actions.json"),
          JSON.stringify(
            { actions, receipts, turns, negativeSelections, errors: fixture.errors.map(String) },
            null,
            2,
          ),
        );
        for (const [index, raw] of fixture.requests.entries()) {
          await fs.writeFile(path.join(proof, `request-${index}.bin`), raw);
        }
        await fixture.close();
        vi.restoreAllMocks();
      }
    });
  },
);
