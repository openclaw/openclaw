// Opt-in qualification: installs pinned LCM in disposable state; never downloads in ordinary PR tests.
// Shared-owner continuity only. Person isolation is covered by knowledge-person-project.e2e.test.ts.
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { GATEWAY_OWNER_PROFILE_ID } from "../packages/gateway-protocol/src/schema/users.js";
import { writeToolCall } from "../src/gateway/gateway-provider-fixture.test-support.js";
import { disconnectGatewayClient } from "../src/gateway/test-helpers.e2e.js";
import { assertGatewayAgentsAdmitted } from "./helpers/gateway-agent-admission.js";
import { connectProofClient, readRequestText } from "./helpers/gateway-integration-fixtures.js";
import {
  createOpenAiResponsesModelConfig,
  startOpenAiResponsesModelServer,
} from "./helpers/openai-responses-model-fixture.js";
import { writeOpenAiResponsesText } from "./helpers/openai-responses-sse.js";
import { createOpenClawTestInstance } from "./helpers/openclaw-test-instance.js";
import { awaitGateBeforeSettlement, withinTest } from "./helpers/promise.js";
import { runQaGatewayFixture } from "./helpers/qa-gateway-cleanup.js";

type FixtureInput = { type?: string; output?: string };
type Plan = {
  id: string;
  name: string;
  args: Record<string, unknown>;
  issued?: boolean;
  unavailable?: boolean;
  holdAfterOutput?: () => void;
  output?: string;
};
function resultJson(text: string | undefined): Record<string, unknown> {
  expect(text, "a real tool result must reach the provider fixture").toBeTypeOf("string");
  const value = JSON.parse(text!);
  if (Array.isArray(value.content)) {
    return JSON.parse(
      value.content
        .filter((entry: { type?: string }) => entry.type === "text")
        .map((entry: { text: string }) => entry.text)
        .join(""),
    );
  }
  return value;
}

