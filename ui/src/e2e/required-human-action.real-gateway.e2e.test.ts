import { readFile, writeFile } from "node:fs/promises";
// Real Gateway + UI with a scripted model and synthetic external manual-step owner.
// No live credentials, native OS permission grant, or desktop takeover is claimed.
import { createServer } from "node:http";
import path from "node:path";
import { text } from "node:stream/consumers";
import { expect, it } from "vitest";
import { stampConfigWriteMetadata } from "../../../src/config/io.meta.ts";
import { reserveTestPortListener } from "../../../src/test-utils/port-claims.ts";
import {
  writeOpenAiResponsesSse,
  writeOpenAiResponsesText,
} from "../../../test/helpers/openai-responses-sse.ts";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../../test/helpers/openclaw-test-instance.ts";
import { pairControlUiPage } from "../test-helpers/control-ui-browser-pairing.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { evaluateControlUiContext } from "../test-helpers/control-ui-e2e-context.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { controlUiSessionUrl } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const proof = createControlUiE2eArtifactDir("required-human-action");
const ids = [
  "manual-success",
  "manual-still-blocked",
  "manual-cancelled",
  "manual-in-panel",
] as const;
const jobs = new Map(
  ids.map((id) => [id, { stage: 0, ready: false, effects: 0, checks: 0, modelRequests: 0 }]),
);
let instance: OpenClawTestInstance;
let origin: string;
let lease: Awaited<ReturnType<typeof reserveTestPortListener>>;
function tool(
  response: import("node:http").ServerResponse,
  name: string,
  args: object,
  id: string,
) {
  const item = {
    type: "function_call",
    name,
    arguments: JSON.stringify(args),
    id: "fc_" + id,
    call_id: "call_" + id,
  };
  writeOpenAiResponsesSse(response, [
    { type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } },
    {
      type: "response.function_call_arguments.delta",
      output_index: 0,
      item_id: item.id,
      delta: item.arguments,
    },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id: "response_" + id,
        status: "completed",
        output: [item],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    },
  ]);
}
const upstream = createServer((request, response) => {
  void (async () => {
    const url = new URL(request.url ?? "/", origin);
    const json = (value: unknown, status = 200) =>
      response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
    if (url.pathname === "/v1/models") {
      return json({ data: [{ id: "manual" }] });
    }
    const id = ids.find((candidate) => candidate === url.searchParams.get("case"));
    const job = id ? jobs.get(id) : undefined;
    if (url.pathname === "/manual" && job && id) {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(
        '<h1>Required manual step</h1><p>Synthetic operator-only setup step; not a login or approval.</p><form method="POST" action="/complete?case=' +
          id +
          '"><button>Complete manual step</button></form>',
      );
      return;
    }
    if (url.pathname === "/complete" && job && request.method === "POST") {
      job.ready = true;
      response
        .writeHead(200, { "content-type": "text/html" })
        .end("<h1>Manual step completed</h1><p>Return to the original chat for verification.</p>");
      return;
    }
    if (url.pathname === "/check" && job) {
      job.checks++;
      return json({ ready: job.ready });
    }
    if (url.pathname === "/effect" && job) {
      if (!job.ready) {
        return json({ completed: false }, 409);
      }
      job.effects++;
      return json({ completed: true });
    }
    if (url.pathname === "/v1/responses") {
      const body = JSON.parse(await text(request));
      const input = JSON.stringify(body.input);
      const caseId = ids.find((candidate) => input.includes(candidate));
      const state = caseId ? jobs.get(caseId) : undefined;
      if (!state || !caseId) {
        return json({ error: { message: "Unknown synthetic task" } }, 400);
      }
      state.modelRequests++;
      const command = (code: string) => "node -e " + JSON.stringify(code);
      const check =
        "fetch(" + JSON.stringify(origin + "/check?case=" + caseId) + ").then(r=>r.json())";
      if (state.stage === 0) {
        state.stage = 1;
        return tool(
          response,
          "exec",
          {
            command:
              "printf progress >> " +
              caseId +
              ".txt; " +
              command(
                check +
                  '.then(v=>console.log(v.ready?"MANUAL_STEP_READY":"MANUAL_STEP_UNRESOLVED"))',
              ),
            workdir: instance.state.workspaceDir,
          },
          caseId + "-progress",
        );
      }
      if (state.stage === 1) {
        state.stage = 2;
        return tool(
          response,
          "ask_user",
          {
            requiredAction: {
              reason:
                "The external app reports that the required manual setup step is unresolved for " +
                caseId +
                ".",
              instructions:
                caseId === "manual-in-panel"
                  ? "Complete the manual step in the already selected app, then return for a fresh check."
                  : "Open the supported app page and complete its manual setup step, then return for a fresh check.",
              ...(caseId === "manual-in-panel" ? {} : { url: origin + "/manual?case=" + caseId }),
            },
          },
          caseId + "-handoff",
        );
      }
      if (state.stage === 2 && input.includes("ready_to_verify")) {
        state.stage = 3;
        return tool(
          response,
          "exec",
          {
            command: command(
              check +
                '.then(async v=>{if(!v.ready){console.log("MANUAL_STEP_UNRESOLVED");return;}const r=await fetch(' +
                JSON.stringify(origin + "/effect?case=" + caseId) +
                ');console.log(r.ok?"TASK_EFFECT_COMPLETE":"MANUAL_STEP_UNRESOLVED");})',
            ),
            workdir: instance.state.workspaceDir,
          },
          caseId + "-verify",
        );
      }
      const result = input.includes("action_unresolved")
        ? "Required step stopped; dependent work was not resumed for " + caseId + "."
        : state.ready
          ? "Original task continued after verification for " +
            caseId +
            "; recorded progress was not repeated."
          : "The prerequisite is still unresolved for " +
            caseId +
            "; no dependent effect was performed.";
      return writeOpenAiResponsesText(response, {
        text: result,
        messageId: caseId + "-final",
        responseId: caseId + "-response-final",
      });
    }
    response.writeHead(404).end();
  })().catch(() => {
    if (!response.headersSent) {
      response.writeHead(500);
    }
    response.end();
  });
});
const suite = createControlUiE2eSuite({
  name: "Required human action preserves the original task",
  startServerBeforeBrowser: true,
  async startServer() {
    lease = await reserveTestPortListener({ offsets: [0], createListener: () => upstream });
    origin = "http://127.0.0.1:" + lease.claim.port;
    instance = await createOpenClawTestInstance({
      name: "required-human-action",
      env: { OPENCLAW_TEST_MINIMAL_GATEWAY: undefined, VITEST: undefined },
      config: stampConfigWriteMetadata(
        {
          gateway: { controlUi: { enabled: true } },
          update: { checkOnStart: false },
          cron: { enabled: false },
          tools: {
            profile: "full",
            codeMode: false,
            toolSearch: false,
            exec: { host: "gateway", mode: "full" },
          },
          agents: {
            defaults: {
              model: "manual-fixture/manual",
              modelPolicy: { allow: ["manual-fixture/*"] },
            },
            entries: { main: {} },
          },
          models: {
            catalogRefresh: { enabled: false },
            providers: {
              "manual-fixture": {
                api: "openai-responses",
                apiKey: "synthetic-manual-fixture-key",
                baseUrl: origin + "/v1",
                models: [
                  {
                    id: "manual",
                    name: "Scripted manual-step model",
                    reasoning: false,
                    input: ["text"],
                    contextWindow: 131072,
                    maxTokens: 4096,
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  },
                ],
              },
            },
          },
          plugins: { allow: [] },
        },
        "2026.11.3",
        {},
      ),
    });
    const close = async () => {
      try {
        await instance.cleanup();
      } finally {
        upstream.closeAllConnections();
        await lease.releaseListener();
        await lease.claim.release();
      }
    };
    try {
      await instance.startGateway();
    } catch (error) {
      await close();
      throw error;
    }
    return { baseUrl: "http://127.0.0.1:" + instance.port + "/", close };
  },
});

