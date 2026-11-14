import fs from "node:fs/promises";
import { text } from "node:stream/consumers";
import { fileURLToPath } from "node:url";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withServer } from "../../plugin-sdk/test-helpers/http-test-server.js";
import { resetCommandQueueStateForTest } from "../../process/command-queue.test-support.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { whenAdmittedWizardSessionSettled } from "./setup-admission.js";
import { answerWizard, callWizardNext, makeContext } from "./system-agent-setup.test-support.js";
import { systemAgentHandlers } from "./system-agent.js";
import type { RespondFn } from "./types.js";

it("reuses a protected Ollama connection without moving its credentials to a replacement endpoint", async () => {
  const requests: Array<{ path: string; authorization?: string; tenant?: string; route?: string }> =
    [];
  await withServer(
    (request, response) => {
      void (async () => {
        const path = request.url ?? "";
        requests.push({
          path,
          authorization: request.headers.authorization,
          tenant: request.headers["x-tenant"]?.toString(),
          route: request.headers["x-route"]?.toString(),
        });
        if (
          path.startsWith("/existing/") &&
          (request.headers.authorization !== "Bearer synthetic-ollama-access" ||
            request.headers["x-tenant"] !== "synthetic-tenant" ||
            request.headers["x-route"] !== "synthetic-request-route")
        ) {
          response.writeHead(401).end();
          return;
        }
        const body = await text(request);
        response.setHeader("content-type", "application/json");
        if (path.endsWith("/api/tags")) {
          response.end(JSON.stringify({ models: [{ name: "setup-tools:latest" }] }));
        } else if (path.endsWith("/api/show") && JSON.parse(body).model === "setup-tools:latest") {
          response.end(
            JSON.stringify({
              model_info: { "model.context_length": 32768 },
              capabilities: ["completion", "tools"],
            }),
          );
        } else {
          response.writeHead(404).end();
        }
      })().catch((error: unknown) => response.destroy(error instanceof Error ? error : undefined));
    },
    async (origin) => {
      await withOpenClawTestState(
        {
          label: "ollama-setup-reuse",
          env: {
            OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
            OPENCLAW_DEV_SOURCE_ROOT: fileURLToPath(new URL("../../../", import.meta.url)),
            OPENCLAW_BUNDLED_PLUGINS_DIR: fileURLToPath(
              new URL("../../../extensions", import.meta.url),
            ),
            OLLAMA_API_KEY: "synthetic-ambient-key-must-not-be-used",
            OLLAMA_REUSE_KEY: "synthetic-ollama-access",
            OLLAMA_REUSE_TENANT: "synthetic-tenant",
          },
        },
        async (state) => {
          const original = {
            baseUrl: origin + "/existing/v1/",
            api: "ollama" as const,
            apiKey: { source: "env", provider: "default", id: "OLLAMA_REUSE_KEY" } as const,
            headers: {
              "X-Tenant": {
                source: "env",
                provider: "default",
                id: "OLLAMA_REUSE_TENANT",
              } as const,
            },
            request: {
              allowPrivateNetwork: true,
              headers: { "X-Route": "synthetic-request-route" },
            },
            timeoutSeconds: 37,
            params: { temperature: 0.25 },
            models: [],
          };
          const config: OpenClawConfig = {
            agents: {
              defaults: { workspace: state.workspaceDir, model: { primary: "other/unchanged" } },
            },
            models: { providers: { ollama: original } },
            plugins: { allow: ["ollama"], entries: { ollama: { enabled: true } } },
          };
          for (const scenario of ["reuse", "replacement", "revoked"]) {
            const changed = scenario === "replacement";
            requests.length = 0;
            await state.writeConfig(config);
            const { context, wizardSessions } = makeContext();
            const sessionId = "ollama-" + scenario;
            const params = { sessionId, authChoice: "ollama" };
            let current = true;
            const respond = vi.fn<RespondFn>();
            await expectDefined(
              systemAgentHandlers["openclaw.setup.prepare.start"],
              "prepare",
            )({
              req: { type: "req", id: sessionId, method: "openclaw.setup.prepare.start", params },
              params,
              context,
              client: null,
              isWebchatConnect: () => false,
              hasCurrentClientAuthority: () => current,
              respond,
            });
            expect(respond.mock.calls[0]?.[0]).toBe(true);
            const session = expectDefined(wizardSessions.get(sessionId), "Ollama setup wizard");
            try {
              let frame = await callWizardNext(context, { sessionId });
              expect(frame.step).toMatchObject({ type: "select", message: "Ollama mode" });
              frame = await answerWizard(context, sessionId, frame, "local-only");
              expect(frame.step).toMatchObject({ type: "text", message: "Ollama base URL" });
              const initialValue = frame.step?.initialValue;
              // Keep the broken baseline inside the synthetic endpoint, even without its saved prefill.
              const selectedUrl = changed
                ? origin + "/replacement"
                : initialValue || original.baseUrl;
              if (scenario === "revoked") {
                current = false;
                expect(session.signal.aborted).toBe(false);
              }
              frame = await answerWizard(context, sessionId, frame, selectedUrl);
              while (!frame.done) {
                const step = expectDefined(frame.step, "Ollama setup step");
                expect(["note", "confirm"]).toContain(step.type);
                frame = await answerWizard(
                  context,
                  sessionId,
                  frame,
                  step.type === "confirm" ? false : null,
                );
              }
              if (scenario === "revoked") {
                expect(frame).toMatchObject({ done: true, status: "error" });
                expect(requests).toEqual([]);
                expect(JSON.parse(await fs.readFile(state.configPath, "utf8"))).toEqual(config);
                continue;
              }
              expect(frame, JSON.stringify(requests)).toMatchObject({
                done: true,
                status: "done",
                preparedModelRef: "ollama/setup-tools:latest",
              });
              expect(initialValue).toBe(origin + "/existing");
              const written: OpenClawConfig = JSON.parse(
                await fs.readFile(state.configPath, "utf8"),
              );
              expect(written.agents?.defaults?.model).toEqual({ primary: "other/unchanged" });
              expect(written.auth).toBeUndefined();
              const provider = expectDefined(
                written.models?.providers?.ollama,
                "saved Ollama connection",
              );
              expect(provider.baseUrl).toBe(origin + (changed ? "/replacement" : "/existing"));
              expect(provider.timeoutSeconds).toBe(37);
              expect(provider.params).toEqual({ temperature: 0.25 });
              expect(requests.map((request) => request.path)).toEqual([
                (changed ? "/replacement" : "/existing") + "/api/tags",
                (changed ? "/replacement" : "/existing") + "/api/show",
              ]);
              if (changed) {
                expect(provider.apiKey).toBe("ollama-local");
                expect(provider.headers).toBeUndefined();
                expect(provider.request).toBeUndefined();
                expect(
                  requests.every(
                    ({ authorization, tenant, route }) => !authorization && !tenant && !route,
                  ),
                ).toBe(true);
              } else {
                expect(provider.apiKey).toEqual(original.apiKey);
                expect(provider.headers).toEqual(original.headers);
                expect(provider.request).toEqual(original.request);
                expect(
                  requests.every(
                    ({ authorization, tenant, route }) =>
                      authorization === "Bearer synthetic-ollama-access" &&
                      tenant === "synthetic-tenant" &&
                      route === "synthetic-request-route",
                  ),
                ).toBe(true);
              }
            } finally {
              session.cancel();
              await whenAdmittedWizardSessionSettled(session);
              resetCommandQueueStateForTest();
            }
          }
        },
      );
    },
  );
});