// Uses the existing opt-in E2E owner, like doctor-lease-contention.e2e.test.ts.
// Real Gateway/plugin/compaction/disk boundaries; deterministic model I/O, not live inference.
it.runIf(process.env.OPENCLAW_KNOWLEDGE_LOSSLESS_CONTINUITY_PROOF === "1")(
  "preserves Knowledge evidence and LCM history across restart and a lost publication reply",
  { timeout: 300_000 },
  async ({ signal }) => {
    let plan: Plan | undefined;
    let requests = 0;
    let unavailableRequests = 0;
    const model = await startOpenAiResponsesModelServer({
      modelId: "continuity-proof",
      bindError: "continuity fixture did not bind",
      async onRequest(request, response) {
        const body = JSON.parse(await readRequestText(request)) as {
          input?: FixtureInput[];
          tools?: Array<{ name?: string }>;
        };
        requests++;
        if (plan?.unavailable) {
          unavailableRequests++;
          response.writeHead(503, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              error: { message: "Synthetic provider unavailable", type: "server_error" },
            }),
          );
          return;
        }
        const output = body.input?.findLast((entry) => entry.type === "function_call_output");
        if (plan && body.tools?.length && !plan.issued) {
          plan.issued = true;
          expect(body.tools.map((tool) => tool.name)).toContain(plan.name);
          writeToolCall(response, plan.name, plan.args);
          return;
        }
        if (plan && output) {
          plan.output = output.output;
          if (plan.holdAfterOutput) {
            plan.holdAfterOutput();
            return;
          }
        }
        writeOpenAiResponsesText(response, {
          text: "Fixture operation complete.",
          messageId: randomUUID(),
          responseId: randomUUID(),
        });
      },
    });
    const provider = createOpenAiResponsesModelConfig({
      baseUrl: model.baseUrl,
      providerId: "continuity-proof",
      modelId: "continuity-proof",
      reasoning: false,
      toolProfile: "minimal",
    });
    const instance = await createOpenClawTestInstance({
      name: "knowledge-lossless-continuity",
      signal,
      env: {
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
        OPENCLAW_SKIP_PROVIDERS: undefined,
        OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
      },
      config: {
        ...provider,
        plugins: {
          allow: ["knowledge", "openai"],
          slots: { memory: "knowledge" },
          entries: {
            knowledge: {
              enabled: true,
              config: {
                maintenance: { enabled: false },
                stores: { project: { agents: ["main", "research"] } },
              },
            },
            "lossless-claw": { enabled: true, config: { freshTailCount: 2, leafMinFanout: 2 } },
          },
        },
        agents: {
          ownership: "explicit",
          defaults: {
            model: { primary: "continuity-proof/continuity-proof" },
            modelPolicy: { allow: ["continuity-proof/*"] },
            skipBootstrap: true,
            skills: [],
          },
          entries: { main: {}, research: {} },
        },
        tools: {
          allow: ["knowledge_save_page", "knowledge_record", "knowledge_records", "lcm_grep"],
          codeMode: false,
          toolSearch: false,
        },
        gateway: { mode: "local" },
      },
    });
    let client: Awaited<ReturnType<typeof connectProofClient>> | undefined;
    const runTool = async (sessionKey: string, name: string, args: Record<string, unknown>) => {
      plan = { id: "proof_" + randomUUID().replaceAll("-", ""), name, args };
      const result = await client!.request<{ status: string }>(
        "agent",
        {
          agentId: sessionKey.split(":")[1],
          sessionKey,
          message:
            (name === "knowledge_save_page" ? "HISTORY_CANARY=SEABRIDGE; " : "") +
            "Execute the requested fixture operation " +
            plan.id,
          deliver: false,
          idempotencyKey: randomUUID(),
        },
        { expectFinal: true, timeoutMs: 90_000 },
      );
      expect(result.status, instance.logs()).toBe("ok");
      expect(plan.issued, instance.logs()).toBe(true);
      const output = name === "lcm_grep" ? { historyText: plan.output } : resultJson(plan.output);
      plan = undefined;
      return output;
    };
    await runQaGatewayFixture(
      async () => {
        const installed = await instance.cli(
          [
            "plugins",
            "install",
            "npm:@martian-engineering/lossless-claw@1.2.0",
            "--pin",
            "--force",
            "--accept-capabilities",
          ],
          { timeoutMs: 120_000 },
        );
        expect(installed.code, installed.stderr + installed.stdout).toBe(0);
        const selected = await instance.cli([
          "config",
          "set",
          "plugins.slots.contextEngine",
          "lossless-claw",
        ]);
        expect(selected.code, selected.stderr + selected.stdout).toBe(0);
        await instance.startGateway();
        client = await connectProofClient(instance, {
          scopes: ["operator.admin", "operator.read", "operator.write"],
        });
        await assertGatewayAgentsAdmitted(client, ["main", "research"]);
        for (const agentId of ["main", "research"]) {
          await client.request("sessions.create", {
            key: "agent:" + agentId + ":continuity",
            agentId,
            cwd: instance.state.workspaceDir,
          });
          const snapshot = await client.request<{ result: { revision: string } }>(
            "plugins.sessionAction",
            { pluginId: "knowledge", actionId: "person_grants", payload: {} },
          );
          const granted = await client.request<{ result: { outcome: string } }>(
            "plugins.sessionAction",
            {
              pluginId: "knowledge",
              actionId: "person_grant",
              payload: {
                expectedRevision: snapshot.result.revision,
                profileId: GATEWAY_OWNER_PROFILE_ID,
                agent: agentId,
                space: "harbor",
                access: "read-write",
              },
            },
          );
          expect(granted.result.outcome).toBe("applied");
        }
        const source = "SYNTHETIC SOURCE: Harbor project selected the amber launch on Friday.";
        const saved = await runTool("agent:main:continuity", "knowledge_save_page", {
          requestId: randomUUID(),
          title: "Harbor launch",
          type: "note",
          body: "Harbor selected the amber launch on Friday.",
          source: { text: source, attribution: "Synthetic continuity fixture" },
        });
        expect(saved).toMatchObject({
          state: "published",
          revision: 1,
          git: { state: "committed" },
        });
        expect(saved.id).toBeTypeOf("string");
        const recordArgs = { id: saved.id, metadataView: "full", includeEvidence: true };
        const before = await runTool("agent:main:continuity", "knowledge_record", recordArgs);
        expect(before.record).toMatchObject({
          id: saved.id,
          revision: saved.revision,
          hash: saved.hash,
        });
        expect(JSON.stringify(before)).toContain(source);
        // Public context-engine compaction, never a private LCM database query or seeded summary.
        const historyCutoff = new Date().toISOString();
        const compact = await client.request<{
          compacted: boolean;
          result: { tokensBefore: number; tokensAfter: number };
        }>(
          "sessions.compact",
          { key: "agent:main:continuity", agentId: "main" },
          { timeoutMs: 90_000 },
        );
        expect(compact.compacted).toBe(true);
        expect(compact.result.tokensAfter).toBeLessThan(compact.result.tokensBefore);
        await disconnectGatewayClient(client);
        client = undefined;
        const oldPid = instance.child?.pid;
        expect(oldPid).toBeTypeOf("number");
        await instance.stopGateway();
        await instance.startGateway();
        expect(instance.child?.pid).toBeTypeOf("number");
        expect(instance.child?.pid).not.toBe(oldPid);
        client = await connectProofClient(instance, {
          scopes: ["operator.admin", "operator.read", "operator.write"],
        });
        await assertGatewayAgentsAdmitted(client, ["main", "research"]);
        const history = await runTool("agent:main:continuity", "lcm_grep", {
          pattern: "HISTORY_CANARY=SEABRIDGE",
          scope: "messages",
          before: historyCutoff,
        });
        expect(String(history.historyText)).toContain("**Total matches:** 1");
        expect(
          String(history.historyText)
            .split("\n")
            .some(
              (line) =>
                line.startsWith("- [conv=") &&
                line.includes("] (user,") &&
                line.includes(": HISTORY_CANARY=SEABRIDGE"),
            ),
        ).toBe(true);
        const recalled = await runTool("agent:research:continuity", "knowledge_record", recordArgs);
        expect(recalled.record).toMatchObject({
          id: saved.id,
          revision: saved.revision,
          hash: saved.hash,
        });
        expect(JSON.stringify(recalled)).toContain(source);
        expect(before.evidence).toBeInstanceOf(Array);
        expect(before.evidence).toEqual(
          expect.arrayContaining([expect.objectContaining({ verified: true })]),
        );
        expect(recalled.evidence).toEqual(before.evidence);
        expect(requests).toBeGreaterThanOrEqual(6);
        let savedOutputSeen!: () => void;
        const savedOutput = new Promise<void>((resolve) => {
          savedOutputSeen = resolve;
        });
        const interruptedArgs = {
          requestId: randomUUID(),
          title: "Interrupted save proof",
          type: "note",
          body: "Accepted before the Gateway process stopped.",
          source: {
            text: "Synthetic interrupted publication evidence.",
            attribution: "Synthetic fixture",
          },
        };
        plan = {
          id: "interrupted_" + randomUUID(),
          name: "knowledge_save_page",
          args: interruptedArgs,
          holdAfterOutput: savedOutputSeen,
        };
        const lostCall = client
          .request(
            "agent",
            {
              agentId: "main",
              sessionKey: "agent:main:continuity",
              message: "Execute the interrupted-save fixture step.",
              deliver: false,
              idempotencyKey: randomUUID(),
            },
            { expectFinal: true, timeoutMs: 90_000 },
          )
          .then(
            (response) => ({ response }),
            (error: unknown) => ({ error: String(error) }),
          );
        await withinTest(
          awaitGateBeforeSettlement(
            savedOutput,
            lostCall,
            "Interrupted save settled before its publication output was observed.",
          ),
          signal,
        );
        const accepted = resultJson(plan.output);
        expect(accepted.state).toBe("published");
        expect(accepted.git).toMatchObject({ state: "committed" });
        const interruptedPid = instance.child?.pid;
        await instance.crashGateway();
        await disconnectGatewayClient(client);
        client = undefined;
        await instance.stopGateway();
        const lostReply = await lostCall;
        expect(lostReply).toMatchObject({ error: expect.stringContaining("1006") });
        await instance.startGateway();
        expect(instance.child?.pid).not.toBe(interruptedPid);
        client = await connectProofClient(instance, {
          scopes: ["operator.admin", "operator.read", "operator.write"],
        });
        await assertGatewayAgentsAdmitted(client, ["main", "research"]);
        const retried = await runTool(
          "agent:main:continuity",
          "knowledge_save_page",
          interruptedArgs,
        );
        expect(retried.git).toEqual(accepted.git);
        expect([retried.id, retried.revision, retried.hash]).toEqual([
          accepted.id,
          accepted.revision,
          accepted.hash,
        ]);
        const listed = await runTool("agent:main:continuity", "knowledge_records", {});
        expect(listed.total).toBe(2);
        plan = {
          id: "unavailable_" + randomUUID(),
          name: "knowledge_save_page",
          args: {},
          unavailable: true,
        };
        const unavailable = await client
          .request(
            "agent",
            {
              agentId: "main",
              sessionKey: "agent:main:continuity",
              message: "Provider-unavailable outcome probe.",
              deliver: false,
              idempotencyKey: randomUUID(),
            },
            { expectFinal: true, timeoutMs: 30_000 },
          )
          .then(
            (response) => ({ response }),
            (error: unknown) => ({ error: String(error) }),
          );
        expect(unavailableRequests).toBeGreaterThan(0);
        expect(plan.issued).not.toBe(true);
        // Records the current client deadline outcome, not fail-fast provider recovery.
        expect(unavailable).toMatchObject({
          error: expect.stringContaining("GatewayClientRequestTimeoutError"),
        });
        plan = undefined;
        console.info("Knowledge/LCM qualification", {
          plugin: "@martian-engineering/lossless-claw@1.2.0",
          compacted: compact.compacted,
          tokensBefore: compact.result.tokensBefore,
          tokensAfter: compact.result.tokensAfter,
          coldGatewayRestart: instance.child?.pid !== oldPid,
          historyCanaryRecovered: true,
          evidencePreserved: true,
          saveGitCommitted: true,
          replaySameGitCommit: true,
          recordsAfterReplay: listed.total,
          interruption: "after publication, before final reply",
          unavailableRequests,
          outageOutcome: "CLIENT_TIMEOUT at 30s; no tool call",
        });
      },
      async () => {
        if (client) {
          await disconnectGatewayClient(client);
        }
      },
      () => instance.cleanup(),
      () => model.close(),
    );
  },
);