suite.define(() => {
  it.each(ids)("keeps %s task-bound and requires a real recheck", async (caseId) => {
    await suite.withPage(
      { viewport: { width: 1280, height: 900 }, locale: "en-US", serviceWorkers: "block" },
      async ({ page, context }) => {
        await pairControlUiPage(page, async (args) => {
          const result = await instance.cli(args);
          expect(result.code, result.stderr).toBe(0);
          return result.stdout;
        });
        const key = "agent:main:" + caseId;
        const rpc = <T = unknown>(method: string, params: Record<string, unknown>) =>
          evaluateControlUiContext(
            page,
            (app, input) => app.gateway.snapshot.client!.request<T>(input.method, input.params),
            { method, params },
          );
        await rpc("sessions.create", {
          key,
          agentId: "main",
          label: "Required manual step " + caseId,
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, key, "chat"));
        await waitForControlUiGatewayReady(page);
        await rpc("chat.send", {
          sessionKey: key,
          message:
            "For " +
            caseId +
            ", record progress once, complete the app-dependent task, and continue after the required human-only step. The task is already authorized.",
          idempotencyKey: caseId + "-original",
        });
        const panel = page
          .locator(".chat-question-panel")
          .filter({ hasText: "required manual setup step" });
        await panel.waitFor();
        const state = jobs.get(caseId)!;
        expect(state.effects).toBe(0);
        expect(
          await readFile(path.join(instance.state.workspaceDir, caseId + ".txt"), "utf8"),
        ).toBe("progress");
        if (caseId === "manual-success") {
          await page.screenshot({
            path: path.join(proof, "before-required-step.png"),
            animations: "disabled",
          });
          const popup = context.waitForEvent("page");
          await panel.getByRole("link", { name: "Open link", exact: true }).click();
          const manual = await popup;
          await manual.getByRole("button", { name: "Complete manual step" }).click();
          await manual.getByRole("heading", { name: "Manual step completed" }).waitFor();
          expect(state.effects).toBe(0); // Navigation/completion does not answer the pending question.
          await manual.close();
          await page.reload(); // Rejoin the same pending question, not another task or tool call.
          await panel.waitFor();
        } else if (caseId === "manual-in-panel") {
          expect(await panel.getByRole("link", { name: "Open link", exact: true }).count()).toBe(0);
          const manual = await context.newPage();
          await manual.goto(origin + "/manual?case=" + caseId);
          await manual.getByRole("button", { name: "Complete manual step" }).click();
          await manual.close();
        }
        if (caseId === "manual-cancelled") {
          await panel.getByRole("button", { name: "Skip", exact: true }).click();
        } else {
          await panel.getByRole("radio", { name: /^Ready to recheck/ }).click();
          await panel.getByRole("button", { name: "Submit", exact: true }).click();
        }
        const finalText =
          caseId === "manual-cancelled"
            ? "Required step stopped; dependent work was not resumed for " + caseId + "."
            : caseId === "manual-still-blocked"
              ? "The prerequisite is still unresolved for " +
                caseId +
                "; no dependent effect was performed."
              : "Original task continued after verification for " +
                caseId +
                "; recorded progress was not repeated.";
        await page.getByRole("paragraph").filter({ hasText: finalText }).waitFor();
        await page
          .getByRole("button", { name: "Stop", exact: true })
          .waitFor({ state: "detached" });
        expect(state.effects).toBe(
          caseId === "manual-success" || caseId === "manual-in-panel" ? 1 : 0,
        );
        expect(state.checks).toBe(caseId === "manual-cancelled" ? 1 : 2);
        expect(
          await readFile(path.join(instance.state.workspaceDir, caseId + ".txt"), "utf8"),
        ).toBe("progress");
        if (caseId === "manual-success") {
          await page.screenshot({
            path: path.join(proof, "after-verified-continuation.png"),
            animations: "disabled",
          });
        }
        await writeFile(
          path.join(proof, caseId + ".json"),
          JSON.stringify(
            {
              caseId,
              ...state,
              progressWrites: 1,
              originalSession: key,
              model:
                "Explicitly scripted local model; runtime and UI plumbing proof, not unscripted reasoning, native permission, browser arbitration, or live-account proof.",
            },
            null,
            2,
          ),
        );
      },
    );
  });
});
